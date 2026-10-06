"""Adaptador entre la pestaña del navegador y el MotorWeb de Axio.

Corre dentro de Pyodide, en un Web Worker (ver estatico/trabajador.js). Hace lo mismo que
web/app.py en el servidor -- recibe /api/... y devuelve la respuesta -- pero sin Flask,
sin usuarios y sin red: el "servidor" es esta misma pestaña.

Con sesión de Google, cada descarga lleva el token de la persona (ver fijar_token): las
hojas se leen con SUS permisos y pueden ser privadas.

Tres diferencias con el servidor, todas por el entorno:
  - No hay hilos en el navegador: la carga de datos se hace de una vez, al recibir el
    config, en vez de en un hilo aparte.
  - urllib no tiene sockets aquí: urlopen se cambia por una petición del navegador
    (XMLHttpRequest síncrono, permitido dentro de un Worker). Google Sheets responde con
    CORS abierto, así que el navegador puede bajar las hojas directamente.
  - No hay cierres locales: una página web no puede leer carpetas del equipo.

Todo vive en la memoria de la pestaña (/datos es un sistema de archivos en RAM). Al
cerrarla o recargarla no queda nada.
"""

import io
import json
import os
import re
import sys
import email.message
import urllib.error
import urllib.request
from urllib.parse import parse_qs, unquote, urlsplit

CARPETA_DATOS = os.environ.setdefault('AXIO_CARPETA_DATOS', '/datos')
EN_NAVEGADOR = sys.platform == 'emscripten'
USUARIO = 'demo'
LARGO_MAXIMO_BUSQUEDA = 200   # el mismo límite que web/app.py
TIPO_JSON = 'application/json'
TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


# ------------------------------------------------------------------ red
class _Respuesta:
    """Lo mínimo de http.client.HTTPResponse que usan pandas y axio/nucleo/utils."""

    def __init__(self, url, estado, datos, tipo):
        self.url = url
        self.status = estado
        self._buffer = io.BytesIO(datos)
        self.headers = email.message.Message()
        if tipo:
            self.headers['Content-Type'] = tipo

    def read(self, n=-1):
        return self._buffer.read(n)

    def getcode(self):
        return self.status

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


# Token de Google de quien inició sesión (ver estatico/puente.js). Con él, cada descarga a
# Google va con los permisos de esa persona y las hojas pueden ser privadas. Vacío: las
# descargas son anónimas y solo funcionan con hojas compartidas por enlace.
_token_google = ''
_HOSTS_GOOGLE = ('docs.google.com', 'sheets.googleapis.com', 'www.googleapis.com')


def fijar_token(token):
    global _token_google
    _token_google = token or ''


def _urlopen_navegador(url, data=None, timeout=None, **_):
    import js
    if isinstance(url, urllib.request.Request):
        url = url.full_url
    xhr = js.XMLHttpRequest.new()
    xhr.open('GET', url, False)
    xhr.responseType = 'arraybuffer'
    if _token_google and urlsplit(url).hostname in _HOSTS_GOOGLE:
        xhr.setRequestHeader('Authorization', 'Bearer ' + _token_google)
    try:
        xhr.send()
    except Exception as e:
        raise urllib.error.URLError(f"sin conexión con {urlsplit(url).netloc} ({e})")
    if xhr.status == 0:
        raise urllib.error.URLError(f"sin conexión con {urlsplit(url).netloc}")
    if xhr.status in (401, 403, 404) and 'google' in (urlsplit(url).hostname or ''):
        motivo = ("tu cuenta de Google no tiene permiso para ver esta hoja; pide acceso a quien la administra"
                  if _token_google else
                  "la hoja no está compartida por enlace; inicia sesión con Google o pide acceso")
        raise urllib.error.HTTPError(url, xhr.status, motivo, None, None)
    if xhr.status >= 400:
        raise urllib.error.HTTPError(url, xhr.status, f"HTTP {xhr.status}", None, None)
    datos = bytes(js.Uint8Array.new(xhr.response).to_py())
    return _Respuesta(xhr.responseURL or url, xhr.status, datos, xhr.getResponseHeader('Content-Type'))


if EN_NAVEGADOR:
    # Antes de importar axio: pandas y axio/nucleo/utils llaman a urllib.request.urlopen
    # por atributo, así que ven este reemplazo.
    urllib.request.urlopen = _urlopen_navegador


def _avisar(mensaje):
    if EN_NAVEGADOR and mensaje:
        import js
        js.postMessage(js.JSON.parse(json.dumps({'tipo': 'progreso', 'mensaje': mensaje})))


# ------------------------------------------------------------------ motor
from axio.nucleo.rutas import CONFIG_FILE   # noqa: E402  (después de fijar la carpeta)
from web.servicio import MotorWeb           # noqa: E402


class MotorNavegador(MotorWeb):
    """El MotorWeb del servidor, con el aviso de progreso conectado a la pestaña."""

    @property
    def mensaje_carga(self):
        return self._mensaje_carga

    @mensaje_carga.setter
    def mensaje_carga(self, valor):
        self._mensaje_carga = valor
        _avisar(valor)

    def iniciar_carga(self, forzar=False):
        # Sin hilos en el navegador. La pestaña nunca llega aquí porque solo busca con
        # los datos ya cargados; si llegara, que no intente arrancar un hilo.
        return False


_motor = None


def configurar(texto_config):
    """Recibe el contenido de config_axio.json, lo deja en /datos y descarga todo.
    Devuelve el estado (JSON) para pintar las fuentes."""
    global _motor
    config = json.loads(texto_config)
    if not isinstance(config, dict):
        raise ValueError("El archivo no tiene el formato de config_axio.json.")
    config['buscador_incluir_archivos_locales'] = False
    os.makedirs(CARPETA_DATOS, exist_ok=True)
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, ensure_ascii=False)
    _motor = MotorNavegador()
    _motor.cargar_ahora(forzar=True)
    return json.dumps(_motor.estado())


def recargar():
    """El «Refrescar datos» de la barra: vuelve a bajar todo con el mismo config."""
    _motor.cargar_ahora(forzar=True)
    return json.dumps(_motor.estado())


def _json(datos, estado=200):
    return estado, TIPO_JSON, json.dumps(datos, ensure_ascii=False).encode('utf-8')


def atender(url):
    """Responde una llamada GET de app.js igual que web/app.py.
    Devuelve (código HTTP, tipo de contenido, cuerpo en bytes)."""
    if _motor is None:
        return _json({'error': "Primero carga el archivo config_axio.json."}, 503)
    partes = urlsplit(url)
    ruta = [unquote(p) for p in partes.path.strip('/').split('/')]

    if ruta == ['api', 'estado']:
        return _json(_motor.estado())

    if ruta == ['api', 'buscar']:
        termino = re.sub(r'\s+', ' ', parse_qs(partes.query).get('q', [''])[0]).strip()
        if not termino:
            return _json({'error': "Escribe algo para buscar."}, 400)
        if len(termino) > LARGO_MAXIMO_BUSQUEDA:
            return _json({'error': f"La búsqueda no puede pasar de {LARGO_MAXIMO_BUSQUEDA} caracteres."}, 400)
        resultado = _motor.buscar(termino, USUARIO)
        if resultado is None:
            return _json({'cargando': True, 'mensaje': "Cargando los datos..."}, 202)
        return _json(resultado)

    if len(ruta) == 4 and ruta[:2] == ['api', 'detalle'] and ruta[3].isdigit():
        detalle = _motor.detalle(ruta[2], int(ruta[3]), USUARIO)
        if detalle is None:
            return _json({'error': "Ese resultado ya no está disponible. Vuelve a buscar."}, 404)
        return _json(detalle)

    if len(ruta) == 3 and ruta[:2] == ['api', 'exportar']:
        exportado = _motor.exportar(ruta[2], USUARIO)
        if exportado is None:
            return _json({'error': "Esa búsqueda ya no está disponible. Vuelve a buscar."}, 404)
        return 200, TIPO_XLSX, exportado[0]

    return _json({'error': "No encontrado."}, 404)
