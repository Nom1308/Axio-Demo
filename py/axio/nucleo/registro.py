"""Log técnico de Axio (axio_errores.log).

Axio corre en una ventana sin consola: una excepción que no se escriba aquí no la ve
nadie. Todo el código usa 'logger.exception(...)' dentro de sus except para que el error
real quede en el archivo aunque en pantalla solo se muestre un aviso corto.
"""

import logging

from axio.nucleo.rutas import ERROR_LOG_FILE

logging.basicConfig(
    filename=ERROR_LOG_FILE,
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
    encoding='utf-8'
)
logger = logging.getLogger("Axio")
