"""Estado compartido del buscador web: Matriz_Nube, líneas de crédito y búsquedas recientes.

En el escritorio cada persona tiene su propia copia de la Matriz_Nube en memoria. En el
servidor hay UNA sola, compartida por todos: se descarga una vez y todas las búsquedas la
leen. Por eso aquí hay candados y en la versión de escritorio no.

Este módulo no sabe nada de HTTP. Recibe textos y devuelve diccionarios listos para JSON,
así que se puede probar sin levantar el servidor.
"""

from collections import OrderedDict
from datetime import datetime
import io
import json
import re
import secrets
import threading

import numpy as np
import pandas as pd

from axio.dominio.buscador import (
    CLAVES_LINEAS_CON_INFO_EXTRA, DIRECTORIO_CARTERA_DEFECTO, LIMITE_FILAS_DIBUJADAS,
    _clave_orden_valor, _columnas_unicas, _formatear_valor_celda, _normalizar_para_busqueda,
    asegurar_columna_cedula, aviso_columna_cedula,
    buscar_comprobante_global, buscar_encargado_cartera, clasificar_estado_pago,
    descargar_base_global, descargar_directorio_whatsapp, descargar_linea_credito,
    generar_excel_resultados_busqueda,
    obtener_cedula_de_fila, obtener_distrito_de_fila, sugerir_termino_parecido,
)
from axio.nucleo.cache_nube import (
    cargar_lineas_credito, cargar_matriz_nube, guardar_lineas_credito, guardar_matriz_nube,
    limpiar_cache_disco,
)
from axio.nucleo.config import cargar_config
from axio.nucleo.registro import logger
from axio.nucleo.utils import limpiar_cedula

# Cuántas búsquedas se recuerdan para abrir su detalle o exportarlas. Cada una guarda sus
# resultados completos; cien alcanza de sobra para una oficina y acota la memoria.
MAX_BUSQUEDAS_GUARDADAS = 100

# Tabla completa de los Extractos: cuántas filas se piden de una vez (la página las va
# trayendo a medida que se desplaza) y cuántos valores distintos muestra el filtro de una
# columna (con más, se escribe para encontrar el que se busca).
MAX_FILAS_POR_PEDIDO = 500
MAX_VALORES_FILTRO = 500
# El filtro «Estado» no es una columna de la hoja: es el color de la fila.
COLUMNA_ESTADO = 'estado'

# En la web la Matriz_Nube se presenta como «Extractos», que es como la llama la gente.
# Solo cambia lo que se ve: por dentro (caché, escritorio, Excel) sigue siendo Matriz_Nube.
NOMBRES_VISIBLES_FUENTE = {'Matriz_Nube': 'Extractos'}


def _nombre_visible(fuente):
    return NOMBRES_VISIBLES_FUENTE.get(fuente, fuente)


def _valor_de_campo(columna, valor):
    """Como _formatear_valor_celda, salvo las cédulas: van sin separador de miles para
    poder copiarlas tal cual (12345678, no 12,345,678)."""
    if 'CEDULA' in columna.upper() or 'CÉDULA' in columna.upper():
        if isinstance(valor, float) and valor == int(valor):
            valor = int(valor)
        if isinstance(valor, int):
            return str(valor)
    return _formatear_valor_celda(valor)


def _cedula_con_puntos(cedula_limpia):
    return f"{int(cedula_limpia):,}".replace(',', '.') if cedula_limpia.isdigit() else cedula_limpia


def _hora_iso(momento):
    return momento.strftime("%Y-%m-%d %H:%M:%S") if momento else None


def _nativo(valor):
    """Un número de numpy como número de Python: así se formatea igual que en la búsqueda
    (1,234 y no 1234)."""
    if isinstance(valor, np.datetime64):
        return pd.Timestamp(valor)
    return valor.item() if isinstance(valor, np.generic) else valor


def _orden_texto(texto):
    """Orden de un valor ya formateado ('05/10/2026', '1,250,000', 'BANCOLOMBIA'): fechas
    por fecha, cifras por valor, después el texto y las vacías al final."""
    m = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', texto)
    if m:
        return (0, int(m.group(3) + m.group(2) + m.group(1)), '')
    if re.fullmatch(r'-?[\d,]+(\.\d+)?', texto):
        return (1, float(texto.replace(',', '')), '')
    return (2 if texto else 3, 0, texto.upper())


def _enlace_seguro(url):
    """Solo se devuelven enlaces http(s). Un 'javascript:' escrito en una celda de la hoja
    terminaría ejecutándose en el navegador de quien haga clic."""
    texto = str(url or "").strip()
    return texto if texto.lower().startswith(("http://", "https://")) else None


class MotorWeb:
    """Un único motor por proceso. Ver obtener_motor()."""

    def __init__(self):
        self._candado_carga = threading.Lock()
        self._candado_indice = threading.Lock()
        self._candado_busquedas = threading.Lock()

        self.config = cargar_config()
        self.df_global = None
        self.hora_matriz = None
        self.error_matriz = None
        self.aviso_matriz = None
        self.rosters = {}
        self.hora_lineas = None
        self.errores_lineas = {}
        self.whatsapp = {}
        self.error_whatsapp = None

        self.listo = False
        self.cargando = False
        self.mensaje_carga = ""
        # Primera carga a medias: los Extractos ya se pueden buscar, pero las líneas de
        # crédito y WhatsApp siguen bajando (ver _pasos_carga).
        self.parcial = False

        self.cache_normalizado = {}
        self.cache_archivos = {}
        self._busquedas = OrderedDict()
        self._candado_tabla = threading.Lock()
        self._cache_tabla = None

    # ------------------------------------------------------------------ carga de datos
    def iniciar_carga(self, forzar=False):
        """Lanza la carga en un hilo aparte y vuelve de inmediato. Si ya hay una en curso,
        no lanza otra: dos descargas simultáneas de la misma hoja no sirven de nada."""
        with self._candado_carga:
            if self.cargando:
                return False
            self.cargando = True
        threading.Thread(target=self._cargar, args=(forzar,), daemon=True,
                         name="axio-carga").start()
        return True

    def cargar_ahora(self, forzar=False):
        """Versión bloqueante de iniciar_carga. La usan las pruebas y el arranque."""
        with self._candado_carga:
            if self.cargando:
                return False
            self.cargando = True
        self._cargar(forzar)
        return True

    def _cargar(self, forzar):
        for _ in self._pasos_carga(forzar):
            pass

    def _pasos_carga(self, forzar):
        """La carga completa, como generador: se detiene (yield) después de los Extractos y
        después de cada línea de crédito. En el servidor se recorre de corrido en su hilo; la
        versión de navegador, que tiene un solo hilo, atiende búsquedas entre un paso y otro.

        En la PRIMERA carga, los Extractos se publican apenas están (self.parcial): se puede
        buscar en ellos mientras bajan las líneas. En un «Refrescar», todo se reemplaza de una
        vez al final: mientras tanto se sigue buscando en la copia anterior completa, nunca
        en una mitad nueva."""
        try:
            # La configuración se relee en cada carga: así, editar config_axio.json en el
            # servidor y darle a "Refrescar" basta, sin reiniciar el servicio.
            config = cargar_config()
            if forzar:
                limpiar_cache_disco()

            df, hora, error = self._cargar_matriz(config)
            aviso = None
            if df is not None:
                df = asegurar_columna_cedula(df, config.get('col_cedula', 'Cedula'))
                aviso = aviso_columna_cedula(df)
            if not self.listo:
                self.config = config
                self.df_global, self.hora_matriz, self.error_matriz = df, hora, error
                self.aviso_matriz = aviso
                self.cache_normalizado = {}
                self.parcial = True
                self.listo = True
            yield 'extractos'

            rosters, hora_lineas, errores = yield from self._cargar_lineas(config)
            whatsapp, error_whatsapp = self._cargar_whatsapp(config)

            self.config = config
            self.df_global, self.hora_matriz, self.error_matriz = df, hora, error
            self.aviso_matriz = aviso
            self.rosters, self.hora_lineas, self.errores_lineas = rosters, hora_lineas, errores
            self.whatsapp, self.error_whatsapp = whatsapp, error_whatsapp
            self.cache_normalizado = {}
            self.listo = True
        except Exception as e:
            logger.exception("Fallo cargando los datos del buscador web")
            self.error_matriz = str(e)
            self.listo = True
        finally:
            self.parcial = False
            self.mensaje_carga = ""
            self.cargando = False

    def _cargar_matriz(self, config):
        url = config.get('url_base_global', '')
        if not url:
            return None, None, None
        df, hora = cargar_matriz_nube(url)
        if df is not None:
            return df, hora, None
        try:
            self.mensaje_carga = "Descargando Matriz_Nube..."
            df = descargar_base_global(url, config)
            guardar_matriz_nube(df, url)
            return df, datetime.now(), None
        except Exception as e:
            logger.exception("No se pudo descargar Matriz_Nube (buscador web)")
            return None, None, str(e)

    def _cargar_lineas(self, config):
        """Generador (se usa con yield from): un paso por línea. Devuelve
        (rosters, hora, errores)."""
        lineas = config.get('lineas_credito', [])
        rosters, hora = cargar_lineas_credito(lineas)
        if rosters is not None:
            return rosters, hora, {}
        rosters, errores = {}, {}
        for linea in lineas:
            if not str(linea.get('url', '')).strip():
                continue
            self.mensaje_carga = f"Descargando línea de crédito: {linea.get('nombre')}..."
            try:
                rosters[linea['clave']] = descargar_linea_credito(linea['url'], clave=linea['clave'])
            except Exception as e:
                logger.exception(f"No se pudo cargar la línea de crédito '{linea.get('nombre')}'")
                errores[linea.get('nombre', linea.get('clave'))] = str(e)
            yield linea['clave']
        guardar_lineas_credito(rosters, lineas)
        return rosters, datetime.now(), errores

    def _cargar_whatsapp(self, config):
        """La hoja es chica: se baja en cada carga, sin caché en disco."""
        url = str(config.get('url_whatsapp', '')).strip()
        if not url:
            return {}, None
        self.mensaje_carga = "Descargando la hoja de WhatsApp..."
        try:
            return descargar_directorio_whatsapp(url), None
        except Exception as e:
            logger.exception("No se pudo cargar la hoja de WhatsApp")
            return {}, str(e)

    def _enlace_whatsapp(self, cedula_limpia):
        contacto = self.whatsapp.get(cedula_limpia) if cedula_limpia else None
        return f"https://wa.me/{contacto['celular']}" if contacto else None

    # ------------------------------------------------------------------ estado
    def estado(self):
        carpeta = self._carpeta_cierres()
        hay_lineas = any(str(l.get('url', '')).strip() for l in self.config.get('lineas_credito', []))
        return {
            'listo': self.listo,
            'cargando': self.cargando,
            'parcial': self.parcial,
            'mensaje_carga': self.mensaje_carga,
            'matriz': {
                'configurada': bool(self.config.get('url_base_global')),
                'filas': int(len(self.df_global)) if self.df_global is not None else 0,
                'hora': _hora_iso(self.hora_matriz),
                'error': self.error_matriz,
                'aviso': self.aviso_matriz,
            },
            'lineas': {
                'configuradas': hay_lineas,
                'cargadas': sorted(self.rosters.keys()),
                'hora': _hora_iso(self.hora_lineas),
                'errores': self.errores_lineas,
            },
            'whatsapp': {
                'configurado': bool(str(self.config.get('url_whatsapp', '')).strip()),
                'contactos': len(self.whatsapp),
                'error': self.error_whatsapp,
            },
            'cierres_locales': bool(carpeta),
            'fuentes': self._fuentes(),
        }

    def _fuentes(self):
        """Cada hoja configurada con su estado de conexión, para el menú del usuario:
        'ok', 'error' o 'pendiente' (todavía no se ha intentado cargar). Sin URLs: en el
        servidor las direcciones de las hojas no salen hacia el navegador."""
        def fuente(clave, nombre, estado, detalle):
            return {'clave': clave, 'nombre': nombre, 'estado': estado, 'detalle': detalle}

        fuentes = []
        if self.config.get('url_base_global'):
            if self.error_matriz:
                fuentes.append(fuente('extractos', 'Extractos', 'error', self.error_matriz))
            elif self.df_global is not None:
                fuentes.append(fuente('extractos', 'Extractos', 'ok', f"{len(self.df_global):,} filas".replace(',', '.')))
            else:
                fuentes.append(fuente('extractos', 'Extractos', 'pendiente', None))
        for linea in self.config.get('lineas_credito', []):
            if not str(linea.get('url', '')).strip():
                continue
            nombre = linea.get('nombre', linea.get('clave'))
            roster = self.rosters.get(linea.get('clave'))
            if nombre in self.errores_lineas:
                fuentes.append(fuente(linea['clave'], nombre, 'error', self.errores_lineas[nombre]))
            elif roster is not None:
                activos = sum(len(e) for e in roster.values())
                fuentes.append(fuente(linea['clave'], nombre, 'ok',
                                      f"{activos:,} créditos activos".replace(',', '.')))
            else:
                fuentes.append(fuente(linea['clave'], nombre, 'pendiente', None))
        if str(self.config.get('url_whatsapp', '')).strip():
            if self.error_whatsapp:
                fuentes.append(fuente('whatsapp', 'WhatsApp', 'error', self.error_whatsapp))
            elif self.listo and not self.parcial:
                fuentes.append(fuente('whatsapp', 'WhatsApp', 'ok',
                                      f"{len(self.whatsapp):,} contactos".replace(',', '.')))
            else:
                fuentes.append(fuente('whatsapp', 'WhatsApp', 'pendiente', None))
        return fuentes

    def _carpeta_cierres(self):
        if not self.config.get('buscador_incluir_archivos_locales', True):
            return None
        return self.config.get('carpeta_cierres') or None

    # ------------------------------------------------------------------ búsqueda
    def buscar(self, termino, usuario):
        """Devuelve el resultado listo para JSON, o None si los datos todavía no están
        (en ese caso deja la carga en marcha)."""
        if not self.listo:
            self.iniciar_carga()
            return None

        carpeta = self._carpeta_cierres()
        df_global = self.df_global
        argumentos = dict(df_global=df_global, carpeta_salida=carpeta,
                          cache_archivos=self.cache_archivos,
                          cache_normalizado=self.cache_normalizado)
        if carpeta:
            # El índice de cierres es un SQLite que se actualiza al buscar: dos búsquedas
            # a la vez lo reindexarían en paralelo. La Matriz_Nube sola no lo necesita.
            with self._candado_indice:
                resultados, totales = buscar_comprobante_global(termino, **argumentos)
        else:
            resultados, totales = buscar_comprobante_global(termino, **argumentos)

        sugerencia = sugerir_termino_parecido(termino, df_global) if not resultados else None
        id_busqueda = self._guardar_busqueda(termino, resultados, usuario)
        return {
            'id': id_busqueda,
            'termino': termino,
            'total': sum(totales.values()) if totales else len(resultados),
            'grupos': self._agrupar(resultados, totales),
            'sugerencia': sugerencia,
            'asociado': self._asociado(termino),
            # Buscó antes de que terminaran de cargar las líneas: la página repite la
            # búsqueda sola al terminar, para sumar el resumen de créditos.
            'parcial': self.parcial,
        }

    def _asociado(self, termino):
        """Si lo buscado es una cédula, el resumen de la persona que va ARRIBA de los
        resultados: sus créditos activos en todas las líneas y su WhatsApp. None si no es
        una cédula o si no aparece en ninguna de las dos cosas."""
        if not re.fullmatch(r'[\d.\s]+', termino):
            return None
        cedula = limpiar_cedula(termino)
        if len(cedula) < 5:
            return None
        lineas = self._lineas_de_cedula(cedula) if self.rosters else []
        whatsapp = self._enlace_whatsapp(cedula)
        if not lineas and not whatsapp:
            return None
        nombre = next((e['nombre'] for l in lineas for e in l['entradas'] if e.get('nombre')), None)
        if not nombre:
            nombre = (self.whatsapp.get(cedula) or {}).get('nombre')
        return {
            'cedula': _cedula_con_puntos(cedula),
            'cedula_limpia': cedula,
            'nombre': nombre,
            'whatsapp': whatsapp,
            'lineas': lineas,
            'total_creditos': sum(len(l['entradas']) for l in lineas),
        }

    def _guardar_busqueda(self, termino, resultados, usuario):
        id_busqueda = secrets.token_urlsafe(9)
        with self._candado_busquedas:
            self._busquedas[id_busqueda] = {'termino': termino, 'resultados': resultados,
                                            'usuario': usuario}
            while len(self._busquedas) > MAX_BUSQUEDAS_GUARDADAS:
                self._busquedas.popitem(last=False)
        return id_busqueda

    def _obtener_busqueda(self, id_busqueda, usuario):
        """Una persona solo puede abrir sus propias búsquedas."""
        with self._candado_busquedas:
            b = self._busquedas.get(id_busqueda)
        if b is None or b['usuario'] != usuario:
            return None
        return b

    @staticmethod
    def _agrupar(resultados, totales):
        """Mismo agrupamiento por fuente que la pantalla de escritorio. Cada fila lleva su
        posición 'i' dentro de la búsqueda, que es lo que se pide luego para el detalle."""
        grupos = OrderedDict()
        for i, r in enumerate(resultados):
            g = grupos.get(r['fuente'])
            if g is None:
                g = grupos[r['fuente']] = {
                    'fuente': _nombre_visible(r['fuente']),
                    'columnas': list(r['columnas']),
                    'total': totales.get(r['fuente'], 0),
                    'filas': [],
                    'recortado': False,
                }
            if len(g['filas']) >= LIMITE_FILAS_DIBUJADAS:
                g['recortado'] = True
                continue
            estado = clasificar_estado_pago(r['fila'])
            g['filas'].append({
                'i': i,
                'v': [_formatear_valor_celda(r['fila'].get(c, '')) for c in g['columnas']],
                'm': [j for j, c in enumerate(g['columnas']) if c in r['columnas_coincidentes']],
                'e': estado['clave'] if estado else None,
            })
        for g in grupos.values():
            g['total'] = max(g['total'], len(g['filas']))
        return list(grupos.values())

    # ------------------------------------------------------------------ detalle
    def detalle(self, id_busqueda, indice, usuario):
        b = self._obtener_busqueda(id_busqueda, usuario)
        if b is None or not (0 <= indice < len(b['resultados'])):
            return None
        r = b['resultados'][indice]
        return self._detalle_de_fila(r['fuente'], r['columnas'], r['fila'])

    def _detalle_de_fila(self, fuente, columnas, fila):
        distrito = obtener_distrito_de_fila(fila)
        directorio = self.config.get('directorio_cartera', DIRECTORIO_CARTERA_DEFECTO)
        persona = buscar_encargado_cartera(distrito, directorio) if distrito is not None else None

        cedula = obtener_cedula_de_fila(fila)
        lineas, motivo_sin_lineas = None, None
        if cedula is not None and self.rosters:
            lineas = self._lineas_de_cedula(limpiar_cedula(cedula))
        elif cedula is None:
            motivo_sin_lineas = "En esta fila no hay ningún campo con forma de cédula; por eso no se consultan las líneas de crédito."
        elif self.parcial:
            motivo_sin_lineas = "Las líneas de crédito todavía se están cargando. Vuelve a abrir este detalle en un momento."
        elif not any(str(l.get('url', '')).strip() for l in self.config.get('lineas_credito', [])):
            motivo_sin_lineas = "No hay líneas de crédito configuradas en el servidor."
        else:
            motivo_sin_lineas = "Las líneas de crédito no se pudieron cargar. Un administrador puede revisar el error con «Refrescar datos»."

        cedula_limpia = limpiar_cedula(cedula) if cedula is not None else None
        return {
            'fuente': _nombre_visible(fuente),
            'estado_pago': clasificar_estado_pago(fila),
            'distrito': _formatear_valor_celda(distrito) if distrito is not None else None,
            'encargado': ({'nombre': persona.get('nombre', ''), 'cargo': persona.get('cargo', ''),
                           'extension': persona.get('extension', '')} if persona else None),
            'cedula': _formatear_valor_celda(cedula) if cedula is not None else None,
            'cedula_limpia': cedula_limpia,
            'whatsapp': self._enlace_whatsapp(cedula_limpia),
            'lineas': lineas,
            'motivo_sin_lineas': motivo_sin_lineas,
            'campos': [{'columna': str(c), 'valor': _formatear_valor_celda(fila.get(c, ''))}
                       for c in columnas],
        }

    def _lineas_de_cedula(self, cedula_norm):
        """Igual que _buscar_lineas_credito_de_cedula del escritorio: las líneas con
        información extra (Seguro de Vida) siempre al final."""
        coincidencias = []
        for linea in self.config.get('lineas_credito', []):
            roster = self.rosters.get(linea.get('clave'))
            entradas = roster.get(cedula_norm) if roster else None
            if not entradas:
                continue
            coincidencias.append((linea['clave'] in CLAVES_LINEAS_CON_INFO_EXTRA, {
                'linea': linea.get('nombre', linea.get('clave')),
                'entradas': [self._entrada_json(e) for e in entradas],
            }))
        coincidencias.sort(key=lambda c: c[0])
        return [c[1] for c in coincidencias]

    @staticmethod
    def _entrada_json(e):
        meses = e.get('meses_mora')
        en_mora = None
        if meses is not None:
            try:
                en_mora = float(meses) > 0
                meses = f"{round(float(meses)):,}"
            except (TypeError, ValueError):
                meses = _formatear_valor_celda(meses)
        return {
            'congregacion': e.get('congregacion'),
            'cco': e.get('cco'),
            'distrito': e.get('distrito'),
            'nombre': e.get('nombre'),
            'link_obligacion': _enlace_seguro(e.get('link_obligacion')),
            'tarifa': _formatear_valor_celda(e['tarifa']) if e.get('tarifa') is not None else None,
            'saldo': _formatear_valor_celda(e['saldo']) if e.get('saldo') is not None else None,
            'columna_tarifa': e.get('columna_tarifa'),
            'columna_saldo': e.get('columna_saldo'),
            'meses_mora': meses,
            'en_mora': en_mora,
            'observacion_directivos': e.get('observacion_directivos'),
            'observacion_general': e.get('observacion_general'),
            'tipo_credito': e.get('tipo_credito'),
            'link_registro': _enlace_seguro(e.get('link_registro')),
            'observacion_estado': e.get('observacion_estado'),
            'fecha_ultimo_pago': (_formatear_valor_celda(e['fecha_ultimo_pago'])
                                  if e.get('fecha_ultimo_pago') is not None else None),
            'saldo_actual': (_formatear_valor_celda(e['saldo_actual'])
                             if e.get('saldo_actual') is not None else None),
            # Toda la fila de la obligación, para su detalle. Una celda que es en sí misma
            # una dirección web también se ofrece como enlace.
            'campos': [{'columna': columna, 'valor': _valor_de_campo(columna, valor),
                        'enlace': _enlace_seguro(enlace or valor)}
                       for columna, valor, enlace in e.get('campos') or []],
        }

    # ------------------------------------------------------------------ tabla completa
    # Los Extractos enteros, tal cual la hoja, para recorrerlos con filtros en los
    # encabezados como en Google Sheets o Excel. Todo sale de la copia que ya está en
    # memoria: abrir la tabla o filtrarla no descarga nada.
    #
    # filtros: {"<n.º de columna>" o "estado": {"valores": [...]} | {"excluir": [...]} |
    # {"texto": "..."}}. Los valores son los textos como se ven en la tabla ("" = vacía).
    # orden: "<n.º de columna o estado>:asc" o ":desc".

    def _datos_tabla(self):
        """Lo que la tabla calcula una vez por cada versión de los Extractos, a pedido y por
        columna: los textos, su versión normalizada, el orden y el estado de cada fila."""
        df = self.df_global
        t = self._cache_tabla
        if t is None or t['df'] is not df:
            dfu = _columnas_unicas(df)
            t = self._cache_tabla = {
                'df': df, 'dfu': dfu, 'columnas': [str(c) for c in dfu.columns],
                'texto': {}, 'normal': {}, 'orden': {}, 'estados': None, 'ultima': None,
            }
        return t

    @staticmethod
    def _texto_columna(t, col):
        if col == COLUMNA_ESTADO:
            return MotorWeb._estados(t)
        if col not in t['texto']:
            t['texto'][col] = pd.Series([_formatear_valor_celda(v) for v in t['dfu'].iloc[:, col].tolist()],
                                        dtype=object)
        return t['texto'][col]

    @staticmethod
    def _normal_columna(t, col):
        if col not in t['normal']:
            t['normal'][col] = pd.Series([_normalizar_para_busqueda(v) for v in MotorWeb._texto_columna(t, col)],
                                         dtype=object)
        return t['normal'][col]

    @staticmethod
    def _estados(t):
        """La clave del estado de pago de cada fila ('' si no tiene), con la misma regla que
        pinta la búsqueda (clasificar_estado_pago), pero mirando solo las columnas que la
        regla usa: así recorrer todas las filas toma un instante."""
        if t['estados'] is None:
            from axio.nucleo.utils import ALIAS_COLUMNA_RECIBO_NUBE
            alias = tuple(ALIAS_COLUMNA_RECIBO_NUBE) + ('NOTA CARTERA', 'NOTA RECAUDO')
            recibo = {str(a).strip().upper() for a in ALIAS_COLUMNA_RECIBO_NUBE}
            usadas = [c for c in t['columnas']
                      if c.strip().upper() == 'NOMBRE' or c.strip().upper() in recibo
                      or any(a in c.strip().upper() for a in alias)]
            if usadas:
                estados = []
                for valores in t['dfu'][usadas].itertuples(index=False, name=None):
                    e = clasificar_estado_pago(dict(zip(usadas, valores)))
                    estados.append(e['clave'] if e else '')
            else:
                estados = [''] * len(t['dfu'])
            t['estados'] = pd.Series(estados, dtype=object)
        return t['estados']

    @staticmethod
    def _orden_columna(t, col):
        """(puesto de cada fila al ordenar de menor a mayor, cuáles están vacías). Como al
        ordenar los resultados: fechas por fecha, cifras por valor y las vacías al final."""
        if col not in t['orden']:
            if col == COLUMNA_ESTADO:
                prioridad = {'pendiente_recaudo': 0, 'gestion_cartera': 1, 'ingresado': 2, 'referencia_erronea': 3}
                claves = [(prioridad.get(e, 4) if e else 9, 0) for e in MotorWeb._estados(t)]
                vacias = np.array([not e for e in MotorWeb._estados(t)], dtype=bool)
            else:
                claves = [_clave_orden_valor(v) for v in t['dfu'].iloc[:, col].tolist()]
                vacias = np.array([k[0] == 3 for k in claves], dtype=bool)
            try:
                orden = sorted(range(len(claves)), key=claves.__getitem__)
            except TypeError:   # tipos que no se dejan comparar dentro de un mismo grupo
                orden = sorted(range(len(claves)), key=lambda i: (claves[i][0], str(claves[i][1])))
            puesto = np.empty(len(claves), dtype=np.int64)
            puesto[orden] = np.arange(len(claves))
            t['orden'][col] = (puesto, vacias)
        return t['orden'][col]

    @staticmethod
    def _leer_columna(texto, n_columnas):
        texto = str(texto or '').strip()
        if texto == COLUMNA_ESTADO:
            return COLUMNA_ESTADO
        if texto.isdigit() and int(texto) < n_columnas:
            return int(texto)
        raise ValueError("Esa columna no existe en los Extractos.")

    @staticmethod
    def _leer_filtros(texto, n_columnas):
        if not texto:
            return {}
        try:
            crudo = json.loads(texto)
        except ValueError:
            raise ValueError("Los filtros no se entendieron.")
        if not isinstance(crudo, dict):
            raise ValueError("Los filtros no se entendieron.")
        filtros = {}
        for clave, f in crudo.items():
            col = MotorWeb._leer_columna(clave, n_columnas)
            if not isinstance(f, dict):
                raise ValueError("Los filtros no se entendieron.")
            if isinstance(f.get('texto'), str) and f['texto'].strip():
                filtros[col] = {'texto': f['texto'].strip()[:200]}
            for tipo in ('valores', 'excluir'):
                if isinstance(f.get(tipo), list):
                    filtros[col] = {tipo: [str(v) for v in f[tipo][:20000]]}
        return filtros

    @staticmethod
    def _leer_orden(texto, n_columnas):
        if not texto:
            return None
        col, _, sentido = str(texto).partition(':')
        return MotorWeb._leer_columna(col, n_columnas), sentido != 'desc'

    def _mascara(self, t, filtros, salvo=None):
        """Las filas que pasan todos los filtros (menos el de la columna 'salvo': la lista
        de valores de un filtro se arma con lo que dejan los DEMÁS, como en Excel)."""
        m = np.ones(len(t['dfu']), dtype=bool)
        for col, f in filtros.items():
            if col == salvo:
                continue
            if 'texto' in f:
                if col == COLUMNA_ESTADO:
                    continue
                buscado = _normalizar_para_busqueda(f['texto'])
                m &= self._normal_columna(t, col).str.contains(buscado, regex=False).to_numpy(dtype=bool)
            else:
                dentro = self._texto_columna(t, col).isin(set(f.get('valores') or f.get('excluir') or [])).to_numpy(dtype=bool)
                m &= dentro if 'valores' in f else ~dentro
        return m

    def _posiciones(self, t, filtros, orden):
        clave = (json.dumps({str(k): v for k, v in filtros.items()}, sort_keys=True), orden)
        if t['ultima'] is not None and t['ultima'][0] == clave:
            return t['ultima'][1]
        pos = np.flatnonzero(self._mascara(t, filtros))
        if orden is not None:
            col, ascendente = orden
            puesto, vacias = self._orden_columna(t, col)
            p = puesto[pos] if ascendente else -puesto[pos]
            pos = pos[np.lexsort((p, vacias[pos]))]   # las vacías, al final en los dos sentidos
        t['ultima'] = (clave, pos)
        return pos

    def tabla(self, desde=0, cuantas=200, filtros='', orden=''):
        """Un tramo de los Extractos filtrados y ordenados, o None si todavía no están.
        Cada fila trae su posición 'p' en la hoja (para abrir su detalle) y su estado."""
        if self.df_global is None:
            return None
        with self._candado_tabla:
            t = self._datos_tabla()
            n_columnas = len(t['columnas'])
            pos = self._posiciones(t, self._leer_filtros(filtros, n_columnas), self._leer_orden(orden, n_columnas))
            desde = max(0, int(desde))
            trozo = pos[desde:desde + max(1, min(int(cuantas), MAX_FILAS_POR_PEDIDO))]
            estados = self._estados(t)
            filas = [{'p': int(p), 'v': [_formatear_valor_celda(_nativo(v)) for v in valores], 'e': estados.iat[p] or None}
                     for p, valores in zip(trozo, t['dfu'].iloc[trozo].itertuples(index=False, name=None))]
            return {
                'columnas': t['columnas'],
                'total': int(len(t['dfu'])),
                'filtradas': int(len(pos)),
                'desde': desde,
                'filas': filas,
                'hora': _hora_iso(self.hora_matriz),
            }

    def valores_tabla(self, columna, filtros='', buscar=''):
        """Los valores distintos de una columna (con cuántas filas tiene cada uno) entre las
        filas que dejan los demás filtros: la lista del filtro del encabezado."""
        if self.df_global is None:
            return None
        with self._candado_tabla:
            t = self._datos_tabla()
            col = self._leer_columna(columna, len(t['columnas']))
            m = self._mascara(t, self._leer_filtros(filtros, len(t['columnas'])), salvo=col)
            buscar = str(buscar or '').strip()[:200]
            if buscar and col != COLUMNA_ESTADO:
                m &= self._normal_columna(t, col).str.contains(_normalizar_para_busqueda(buscar), regex=False).to_numpy(dtype=bool)
            cuentas = list(self._texto_columna(t, col)[m].value_counts(sort=False).items())
            if col == COLUMNA_ESTADO:
                prioridad = ['pendiente_recaudo', 'gestion_cartera', 'ingresado', 'referencia_erronea', '']
                cuentas.sort(key=lambda x: prioridad.index(x[0]) if x[0] in prioridad else 9)
            else:
                cuentas.sort(key=lambda x: _orden_texto(x[0]))
            return {
                'valores': [{'v': v, 'n': int(n)} for v, n in cuentas[:MAX_VALORES_FILTRO]],
                'distintos': len(cuentas),
                'recortado': len(cuentas) > MAX_VALORES_FILTRO,
            }

    def detalle_tabla(self, posicion):
        """El detalle de una fila de la tabla completa: el mismo que el de un resultado."""
        if self.df_global is None:
            return None
        with self._candado_tabla:
            t = self._datos_tabla()
            if not 0 <= posicion < len(t['dfu']):
                raise ValueError("Esa fila ya no está en los Extractos. Vuelve a abrir la tabla.")
            fila = dict(zip(t['columnas'], (_nativo(v) for v in t['dfu'].iloc[posicion].tolist())))
        return self._detalle_de_fila('Matriz_Nube', t['columnas'], fila)

    def exportar_tabla(self, filtros='', orden=''):
        """El .xlsx de lo que se ve en la tabla (todas las filas filtradas, en su orden),
        con el encabezado fijo y los filtros de Excel puestos."""
        if self.df_global is None:
            return None
        with self._candado_tabla:
            t = self._datos_tabla()
            n_columnas = len(t['columnas'])
            pos = self._posiciones(t, self._leer_filtros(filtros, n_columnas), self._leer_orden(orden, n_columnas))
            sub = t['dfu'].iloc[pos]
        buffer = io.BytesIO()
        with pd.ExcelWriter(buffer, engine='openpyxl') as escritor:
            sub.to_excel(escritor, index=False, sheet_name='Extractos')
            hoja = escritor.sheets['Extractos']
            hoja.freeze_panes = 'A2'
            hoja.auto_filter.ref = hoja.dimensions
        return buffer.getvalue()

    # ------------------------------------------------------------------ exportar
    def exportar(self, id_busqueda, usuario):
        """(bytes del .xlsx, término) o None. Exporta TODO lo encontrado, no solo lo que
        se dibujó en pantalla -- igual que en el escritorio."""
        b = self._obtener_busqueda(id_busqueda, usuario)
        if b is None:
            return None
        buffer = io.BytesIO()
        generar_excel_resultados_busqueda(b['termino'], b['resultados'], buffer)
        return buffer.getvalue(), b['termino']


_motor = None
_candado_motor = threading.Lock()


def obtener_motor():
    global _motor
    with _candado_motor:
        if _motor is None:
            _motor = MotorWeb()
        return _motor
