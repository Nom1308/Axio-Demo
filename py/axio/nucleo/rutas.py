"""Rutas de los archivos de datos de Axio.

Las rutas se resuelven contra una carpeta base explícita, no contra "donde esté parado el
proceso" a secas:

  - Ejecutable congelado (.exe) -> junto al .exe. Es donde la persona espera ver sus datos
    y donde quedan si mueve la carpeta completa. NO sirve sys._MEIPASS: con --onefile esa
    es la carpeta temporal que PyInstaller descomprime y BORRA al cerrar.
  - Desarrollo -> el directorio de trabajo (la raíz del proyecto cuando se lanza desde
    VS Code o con 'python main.py').

Todos estos archivos son DATOS de quien usa la app y están en el .gitignore: ninguno debe
subir al repositorio.
"""

import os
import sys


def carpeta_datos():
    """Carpeta donde viven la configuración, el índice, la caché y el log.

    La variable de entorno AXIO_CARPETA_DATOS manda sobre todo lo demás. La usa la versión
    web: en un servidor el directorio de trabajo depende de cómo se lance el servicio, y
    los datos tienen que quedar en una carpeta fija que sobreviva a reinicios y
    actualizaciones del código."""
    desde_entorno = os.environ.get('AXIO_CARPETA_DATOS', '').strip()
    if desde_entorno:
        os.makedirs(desde_entorno, exist_ok=True)
        return os.path.abspath(desde_entorno)
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.abspath(os.getcwd())


def ruta_dato(nombre):
    return os.path.join(carpeta_datos(), nombre)


# Nombres PROPIOS de Axio, distintos de los de Axioma a propósito: si alguien deja los dos
# programas en la misma carpeta, ninguno le pisa la configuración ni la base al otro.
CONFIG_FILE = ruta_dato("config_axio.json")
DB_FILE = ruta_dato("axio_indice.db")
ERROR_LOG_FILE = ruta_dato("axio_errores.log")
