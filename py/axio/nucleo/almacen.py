"""Lectura y escritura segura de archivos JSON."""

import json

from axio.nucleo.entorno import HAS_ORJSON, orjson


def _cargar_json_seguro(ruta):
    """Lee un JSON con orjson si está disponible (más rápido), o el módulo 'json'
    estándar si no -- mismo resultado en ambos casos. Deja que la excepción se propague
    si el archivo no existe o está corrupto; quien llama ya decide qué hacer con eso
    (normalmente: devolver un valor por defecto)."""
    if HAS_ORJSON:
        with open(ruta, 'rb') as f:
            return orjson.loads(f.read())
    with open(ruta, 'r', encoding='utf-8') as f:
        return json.load(f)

def _guardar_json_seguro(ruta, datos):
    """Escribe un JSON con orjson si está disponible, o el módulo 'json' estándar si no.
    Ambos caminos producen UTF-8 real (acentos/ñ sin escapar) con sangría de 2 espacios,
    para que el archivo se vea igual en disco sin importar cuál se use."""
    if HAS_ORJSON:
        with open(ruta, 'wb') as f:
            f.write(orjson.dumps(datos, option=orjson.OPT_INDENT_2))
    else:
        with open(ruta, 'w', encoding='utf-8') as f:
            json.dump(datos, f, ensure_ascii=False, indent=2)
