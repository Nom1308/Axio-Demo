"""Arranque del entorno: dependencias opcionales, rutas de recursos y DPI de Windows.

Aquí NO se importa nada gráfico: este módulo lo usan nucleo/ y dominio/, que tienen que
poder ejecutarse sin abrir una ventana.
"""

import os
import sys

# orjson es un reemplazo directo para leer/escribir JSON -- mismo contenido, más rápido.
# Si no está instalado se usa el módulo 'json' estándar exactamente igual.
HAS_ORJSON = False
try:
    import orjson
    HAS_ORJSON = True
except ImportError:
    orjson = None

# Coincidencia difusa para el "¿Quisiste decir...?" de una búsqueda sin resultados.
# rapidfuzz y thefuzz tienen la misma API; si no está ninguno, 'fuzz' queda en None y el
# buscador simplemente no ofrece sugerencia (ver dominio/buscador.sugerir_termino_parecido).
HAS_RAPIDFUZZ = False
try:
    from rapidfuzz import fuzz
    HAS_RAPIDFUZZ = True
except ImportError:
    try:
        from thefuzz import fuzz
    except ImportError:
        fuzz = None


def obtener_ruta_recurso(relative_path):
    """Ruta de un recurso que viaja DENTRO del ejecutable (el ícono). No confundir con
    los datos (config, índice, caché), que viven junto al .exe: ver nucleo/rutas."""
    try: base_path = sys._MEIPASS
    except Exception: base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)


# ==============================================================================
# DPI AWARENESS DE WINDOWS
# ==============================================================================
# En pantallas con escala distinta de 100% (125%/150%, lo normal en laptops), si el proceso
# NO declara que maneja su propio DPI, Windows estira la ventana por su cuenta y luego
# customtkinter vuelve a aplicar el factor de escala: el escalado termina aplicado DOS
# veces. Debe declararse ANTES de crear cualquier ventana -- por eso vive aquí y se ejecuta
# al importar. Si algo falla (otro SO, Windows viejo) se degrada sin romper el arranque.
def _declarar_dpi_awareness_windows():
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass  # Nunca debe impedir que el programa arranque

_declarar_dpi_awareness_windows()
