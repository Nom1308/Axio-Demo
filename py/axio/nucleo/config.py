"""Configuración de Axio (config_axio.json).

Solo guarda lo que Axio necesita: de dónde se descarga la Matriz_Nube, la carpeta de
cierres, el Directorio de Cartera, las líneas de crédito y un par de preferencias. A
diferencia de la configuración de Axioma, aquí NO hay PIN ni claves de API -- Axio no usa
ninguno de los dos.
"""

import os

from axio.dominio.buscador import DIRECTORIO_CARTERA_DEFECTO, LINEAS_CREDITO_DEFECTO, _migrar_nombres_lineas_credito

from axio.nucleo.almacen import _cargar_json_seguro, _guardar_json_seguro

from axio.nucleo.rutas import CONFIG_FILE


def cargar_config():
    default_config = {
        # Nombres con los que quedan las columnas de fecha, cédula y detalle de la
        # Matriz_Nube al descargarla (ver dominio/buscador.descargar_base_global). Se
        # dejan iguales a los de Axioma para que una misma hoja se vea igual en los dos.
        "col_fecha": "Fecha recibo",
        "col_detalle": "Detalle",
        "col_cedula": "Cedula",
        "url_base_global": "",
        # Carpeta donde están los cierres .xlsx que genera Axioma. Opcional: vacía, Axio
        # busca solo en la Matriz_Nube.
        "carpeta_cierres": "",
        # Directorio de Cartera -- se inicializa con el valor de fábrica
        # (DIRECTORIO_CARTERA_DEFECTO, que sale de 'directorio_cartera.json' si está junto
        # al programa) solo la primera vez; de ahí en adelante manda lo guardado. Se copia
        # (no se reusa la misma lista/dicts) para que nadie termine mutando por accidente
        # la constante de fábrica al editar el directorio en tiempo de ejecución.
        "directorio_cartera": [dict(p, distritos=list(p['distritos'])) for p in DIRECTORIO_CARTERA_DEFECTO],
        # Líneas de crédito para el cruce por cédula en el detalle -- mismo patrón que
        # directorio_cartera, valor de fábrica solo la primera vez.
        "lineas_credito": [dict(l) for l in LINEAS_CREDITO_DEFECTO],
        # Hoja con el celular de WhatsApp de cada asociado (columnas CEDULA y
        # CelularWhatsApp). Opcional: vacía, el detalle no muestra el botón de WhatsApp.
        "url_whatsapp": "",
        "historial_busqueda_global": [],
        # Si se busca también en los cierres .xlsx locales (carpeta_cierres).
        "buscador_incluir_archivos_locales": True,
    }
    if os.path.exists(CONFIG_FILE):
        try:
            data = _cargar_json_seguro(CONFIG_FILE)
            default_config.update(data)
            _migrar_nombres_lineas_credito(default_config)
            return default_config
        except: return default_config
    return default_config

def guardar_config(data):
    # Se FUSIONA con lo que ya existía en vez de sobreescribir el archivo: un guardado
    # parcial (ej. guardar_config({"historial_busqueda_global": [...]})) no debe borrar el
    # resto de la configuración.
    existente = {}
    if os.path.exists(CONFIG_FILE):
        try:
            existente = _cargar_json_seguro(CONFIG_FILE)
        except Exception:
            existente = {}
    existente.update(data)
    _guardar_json_seguro(CONFIG_FILE, existente)


# ==============================================================================
# TRAER LA CONFIGURACIÓN DESDE AXIOMA
# ==============================================================================
# Quien ya usa Axio dentro de Axioma tiene escritos ahí la URL de la Matriz_Nube, las URL
# de cada línea de crédito y el Directorio de Cartera. Volver a teclear todo eso para la
# versión independiente es trabajo perdido y una fuente de errores.
#
# Se copia una LISTA CERRADA de claves, no el archivo entero: config_conciliador.json
# también guarda el PIN y las claves de API de Gemini y Claude, y nada de eso tiene por qué
# terminar en la configuración de un programa que no lo usa.
#
# Tampoco se traen el historial de búsquedas (son cédulas y recibos que alguien buscó en
# otro programa) ni el interruptor de "Incluir cierres locales": en Axioma suele estar
# apagado por una razón que aquí no aplica, y traerlo apagado dejaría la Carpeta de cierres
# recién elegida sin efecto y sin ninguna pista de por qué.
CLAVES_QUE_VIENEN_DE_AXIOMA = (
    'url_base_global', 'col_fecha', 'col_detalle', 'col_cedula',
    'directorio_cartera', 'lineas_credito',
)


def leer_config_de_axioma(ruta_config_axioma):
    """Devuelve un dict con SOLO las claves de Axio presentes en un config_conciliador.json.

    No escribe nada: quien llama decide si lo guarda. Lanza ValueError si el archivo no
    parece una configuración de Axioma, para no "importar con éxito" cero claves de un
    JSON cualquiera."""
    datos = _cargar_json_seguro(ruta_config_axioma)
    if not isinstance(datos, dict):
        raise ValueError("Ese archivo no es una configuración de Axioma.")
    encontrados = {k: datos[k] for k in CLAVES_QUE_VIENEN_DE_AXIOMA if k in datos}
    if not encontrados:
        raise ValueError("Ese archivo no trae ninguna configuración de Axio "
                         "(se esperaba el config_conciliador.json de Axioma).")
    _migrar_nombres_lineas_credito(encontrados)
    return encontrados
