"""Utilidades transversales: limpieza de cédulas y montos, lectura de Excel con
hipervínculos y el control del recolector de basura en hilos de trabajo.

Copiado de axioma/nucleo/utils.py sin modificar el código: solo se dejó lo que Axio usa.
La red de seguridad de los finalizadores de tkinter, que en Axioma vive en ese mismo
archivo, aquí está en axio/ui/hilos.py: importa tkinter, y nucleo/ no puede hacerlo.
"""

from contextlib import contextmanager
from openpyxl import load_workbook
import gc
import io

import pandas as pd
import re
import urllib.request


# Nombre real de la columna de recibo en la Matriz_Nube. Se llama RWS -- NO RCW, aunque
# medio código (y media empresa) la nombre así de palabra. La confusión ya costó DOS bugs
# silenciosos idénticos, en dos módulos distintos, cada uno descubierto por separado:
#   - el candado de recibo del motor de conciliación no cruzaba nada nunca;
#   - Axio nunca pintaba de verde una fila ya ingresada.
# En los dos casos la comparación era exacta contra 'RCW', el nombre no coincidía, y ni
# uno ni otro avisaba de nada. Vive aquí, en un solo sitio, justamente para que el día
# que la hoja cambie de nombre otra vez sea UNA edición y no una cacería.
ALIAS_COLUMNA_RECIBO_NUBE = ('RWS', 'RCW')


def limpiar_cedula(x):
    if pd.isna(x) or x is None: return '0'
    s = str(x).strip().upper()
    
    # 1. Rescate por si Excel lo pasó a notación científica (Ej: 1.17E+07)
    if 'E+' in s or 'E-' in s:
        try: s = str(int(float(s)))
        except: pass
        
    # 2. Cortar los "falsos decimales" de Excel al final (Ej: ",00" o ".0")
    s = re.sub(r'[,.]0+$', '', s)
    
    # 3. Eliminar todos los puntos y comas restantes (separadores de miles colombianos)
    s = s.replace('.', '').replace(',', '')
    
    # 4. Destruir cualquier letra o espacio, dejando SOLO los números puros
    s = re.sub(r'\D', '', s) 
    
    return s if s != '' else '0'

def parse_money(x):
    try:
        if pd.isna(x) or x is None: return 0.0
        if isinstance(x, (int, float)): return float(x)
        s = str(x).strip()
        if not s: return 0.0
        signo = -1.0 if '-' in s or '(' in s else 1.0
        s = re.sub(r'[^\d.,]', '', s)
        if not s: return 0.0
        if '.' in s and ',' in s:
            if s.rfind(',') > s.rfind('.'): s = s.replace('.', '').replace(',', '.')
            else: s = s.replace(',', '')
        elif ',' in s:
            partes = s.split(',')
            if len(partes) > 2 or len(partes[-1]) == 3: s = s.replace(',', '')
            else: s = s.replace(',', '.')
        elif '.' in s:
            partes = s.split('.')
            if len(partes) > 2 or len(partes[-1]) == 3: s = s.replace('.', '')
        return float(s) * signo
    except: return 0.0


def _formatear_cco(valor):
    """Normaliza un código de congregación: si es numérico, lo rellena con
    ceros a la izquierda hasta 4 dígitos (ej. 35 -> '0035'); si llegó con
    basura de digitación (salto de línea pegado, texto en vez de número), se
    limpia de espacios/saltos de línea pero se deja tal cual -- se prefiere
    mostrar el dato sucio a inventar un código que no es."""
    texto = str(valor).replace('\n', '').replace('\r', '').strip()
    texto_sin_punto = texto[:-2] if texto.endswith('.0') else texto
    if texto_sin_punto.isdigit():
        return texto_sin_punto.zfill(4)
    return texto


def _leer_workbook_openpyxl(url_o_ruta):
    """Abre un .xlsx ya sea desde un path local o una URL http(s), devolviendo
    un Workbook de openpyxl CON LOS HIPERVÍNCULOS INTACTOS -- por eso aquí NO
    se usa pandas: pd.read_excel() descarta cualquier hipervínculo de celda,
    y un CSV (lo que descargar_base_global pide para Matriz_Nube) ni siquiera
    puede llevarlos -- es texto plano."""
    if url_o_ruta.startswith('http://') or url_o_ruta.startswith('https://'):
        # 120s (no 30s) -- una línea 'bastante extensa' exportada como xlsx
        # completo desde Google Sheets puede tardar bastante más que una hoja
        # chica; con 30s se corría el riesgo de cortar la descarga a medias
        # en una línea grande y fallar en silencio.
        with urllib.request.urlopen(url_o_ruta, timeout=120) as respuesta:
            datos = respuesta.read()
        return load_workbook(io.BytesIO(datos), data_only=True)
    return load_workbook(url_o_ruta, data_only=True)


# ==============================================================================
# HILOS Y RECOLECTOR DE BASURA (V10.8)
# ==============================================================================
@contextmanager
def gc_fuera_del_hilo(app=None):
    """Evita que el recolector de basura corra DENTRO de un hilo de trabajo.

    El problema real, visto en producción: una búsqueda de Axio lee decenas de archivos
    Excel; eso reserva y libera mucha memoria, así que el recolector se dispara -- y se
    dispara en ESE hilo. Si en ese momento quedaba basura de tkinter (una fuente, una
    variable, una imagen que la interfaz descartó al redibujar), su __del__ llama a Tcl
    desde un hilo que no es el principal. Primero aparecen mensajes sueltos de
    "main thread is not in main loop" y al final Tcl_AsyncDelete cierra la aplicación
    entera, sin diálogo y sin nada en el log de errores.

    Aquí se apaga el recolector mientras dura el hilo y se vuelve a encender al terminar;
    la recolección se pide en el hilo principal con after(), que es donde sí se puede
    hablar con Tcl. No se pierde memoria: el conteo de referencias sigue liberando lo
    normal, solo se aplazan los ciclos unos segundos.
    """
    estaba_activo = gc.isenabled()
    if estaba_activo:
        gc.disable()
    try:
        yield
    finally:
        if estaba_activo:
            gc.enable()
            if app is not None:
                try:
                    app.after(0, gc.collect)
                except Exception:
                    pass  # la ventana ya se cerró: no hay nada que recolectar
