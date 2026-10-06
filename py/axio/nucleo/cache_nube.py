"""Caché en disco de lo que se descarga de la nube (Matriz_Nube y líneas de crédito).

Hasta ahora la caché vivía solo en memoria: servía para la segunda búsqueda del día, pero
al cerrar la app se perdía y a la mañana siguiente la primera búsqueda volvía a esperar la
descarga completa. Aquí esa misma copia se guarda en un archivo, así que abrir la app y
buscar es inmediato aunque hayan pasado días.

Qué NO hace, a propósito:

  - No decide sola cuándo está vieja ni descarga por su cuenta. La copia se usa hasta que
    la persona le da a "Refrescar", que es el botón que ya existía. Una recarga automática
    a mitad de una consulta es justo lo que hace lento e impredecible el arranque.
  - No se reutiliza si la URL cambió: la copia guarda de qué URL salió y, si en
    Configuración se apunta a otra hoja, se ignora y se descarga de nuevo. Sin eso,
    cambiar la fuente dejaría resultados de la hoja anterior.

Ante cualquier problema al leer (archivo a medias, versión distinta de pandas, disco sin
permisos) se devuelve None y la app sigue como antes: descargando. La caché es una
comodidad, nunca un requisito.
"""
from datetime import datetime
import hashlib
import json
import os
import pickle

import pandas as pd

from axio.nucleo.registro import logger
from axio.nucleo.rutas import carpeta_datos

CARPETA_CACHE = "cache_nube"
ARCHIVO_MATRIZ = "matriz_nube.pkl"
ARCHIVO_MATRIZ_META = "matriz_nube.json"
ARCHIVO_LINEAS = "lineas_credito.pkl"
ARCHIVO_LINEAS_META = "lineas_credito.json"

# Formato de la caché. Si algún día cambia lo que se guarda, subir este número hace que
# las copias viejas se ignoren solas en vez de leerse mal.
VERSION_CACHE = 1


def _carpeta():
    ruta = os.path.join(carpeta_datos(), CARPETA_CACHE)
    os.makedirs(ruta, exist_ok=True)
    return ruta


def _ruta(nombre):
    return os.path.join(_carpeta(), nombre)


def _firma(texto):
    """Huella corta de la URL (o del conjunto de URLs). Se guarda la huella y no la URL
    completa porque estas llevan identificadores de hojas privadas y este archivo puede
    terminar en un respaldo o en un ZIP del proyecto."""
    return hashlib.sha256(str(texto or "").encode("utf-8")).hexdigest()[:16]


def _leer_meta(nombre_meta):
    try:
        with open(_ruta(nombre_meta), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _escribir_meta(nombre_meta, datos):
    with open(_ruta(nombre_meta), "w", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False, indent=1)


def _hora_de(meta):
    try:
        return datetime.strptime(meta["hora"], "%Y-%m-%d %H:%M:%S")
    except (KeyError, TypeError, ValueError):
        return None


# ------------------------------------------------------------------------------
# MATRIZ_NUBE
# ------------------------------------------------------------------------------
def guardar_matriz_nube(df, url):
    """Guarda la Matriz_Nube recién descargada. Devuelve True si quedó guardada."""
    if df is None or getattr(df, 'empty', True):
        return False
    try:
        df.to_pickle(_ruta(ARCHIVO_MATRIZ))
        _escribir_meta(ARCHIVO_MATRIZ_META, {
            "version": VERSION_CACHE,
            "firma_url": _firma(url),
            "hora": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "filas": int(len(df)),
            "columnas": [str(c) for c in df.columns],
        })
        return True
    except Exception:
        logger.exception("No se pudo guardar la caché en disco de Matriz_Nube")
        return False


def cargar_matriz_nube(url):
    """(df, hora_de_descarga) de la copia guardada, o (None, None).

    'hora' es cuándo se DESCARGÓ, no cuándo se leyó: es lo que la pantalla muestra como
    'hace 2 días', para que nadie confunda una copia vieja con datos frescos."""
    meta = _leer_meta(ARCHIVO_MATRIZ_META)
    if not meta or meta.get("version") != VERSION_CACHE:
        return None, None
    if meta.get("firma_url") != _firma(url):
        return None, None  # la URL cambió: esta copia ya no corresponde
    try:
        df = pd.read_pickle(_ruta(ARCHIVO_MATRIZ))
    except Exception:
        logger.exception("La caché en disco de Matriz_Nube no se pudo leer; se descargará de nuevo")
        return None, None
    if df is None or getattr(df, 'empty', True):
        return None, None
    return df, _hora_de(meta)


# ------------------------------------------------------------------------------
# LÍNEAS DE CRÉDITO
# ------------------------------------------------------------------------------
def _firma_lineas(lineas_credito):
    """Huella del CONJUNTO de líneas configuradas: su clave y su URL. Si se agrega una
    línea, se corrige una URL o se borra otra, la huella cambia y la copia se descarta."""
    partes = sorted(f"{l.get('clave')}={l.get('url', '')}" for l in (lineas_credito or []))
    return _firma("|".join(partes))


def guardar_lineas_credito(rosters, lineas_credito):
    if not rosters:
        return False
    try:
        with open(_ruta(ARCHIVO_LINEAS), "wb") as f:
            pickle.dump(rosters, f, protocol=4)
        _escribir_meta(ARCHIVO_LINEAS_META, {
            "version": VERSION_CACHE,
            "firma_lineas": _firma_lineas(lineas_credito),
            "hora": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "lineas": sorted(str(k) for k in rosters),
        })
        return True
    except Exception:
        logger.exception("No se pudo guardar la caché en disco de las líneas de crédito")
        return False


def cargar_lineas_credito(lineas_credito):
    meta = _leer_meta(ARCHIVO_LINEAS_META)
    if not meta or meta.get("version") != VERSION_CACHE:
        return None, None
    if meta.get("firma_lineas") != _firma_lineas(lineas_credito):
        return None, None
    try:
        with open(_ruta(ARCHIVO_LINEAS), "rb") as f:
            rosters = pickle.load(f)
    except Exception:
        logger.exception("La caché en disco de las líneas de crédito no se pudo leer")
        return None, None
    if not rosters:
        return None, None
    return rosters, _hora_de(meta)


# ------------------------------------------------------------------------------
def limpiar_cache_disco():
    """Borra las copias guardadas. Lo llama el botón 'Refrescar': si solo se limpiara la
    memoria, la siguiente búsqueda volvería a levantar del disco la copia vieja y el botón
    parecería no hacer nada."""
    borrados = 0
    for nombre in (ARCHIVO_MATRIZ, ARCHIVO_MATRIZ_META, ARCHIVO_LINEAS, ARCHIVO_LINEAS_META):
        try:
            os.remove(_ruta(nombre))
            borrados += 1
        except OSError:
            pass  # no existía: no hay nada que borrar
    return borrados


def estado_cache_disco():
    """Resumen para la pantalla de Diagnóstico: qué hay guardado y de cuándo."""
    meta_matriz = _leer_meta(ARCHIVO_MATRIZ_META) or {}
    meta_lineas = _leer_meta(ARCHIVO_LINEAS_META) or {}

    def _peso(nombre):
        try:
            return os.path.getsize(_ruta(nombre))
        except OSError:
            return 0

    return {
        "matriz_hora": _hora_de(meta_matriz),
        "matriz_filas": meta_matriz.get("filas"),
        "lineas_hora": _hora_de(meta_lineas),
        "lineas": meta_lineas.get("lineas", []),
        "peso_mb": (_peso(ARCHIVO_MATRIZ) + _peso(ARCHIVO_LINEAS)) / (1024 * 1024),
    }
