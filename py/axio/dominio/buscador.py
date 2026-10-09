"""Axio: búsqueda global de comprobantes, directorio de cartera y líneas de crédito.

Copiado de axioma/dominio/axio.py sin modificar el código: solo cambian los imports y
los números de EJEMPLO de los comentarios (en Axioma eran cédulas y un recibo reales; aquí
son inventados). Ningún nombre de función, constante ni firma es distinto, así que un
'diff' contra el archivo de Axioma muestra únicamente eso...

...más UN agregado, marcado "(Propio de Axio independiente)": el bloque COLUMNA DE CÉDULA
SIN ENCABEZADO y su llamada dentro de descargar_base_global. Conviene llevarlo a Axioma.
"""

from datetime import datetime
import difflib
from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.styles import PatternFill
from openpyxl.utils import get_column_letter
import os
import json
import pandas as pd
import re
import unicodedata

from axio.nucleo.entorno import fuzz

from axio.nucleo.registro import logger

from axio.nucleo.rutas import ruta_dato

from axio.nucleo.utils import ALIAS_COLUMNA_RECIBO_NUBE, _formatear_cco, _leer_workbook_openpyxl, limpiar_cedula, parse_money


# V10.3: tope de filas devueltas por fuente. Subido de 300 a 5.000 para que en la práctica
# nunca se recorte nada: el conteo real siempre se informa aparte, pero recortar la lista
# hacía que la exportación a Excel también saliera incompleta.
LIMITE_RESULTADOS_POR_FUENTE = 5000

# Cuántas filas se DIBUJAN de esas. Son dos cosas distintas y confundirlas fue el error:
# encontrar y exportar 5.000 no cuesta casi nada, pero dibujarlas sí -- cada celda hay que
# medirla y recortarla con la fuente real, y son 5.000 x 25 = 125.000 celdas. Medido, eso
# tarda MINUTOS con la ventana congelada.
#
# Nadie recorre 5.000 filas con la rueda del mouse: para eso está el filtro o el Excel. Se
# dibuja un tope razonable y la exportación se lleva TODO lo encontrado -- que es lo que
# de verdad garantiza que no se pierda información.
LIMITE_FILAS_DIBUJADAS = 1000

HOJAS_BUSCABLES = ['Depurados_Movidos', 'Pendientes_Extracto', 'Pend_Cred_Ext',
                   'Pendientes_Libro', 'Pend_Cred_Libro', 'Peligro_global', 'Matriz_Nube_Auditada']

# ------------------------------------------------------------------------------
# DIRECTORIO DE CARTERA (V8.0)
# ------------------------------------------------------------------------------
# Mapeo Distrito -> persona encargada en el área de Cartera de Corpentunida. Vive en
# config.json (clave 'directorio_cartera') para que Brandon pueda corregirlo/actualizarlo
# sin tocar código cuando cambie el personal o se reasignen distritos -- esta lista de
# aquí es SOLO el valor de fábrica que se usa la primera vez que se corre la app o si el
# usuario borra el directorio guardado. Cada distrito puede ser un número (como texto,
# para no pelear con "9" vs "9.0" que vienen de Excel) o una palabra clave especial que
# también aparece en el organigrama (MISIONEROS, CONSISTORIO, JUNTA DIRECTIVA, UBR,
# MUSICOS, VIUDAS).
def _cargar_directorio_cartera_externo():
    """Lee el directorio de Cartera desde un archivo junto al ejecutable, si está.

    Devolver una lista vacía cuando no está NO es un error: significa "esta copia no trae
    directorio", que es justo lo que debe pasar en una instalación nueva o en un
    entregable. La pantalla de Configuración permite cargarlo o escribirlo después.
    """
    try:
        ruta = ruta_dato('directorio_cartera.json')
        if not os.path.exists(ruta):
            return []
        with open(ruta, 'r', encoding='utf-8') as f:
            datos = json.load(f)
        return datos if isinstance(datos, list) else []
    except Exception:
        logger.exception("No se pudo leer directorio_cartera.json; se arranca sin directorio")
        return []


# V9.7: el directorio de Cartera SALIÓ DEL CÓDIGO.
#
# Acá vivían, escritos a mano, los nombres completos, cargos y extensiones telefónicas de
# doce personas reales del área de Cartera. Al empaquetar la aplicación esos datos quedan
# DENTRO del ejecutable: no se pueden borrar antes de entregarlo y viajan con cada copia
# que se comparta. Son datos personales de terceros, y en Colombia su tratamiento está
# regulado por la Ley 1581 de 2012.
#
# Ahora la lista de fábrica está VACÍA y el directorio real se carga, si existe, desde
# 'directorio_cartera.json' junto al ejecutable -- un archivo de datos que se puede incluir
# o no según a quién vaya la copia. Quien ya tenga su directorio guardado en la
# configuración no pierde nada: esta constante solo se usa la primera vez.
DIRECTORIO_CARTERA_DEFECTO = _cargar_directorio_cartera_externo()


# ==============================================================================
# EXPORTAR / IMPORTAR EL DIRECTORIO DE CARTERA (V10.0)
# ==============================================================================
# El directorio dejó de vivir en el código (Ley 1581: eran datos personales de doce
# personas reales que viajaban dentro del .exe). Ahora que es un archivo aparte, hace
# falta poder moverlo: llevarlo a otro equipo, compartirlo con un compañero, respaldarlo
# antes de reorganizar los distritos.
#
# Estas dos funciones viven en dominio/ y no en la pantalla de Configuración para poder
# verificarlas sin abrir la interfaz -- que es donde de verdad importa, porque un import
# mal validado puede dejar el directorio en un estado inconsistente y que Axio muestre el
# encargado equivocado sin que nada avise.

VERSION_FORMATO_CARTERA = 1


def exportar_directorio_cartera(ruta_destino, directorio, autor=None):
    """Escribe el directorio a un archivo .json portable.

    Se guarda envuelto en un sobre con versión y fecha, no como una lista pelada. Cuesta
    tres líneas y permite que un archivo viejo se siga reconociendo si mañana cambia la
    estructura de cada persona: sin marca de versión habría que adivinarla mirando las
    claves.
    """
    if not directorio:
        raise ValueError("El directorio está vacío: no hay nada que exportar.")

    sobre = {
        'formato': 'axioma_directorio_cartera',
        'version': VERSION_FORMATO_CARTERA,
        'exportado': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'exportado_por': str(autor or ''),
        'personas': [
            {
                'nombre': str(p.get('nombre', '')).strip(),
                'cargo': str(p.get('cargo', '')).strip(),
                'distritos': [str(d).strip() for d in (p.get('distritos') or []) if str(d).strip()],
                'extension': str(p.get('extension', '')).strip(),
            }
            for p in directorio
        ],
    }
    with open(ruta_destino, 'w', encoding='utf-8') as f:
        json.dump(sobre, f, ensure_ascii=False, indent=2)
    return len(sobre['personas'])


def importar_directorio_cartera(ruta_origen):
    """Lee un directorio exportado y devuelve (personas, avisos).

    Acepta DOS formas: el sobre que produce exportar_directorio_cartera y una lista pelada
    de personas. La segunda existe porque el directorio_cartera.json que se genera al
    separar los datos del código es una lista simple, y sería absurdo que la propia app no
    pudiera leer el archivo que ella misma dejó.

    Devuelve avisos en vez de fallar ante cada imperfección: un archivo con una fila sin
    nombre es recuperable, y perder las otras once por eso sería peor que importar once y
    avisar de la que se descartó.
    """
    with open(ruta_origen, 'r', encoding='utf-8') as f:
        datos = json.load(f)

    if isinstance(datos, dict):
        if datos.get('formato') and datos.get('formato') != 'axioma_directorio_cartera':
            raise ValueError("Ese archivo es de otro tipo: no es un directorio de Cartera de Axioma.")
        crudas = datos.get('personas', [])
    elif isinstance(datos, list):
        crudas = datos
    else:
        raise ValueError("El archivo no tiene la estructura esperada.")

    if not isinstance(crudas, list):
        raise ValueError("El archivo no contiene una lista de personas.")

    personas, avisos = [], []
    nombres_vistos = set()
    distritos_vistos = {}

    for i, cruda in enumerate(crudas, 1):
        if not isinstance(cruda, dict):
            avisos.append(f"Fila {i}: se descartó, no tiene la estructura de una persona.")
            continue
        nombre = str(cruda.get('nombre', '')).strip()
        if not nombre:
            avisos.append(f"Fila {i}: se descartó por no tener nombre.")
            continue
        if nombre.lower() in nombres_vistos:
            avisos.append(f"'{nombre}': aparece más de una vez, se conservó la primera.")
            continue
        nombres_vistos.add(nombre.lower())

        distritos = cruda.get('distritos') or []
        if isinstance(distritos, str):
            # Tolerancia deliberada: un archivo editado a mano suele traer
            # "1, 10, 27" como texto en vez de una lista.
            distritos = [d.strip() for d in distritos.split(',')]
        distritos = [str(d).strip() for d in distritos if str(d).strip()]

        for d in distritos:
            clave = d.upper()
            if clave in distritos_vistos and distritos_vistos[clave] != nombre:
                avisos.append(f"Distrito {d}: asignado a '{distritos_vistos[clave]}' y también a "
                              f"'{nombre}'. Axio mostrará al primero.")
            distritos_vistos.setdefault(clave, nombre)

        personas.append({
            'nombre': nombre,
            'cargo': str(cruda.get('cargo', '')).strip(),
            'distritos': distritos,
            'extension': str(cruda.get('extension', '')).strip(),
        })

    if not personas:
        raise ValueError("El archivo no tiene ninguna persona válida para importar.")
    return personas, avisos


# ------------------------------------------------------------------------------
# LÍNEAS DE CRÉDITO (fusionado desde Axio) -- cada una es un listado simple (quién
# tiene el crédito activo, sin montos ni cuotas) publicado en su propia URL,
# configurable desde Configuración. El cruce con un resultado del Buscador (ahora
# Axio) se hace por la CÉDULA del pastor/responsable -- funciona igual para la
# línea congregacional (Congregación) que para las personales (Hipotecario,
# Educativo, etc.), sin depender de que cada hoja traiga columna de código de
# congregación.
#
# 'clave' es un identificador ESTABLE (no cambia aunque se edite el nombre
# visible) -- se usa como llave interna en config.json y en el caché de rosters
# descargados, para que renombrar una línea en Configuración no rompa nada.
# 'nombre' es el que se ve en pantalla. 'url' arranca vacía: cada línea se
# activa sola en cuanto se le pega un link (Google Sheets publicado, o una URL
# directa a un Excel) -- una línea con 'url' vacía simplemente se ignora al
# buscar, sin generar error.
LINEAS_CREDITO_DEFECTO = [
    {"clave": "congregacion", "nombre": "Congregación", "url": ""},
    {"clave": "libreria", "nombre": "Librería", "url": ""},
    {"clave": "seguro_vida", "nombre": "Seguro de Vida", "url": ""},
    {"clave": "hipotecario", "nombre": "Hipotecario (personal)", "url": ""},
    {"clave": "libre_inversion_menor", "nombre": "Libre Inversión Menor", "url": ""},
    {"clave": "libre_inversion_mayor", "nombre": "Libre Inversión Mayor", "url": ""},
    {"clave": "rapicreditos", "nombre": "Rapicréditos", "url": ""},
    {"clave": "educativo", "nombre": "Mi Primera Inversión", "url": ""},
    {"clave": "mobiliario_sillas", "nombre": "Mobiliario y Sillas", "url": ""},
]

# Tarifa/Saldo/Meses en Mora/Observación -- SOLO aplican a Seguro de Vida por ahora
# (confirmado con Cartera). Esta detección de columnas queda restringida a esta
# lista de claves en vez de buscarse en cualquier línea de crédito.
CLAVES_LINEAS_CON_INFO_EXTRA = {'seguro_vida'}

# 'Educativo' se reemplazó por 'Mi Primera Inversión' (esa línea de crédito nunca
# existió de verdad) -- para quien ya tenía config.json guardado ANTES de este
# cambio, se actualiza el nombre visible solo si nunca lo tocó.
_MIGRACIONES_NOMBRE_LINEAS_CREDITO = {('educativo', 'Educativo'): 'Mi Primera Inversión'}


def _migrar_nombres_lineas_credito(config_data):
    for linea in config_data.get('lineas_credito', []):
        nuevo_nombre = _MIGRACIONES_NOMBRE_LINEAS_CREDITO.get((linea.get('clave'), linea.get('nombre')))
        if nuevo_nombre:
            linea['nombre'] = nuevo_nombre


# Nombres alternativos con los que el DISTRITO podría venir escrito en las distintas
# fuentes (Matriz_Nube, cierres guardados) -- se busca en ese orden hasta encontrar una
# columna presente en la fila.
COLUMNAS_DISTRITO_POSIBLES = ['DISTRITO', 'DTO', 'DISTRITO ']

# Igual, pero para Cédula -- se usa en la ventana de detalle para el acceso rápido de
# "Copiar Cédula" (V8.2), pensado para pegarla directo en Siasoft.
COLUMNAS_CEDULA_POSIBLES = ['CEDULA', 'CÉDULA', 'CC']


def _normalizar_distrito(valor):
    """Normaliza un valor de distrito para comparar: mayúsculas, sin espacios de más, y
    sin el '.0' que Excel/pandas le pega a los números que llegaron como float
    (columna DISTRITO numérica -> 9.0 en vez de 9)."""
    texto = str(valor).strip().upper()
    if texto.endswith('.0') and texto[:-2].replace('-', '').isdigit():
        texto = texto[:-2]
    return texto


def obtener_campo_de_fila(fila_dict, nombres_posibles):
    """Busca en la fila (dict columna->valor) el primer campo cuyo nombre de columna
    (normalizado a mayúsculas) esté entre 'nombres_posibles'. Devuelve el valor tal cual
    (sin normalizar, para mostrarlo o copiarlo), o None si ninguna columna de la fuente
    coincide o si coincide pero está vacía."""
    nombres_norm = {n.strip().upper() for n in nombres_posibles}
    for col in fila_dict:
        if str(col).strip().upper() in nombres_norm:
            valor = fila_dict[col]
            if valor is not None and str(valor).strip() not in ('', 'nan', 'NaN'):
                return valor
    return None


# ==============================================================================
# (Propio de Axio independiente -- conviene llevarlo a Axioma)
# COLUMNA DE CÉDULA SIN ENCABEZADO
# ==============================================================================
# EL FALLO QUE RESUELVE: en la Matriz_Nube el encabezado lo escribe gente, a mano. Si la
# celda de encabezado de la cédula queda en blanco -- o con un espacio, que a la vista es
# lo mismo -- la columna llega con el nombre vacío. Nada revienta: la búsqueda sigue
# encontrando la cédula como texto. Pero el detalle de un resultado identifica la cédula
# POR EL NOMBRE de la columna, así que deja de mostrar el botón "Copiar Cédula" y, sobre
# todo, las Líneas de Crédito. Desaparecen sin un solo aviso, y lo que se concluye es que
# esa persona no tiene créditos.
#
# Aquí se reconoce la columna por su CONTENIDO, pero solo en el caso seguro: cuando
# ninguna columna se llama cédula y hay una SIN NOMBRE cuyos valores tienen forma de
# cédula; si hubiera más de una, gana la de más a la izquierda. Una columna con un nombre
# visible cualquiera no se toca jamás: adivinar ahí sería peor que avisar (ver
# aviso_columna_cedula). Y como red debajo, la ventana de detalle busca la cédula fila por
# fila con obtener_cedula_de_fila.
MINIMO_VALORES_PARA_RECONOCER_CEDULA = 20

# Caracteres que son "letras" para Unicode pero que en pantalla no dibujan nada: los
# rellenos que quedan al copiar y pegar desde un chat o una página web.
_RELLENOS_INVISIBLES = 'ㅤᅟᅠﾠ⠀'


def _encabezado_sin_texto(nombre):
    """True si el nombre de columna no tiene ni una letra ni un número VISIBLES: vacío,
    solo espacios (incluidos el espacio duro y los caracteres de ancho cero), solo signos
    ('.', '-', un apóstrofo suelto), el 'Unnamed: 3' que pone pandas a una celda vacía, o
    el '(2)' con que se desambiguan dos columnas sin nombre.

    La primera versión de esta función solo aceptaba espacios, y con la hoja real no
    alcanzó. Un encabezado sin una sola letra ni número no le pone nombre a nada, sea cual
    sea el carácter que lo ocupa."""
    texto = str(nombre)
    if texto.startswith('Unnamed:'):
        return True
    visible = ''.join(c for c in texto if c not in _RELLENOS_INVISIBLES
                      and unicodedata.category(c)[0] not in ('Z', 'C'))
    if visible.lower() in ('nan', 'none') or re.fullmatch(r'\(\d+\)', visible):
        return True
    return not any(c.isalnum() for c in visible)


_PATRON_FECHA = re.compile(r'\d{1,4}\s*[/\-]\s*\d{1,2}\s*[/\-]\s*\d{1,4}')


def _valor_parece_cedula(valor):
    """True si UN valor tiene forma de cédula o NIT: entre 5 y 11 dígitos una vez limpio,
    casi sin letras y sin forma de fecha.

    Se toleran hasta tres letras ('CC 12345678', 'NIT 900555666-7') porque así es como la
    gente escribe una cédula a mano. Las fechas se descartan aparte: '15/07/2026' limpia
    queda en ocho dígitos y pasaría por cédula."""
    if valor is None or (isinstance(valor, float) and pd.isna(valor)):
        return False
    texto = str(valor).strip()
    if not texto or _PATRON_FECHA.search(texto) or ':' in texto:
        return False
    if sum(1 for c in texto if c.isalpha()) > 3:
        return False
    return re.fullmatch(r'\d{5,11}', limpiar_cedula(texto)) is not None


def _parece_columna_de_cedulas(serie):
    """True si la mayoría de los valores de la columna tienen forma de cédula.

    El umbral es 60% a propósito. En una Matriz_Nube real de 34.801 filas la columna de
    cédulas cumple en un 90%: el resto son códigos de congregación de cuatro dígitos y
    pagos sin identificar. La primera versión exigía además que el 95% fuera "puro número"
    y con la hoja real no reconoció la columna -- una regla tan justa se cae con cualquier
    cosa que alguien escriba distinto."""
    valores = serie.dropna()
    valores = valores[valores.astype(str).str.strip() != '']
    if len(valores) < MINIMO_VALORES_PARA_RECONOCER_CEDULA:
        return False
    return valores.map(_valor_parece_cedula).mean() >= 0.60


def obtener_cedula_de_fila(fila_dict):
    """La cédula de una fila, para la ventana de detalle. Devuelve el valor o None.

    Primero por NOMBRE de columna, como siempre. Si ninguna columna se llama cédula, se
    acepta el primer campo SIN NOMBRE cuyo valor tenga forma de cédula.

    Esa segunda parte es una red debajo de asegurar_columna_cedula: aquella decide mirando
    la columna entera y puede no convencerse; esta mira solo la fila que la persona tiene
    abierta. Un campo sin título con un número de cédula adentro ES la cédula -- lo
    contrario, decir "esta fila no tiene cédula" con el número a la vista, no ayuda a nadie."""
    valor = obtener_campo_de_fila(fila_dict, COLUMNAS_CEDULA_POSIBLES)
    if valor is not None:
        return valor
    for columna, candidato in fila_dict.items():
        if _encabezado_sin_texto(columna) and _valor_parece_cedula(candidato):
            return candidato
    return None


def _tiene_columna_cedula(df):
    reconocidas = {n.strip().upper() for n in COLUMNAS_CEDULA_POSIBLES}
    return any(str(c).strip().upper() in reconocidas for c in df.columns)


def asegurar_columna_cedula(df, nombre_cedula='Cedula'):
    """Devuelve el DataFrame con su columna de cédula identificable por nombre.

    Si ya hay una columna de cédula, lo devuelve tal cual. Si no la hay y existe una
    columna SIN NOMBRE que por contenido es la de cédulas, la renombra a 'nombre_cedula',
    limpia sus valores y deja anotado en df.attrs['aviso_cedula'] lo que hizo -- los attrs
    viajan con el DataFrame, también dentro de la copia en disco, así que la pantalla puede
    avisar aunque los datos salgan de la caché.

    Se puede llamar las veces que haga falta: la segunda vez ya no encuentra nada que
    arreglar."""
    if df is None or getattr(df, 'empty', True) or _tiene_columna_cedula(df):
        return df
    for posicion, columna in enumerate(df.columns):
        if not _encabezado_sin_texto(columna) or not _parece_columna_de_cedulas(df[columna]):
            continue
        avisos_previos = dict(df.attrs)
        df = df.rename(columns={columna: nombre_cedula})
        df[nombre_cedula] = df[nombre_cedula].apply(limpiar_cedula)
        df.attrs.update(avisos_previos)
        df.attrs['aviso_cedula'] = (
            f"La columna {get_column_letter(posicion + 1)} de la Matriz_Nube llegó sin encabezado; "
            f"Axio la reconoció como la de Cédula por su contenido. Conviene escribirle "
            f"'CEDULA' en la hoja.")
        logger.warning(df.attrs['aviso_cedula'])
        return df
    return df


def aviso_columna_cedula(df):
    """Texto para mostrar en pantalla sobre la columna de cédula de la Matriz_Nube, o None
    si no hay nada que decir.

    Hay dos casos y los dos tienen que VERSE: que la columna se haya tenido que reconocer
    por contenido (informativo), y que no haya forma de saber cuál es (grave: sin cédula no
    hay líneas de crédito). En el segundo se listan los encabezados que sí llegaron, que es
    lo que hace falta para ir a corregir la hoja."""
    if df is None or getattr(df, 'empty', True):
        return None
    if df.attrs.get('aviso_cedula'):
        return "ℹ️ " + str(df.attrs['aviso_cedula'])
    if _tiene_columna_cedula(df):
        return None
    encabezados = ", ".join("(sin título)" if _encabezado_sin_texto(c) else str(c).strip() for c in list(df.columns)[:10])
    return ("⚠️ Ninguna columna de la Matriz_Nube llegó con el título 'CEDULA'. Axio toma como cédula "
            "el campo sin título de cada fila cuando tiene forma de cédula; para que no dependa de "
            f"eso, escribe CEDULA en el encabezado de la hoja. Títulos que llegaron: {encabezados}.")


def obtener_distrito_de_fila(fila_dict):
    """Busca en la fila (dict columna->valor) el campo de distrito, probando los nombres
    de columna conocidos. Devuelve el valor tal cual (sin normalizar, para mostrarlo) o
    None si la fuente no trae ninguna columna de distrito."""
    return obtener_campo_de_fila(fila_dict, COLUMNAS_DISTRITO_POSIBLES)


def buscar_encargado_cartera(distrito, directorio):
    """Devuelve el dict {'nombre','cargo','distritos','extension'} de quien está a cargo
    de 'distrito' según el Directorio de Cartera, o None si no hay match o el directorio
    está vacío. Comparación normalizada (ver _normalizar_distrito) para no fallar por
    mayúsculas/espacios/ceros de Excel."""
    if distrito is None or not directorio:
        return None
    clave = _normalizar_distrito(distrito)
    if not clave:
        return None
    for persona in directorio:
        for d in persona.get('distritos', []):
            if _normalizar_distrito(d) == clave:
                return persona
    return None


# ==============================================================================
# ESTADO DE PAGO (fusionado desde Axio) -- Matriz_Nube marca cada fila con un
# color según tres casillas (RCW, NOTA CARTERA, NOTA RECAUDO). En vez de leer
# el color real de la celda de Excel (que obligaría a descargar el archivo
# completo en vez del CSV liviano que se usa hoy), se DERIVA el mismo
# resultado mirando esas mismas casillas -- confirmado contra un ejemplo real
# con los 4 casos.
#
# Prioridad (de más a menos urgente): si la fila viene con una referencia
# rota (#N/A en Nombre -- la cédula no coincidió con nadie real) eso manda
# sobre cualquier otra cosa; si no, RCW lleno gana siempre sobre las otras
# dos, tal como confirmó Cartera.
# ==============================================================================
ESTADOS_PAGO_MATRIZ_NUBE = {
    'referencia_erronea': {'clave': 'referencia_erronea', 'etiqueta': 'Referencia no encontrada', 'icono': '⚠️', 'color': '#FF7EB6'},
    'ingresado':          {'clave': 'ingresado',          'etiqueta': 'Ingresado (RWS)',           'icono': '🟢', 'color': '#30D158'},
    'gestion_cartera':    {'clave': 'gestion_cartera',    'etiqueta': 'En gestión de Cartera',     'icono': '🟠', 'color': '#FF9F0A'},
    'pendiente_recaudo':  {'clave': 'pendiente_recaudo',  'etiqueta': 'Pendiente Recaudo',         'icono': '🔴', 'color': '#FF0000'},
}

_VALORES_ERROR_EXCEL = ('#N/A', '#REF!', '#VALUE!', '#NAME?', '#NULL!', '#DIV/0!')


def _buscar_valor_columna_exacta(fila_dict, nombres_exactos):
    """Busca el valor de la PRIMERA columna cuyo nombre (normalizado a
    mayúsculas, sin espacios de más) sea EXACTAMENTE uno de nombres_exactos
    -- a diferencia de obtener_campo_de_fila, aquí NO basta con que el
    nombre CONTENGA el alias. Necesario en Matriz_Nube porque 'NOMBRE' y
    'NOMBRE / TIPO' son columnas DISTINTAS."""
    nombres_norm = {n.strip().upper() for n in nombres_exactos}
    for col, valor in fila_dict.items():
        if str(col).strip().upper() in nombres_norm:
            return valor
    return None


def _buscar_valor_columna_contiene(fila_dict, alias):
    """Busca el valor de la primera columna cuyo nombre CONTIENE 'alias' --
    para columnas con sufijos variables como 'NOTA RECAUDO - <05>'."""
    alias_norm = alias.strip().upper()
    for col, valor in fila_dict.items():
        if alias_norm in str(col).strip().upper():
            return valor
    return None


def _campo_esta_lleno(valor):
    if valor is None:
        return False
    if isinstance(valor, float) and pd.isna(valor):
        return False
    return str(valor).strip() not in ('', 'nan', 'NaN', 'None')


def clasificar_estado_pago(fila_dict):
    """Clasifica una fila de Matriz_Nube según las reglas de Cartera.
    Devuelve un dict de ESTADOS_PAGO_MATRIZ_NUBE, o None si la fuente no
    trae ninguna de estas columnas (no es de Matriz_Nube) o si la fila no
    tiene ninguna de las tres casillas llena (sin gestionar todavía)."""
    columnas_presentes_mayus = {str(c).strip().upper() for c in fila_dict}
    # V8.8: antes esta lista traía 'RCW' fijo. La columna real se llama RWS, así que ese
    # alias no coincidía nunca; la detección se sostenía solo porque 'NOTA CARTERA' y
    # 'NOTA RECAUDO' sí existen -- una fuente que trajera únicamente la columna de recibo
    # no se reconocía como Matriz_Nube en absoluto.
    alias_relevantes = tuple(ALIAS_COLUMNA_RECIBO_NUBE) + ('NOTA CARTERA', 'NOTA RECAUDO')
    tiene_columnas_relevantes = any(
        alias in col for col in columnas_presentes_mayus for alias in alias_relevantes
    )
    if not tiene_columnas_relevantes:
        return None

    def _es_error_excel(v):
        return str(v).strip().upper() in _VALORES_ERROR_EXCEL

    nombre_val = _buscar_valor_columna_exacta(fila_dict, ['NOMBRE'])
    if _es_error_excel(nombre_val):
        return dict(ESTADOS_PAGO_MATRIZ_NUBE['referencia_erronea'])

    # V8.8 (BUG REAL): esto buscaba la columna 'RCW' con nombre EXACTO, pero en la
    # Matriz_Nube se llama 'RWS'. Nunca la encontraba, así que el estado 'ingresado'
    # (verde) NO SE PINTABA JAMÁS -- y como este chequeo es el de mayor prioridad, las
    # filas ya ingresadas caían al siguiente y salían marcadas en rojo (Pendiente
    # Recaudo) o naranja (gestión de Cartera). No era solo un color que faltaba: era un
    # pago ya recibido mostrándose como pendiente.
    if _campo_esta_lleno(_buscar_valor_columna_exacta(fila_dict, list(ALIAS_COLUMNA_RECIBO_NUBE))):
        return dict(ESTADOS_PAGO_MATRIZ_NUBE['ingresado'])
    # Nota Recaudo (rojo) gana sobre Nota Cartera (naranja) si las dos están
    # llenas a la vez -- confirmado por Cartera.
    if _campo_esta_lleno(_buscar_valor_columna_contiene(fila_dict, 'NOTA RECAUDO')):
        return dict(ESTADOS_PAGO_MATRIZ_NUBE['pendiente_recaudo'])
    if _campo_esta_lleno(_buscar_valor_columna_exacta(fila_dict, ['NOTA CARTERA'])):
        return dict(ESTADOS_PAGO_MATRIZ_NUBE['gestion_cartera'])
    return None


def _normalizar_para_busqueda(texto):
    """Deja el texto listo para comparar: mayúsculas, sin tildes y sin separadores.

    Sin esto, buscar '12.345.678' no encuentra '12345678', ni 'RCA-000123' encuentra
    'RCA000123', ni 'Perez' encuentra 'Pérez'. Son el mismo dato escrito distinto, y hoy
    el buscador los trata como cosas diferentes: la persona ve cero resultados y concluye
    que el pago no existe.

    Se quitan puntos, comas, guiones, barras y espacios PORQUE son exactamente los
    caracteres con los que se adorna un número de cédula, de recibo o de cuenta. Lo que
    queda son letras y dígitos, que es la parte que de verdad identifica.
    """
    t = unicodedata.normalize('NFD', str(texto).upper())
    t = ''.join(c for c in t if unicodedata.category(c) != 'Mn')
    return re.sub(r'[.\-,/\s_$#()]', '', t)


# Nombres de columna que contienen DINERO. Se usa solo para los rangos.
#
# Motivo, encontrado probando: buscar '>800000' devolvía filas cuyo débito era de mil
# pesos, porque la coincidencia caía en la CÉDULA -- 45678901 es efectivamente mayor que
# 800000. Como número está bien; como respuesta a "mostrame los movimientos de más de
# ochocientos mil" es basura. Un rango es una pregunta sobre plata, así que se limita a las
# columnas de plata. La búsqueda de un valor EXACTO no se toca.
PALABRAS_COLUMNA_DINERO = ('DEBITO', 'CREDITO', 'VALOR', 'MONTO', 'SALDO', 'IMPORTE',
                           'ABONO', 'CARGO', 'PAGO', 'TOTAL')


def _es_columna_de_dinero(nombre):
    n = str(nombre).upper()
    return any(p in n for p in PALABRAS_COLUMNA_DINERO)


def _detectar_rango(termino):
    """Reconoce '500000-700000', '>1000000' y '<50000'. Devuelve (min, max) o None.

    Existe porque muchas veces no se recuerda la cifra exacta -- se sabe que fue "como
    seiscientos mil". Buscar el valor exacto obliga a adivinar; un rango encuentra igual.

    Ojo con el guion: '500000-700000' es un rango, pero 'RCA-000123' no lo es. Por eso se
    exige que AMBOS lados sean solo dígitos y separadores de miles.
    """
    t = str(termino).strip()
    m = re.fullmatch(r'([<>])\s*\$?\s*([\d.,]+)', t)
    if m:
        valor = parse_money(m.group(2))
        if valor:
            return (valor, float('inf')) if m.group(1) == '>' else (float('-inf'), valor)
    m = re.fullmatch(r'\$?\s*([\d.,]+)\s*-\s*\$?\s*([\d.,]+)', t)
    if m:
        a, b = parse_money(m.group(1)), parse_money(m.group(2))
        if a and b:
            return (min(a, b), max(a, b))
    return None


def _detectar_termino_numerico(termino):
    """Si el término se ve como un MONTO, devuelve su valor; si se ve como una cédula, None.

    POR QUÉ HAY QUE DISTINGUIRLOS: escribir '1099000333' hacía que Axioma anunciara
    "buscando $1.099.000.333" y comparara contra todas las columnas de dinero. Pero un
    número de diez dígitos sin separadores es una cédula colombiana, no mil millones de
    pesos. Además de ensuciar el mensaje, ese trabajo extra cuesta -- medido, 335 ms contra
    14 ms en una Matriz_Nube de 30.000 filas: comparar contra columnas de dinero que nunca
    van a coincidir es 24 veces más lento que no hacerlo.

    LA REGLA ES CONSERVADORA A PROPÓSITO. Solo se descarta como monto cuando el número
    viene PELADO -- sin puntos, comas ni signo peso-- y tiene entre 7 y 11 dígitos, que es
    el rango de las cédulas y los NIT colombianos. Cualquier cosa con separador
    ('1.099.000.333', '$1099000333', '2.500.000') se sigue tratando como plata, porque
    escribir los puntos es justamente lo que hace alguien que está pensando en un importe.
    """
    termino_limpio = termino.strip()
    if not (termino_limpio and re.fullmatch(r'[\d.,\s$]+', termino_limpio)
            and any(c.isdigit() for c in termino_limpio)):
        return None

    if re.fullmatch(r'\d{7,11}', termino_limpio):
        # Número pelado en rango de cédula: no se busca como monto. Si de verdad era un
        # importe, sigue encontrándose por TEXTO en cualquier columna que lo contenga.
        return None

    valor = parse_money(termino_limpio)
    return valor if valor != 0.0 else None


def procesar_terminos_busqueda(termino):
    """Divide el texto de búsqueda en varios términos separados por espacio (V5.2) --
    TODOS deben aparecer en la fila (lógica Y, no necesariamente en la misma columna) para
    que cuente como resultado. Cada término se analiza aparte: si se ve como un monto,
    también se compara por su valor numérico real, no solo como texto."""
    terminos = []
    for t in str(termino).strip().split():
        rango = _detectar_rango(t)
        terminos.append({
            'original': t,
            'norm': t.upper(),
            # V10.3: forma normalizada, que es contra la que se compara de verdad.
            # Un rango NO lleva forma de texto: '500000-700000' como cadena no existe en
            # ninguna celda, y buscarlo además por texto daría siempre cero.
            'plano': '' if rango else _normalizar_para_busqueda(t),
            'numerico': None if rango else _detectar_termino_numerico(t),
            'rango': rango,
        })
    return [t for t in terminos if t['plano'] or t['numerico'] is not None or t['rango']]


def _columnas_unicas(df):
    """Devuelve el DataFrame con nombres de columna irrepetibles ('Detalle', 'Detalle (2)').

    Con dos columnas del mismo nombre, df[col] ya no es una Serie sino un DataFrame, y
    todo lo que sigue (.str, .dt, to_numeric) revienta -- era el error
    "'DataFrame' object has no attribute 'str'" del buscador. Pasa cuando la Matriz_Nube
    trae, por ejemplo, 'Banco' y 'Detalle': el renombrado por alias convertía 'Banco' en
    'Detalle' y chocaba con la que ya existía. Si no hay duplicados devuelve el mismo
    objeto sin copiar nada.
    """
    if df is None or not df.columns.duplicated().any():
        return df
    vistos = {}
    nuevas = []
    for c in df.columns:
        nombre = str(c)
        vistos[nombre] = vistos.get(nombre, 0) + 1
        nuevas.append(nombre if vistos[nombre] == 1 else f"{nombre} ({vistos[nombre]})")
    # Un 'Detalle (2)' que ya existiera de origen también chocaría: se repasa hasta que no
    # quede ninguno repetido.
    while len(set(nuevas)) != len(nuevas):
        conteo = {}
        for i, n in enumerate(nuevas):
            conteo[n] = conteo.get(n, 0) + 1
            if conteo[n] > 1:
                nuevas[i] = f"{n} ({conteo[n]})"
    df = df.copy()
    df.columns = nuevas
    return df


def _matriz_normalizada(df):
    """Devuelve el DataFrame convertido a texto normalizado, columna por columna.

    Es la pieza que hace rápida la búsqueda. La versión anterior recorría el DataFrame con
    iterrows() y comparaba CELDA POR CELDA en Python puro: con una Matriz_Nube de 20.000
    filas y 9 columnas son 180.000 comparaciones interpretadas, medidas en 1,3 segundos
    POR BÚSQUEDA -- y eso multiplicado por cada hoja de cada archivo.

    Pandas hace exactamente lo mismo vectorizado, en C. La normalización se aplica con
    str.replace sobre la columna entera en vez de carácter por carácter.
    """
    df = _columnas_unicas(df)
    normalizada = pd.DataFrame(index=df.index)
    for col in df.columns:
        serie = df[col]
        if pd.api.types.is_datetime64_any_dtype(serie):
            # Las fechas se dejan en formato día/mes/año además del ISO: alguien que busca
            # "15/07/2026" no debería quedarse sin resultados porque internamente sea un
            # Timestamp.
            texto = serie.dt.strftime('%d/%m/%Y').fillna('') + serie.dt.strftime('%Y-%m-%d').fillna('')
        else:
            texto = serie.astype(str)

        # fillna('') ANTES de la cadena .str, y no es cosmético.
        #
        # Cuando una columna viene ENTERAMENTE vacía -- 'Nota Cartera' o 'Nota Recaudo' en
        # un mes donde nadie escribió nada-- astype(str) deja los nulos como NaN en vez de
        # convertirlos a la cadena "nan". Tras .str.encode() la serie completa se degrada a
        # tipo flotante, y la siguiente llamada .str explota con
        # "Can only use .str accessor with string values, not floating". Toda la búsqueda
        # fallaba por una columna sin datos.
        #
        # Se fuerza además el tipo texto: si pandas dedujo float para una columna de puros
        # nulos, .str no existe todavía en ese punto.
        texto = texto.fillna('').astype('object').astype(str)
        texto = (texto.str.upper()
                      .str.normalize('NFKD').str.encode('ascii', 'ignore').str.decode('ascii')
                      .fillna('')
                      .str.replace(r'[.\-,/\s_$#()]', '', regex=True))
        # 'nan' y 'nat' son artefactos de convertir un nulo a texto, no contenido real. Sin
        # esto, buscar "NA" traería todas las filas con celdas vacías.
        normalizada[col] = texto.replace({'NAN': '', 'NAT': '', 'NONE': ''})
    return normalizada


def _numerica_de(df):
    """Versión numérica de las columnas que se pueden interpretar como montos."""
    df = _columnas_unicas(df)
    numerica = {}
    for col in df.columns:
        serie = df[col]
        if pd.api.types.is_numeric_dtype(serie) and not pd.api.types.is_bool_dtype(serie):
            numerica[col] = serie.astype(float)
        elif serie.dtype == object:
            convertida = pd.to_numeric(
                serie.fillna('').astype('object').astype(str)
                     .str.replace(r'[^\d,.\-]', '', regex=True)
                     .str.replace('.', '', regex=False).str.replace(',', '.', regex=False),
                errors='coerce')
            if convertida.notna().any():
                numerica[col] = convertida
    return numerica


def _fila_coincide_todos(fila_dict, terminos):
    """Igual que antes pero comparando en forma normalizada. Se conserva porque la usan
    otras partes y las pruebas; el camino rápido es _extraer_coincidencias."""
    columnas_match = set()
    for t in terminos:
        columna_de_este = None
        for col, v in fila_dict.items():
            if v is None or v == '' or (isinstance(v, float) and pd.isna(v)):
                continue
            if t['plano'] and t['plano'] in _normalizar_para_busqueda(v):
                columna_de_este = col
                break
            if t['numerico'] is not None:
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    if abs(float(v) - t['numerico']) < 0.01:
                        columna_de_este = col
                        break
                elif isinstance(v, str):
                    v_num = parse_money(v)
                    if v_num != 0.0 and abs(v_num - t['numerico']) < 0.01:
                        columna_de_este = col
                        break
        if columna_de_este is None:
            return False, set()
        columnas_match.add(columna_de_este)
    return True, columnas_match


def _extraer_coincidencias(df, terminos, fuente, limite_por_fuente=LIMITE_RESULTADOS_POR_FUENTE,
                           cache_normalizado=None, clave_cache=None):
    """Devuelve (resultados, total_encontrado), buscando de forma VECTORIZADA.

    'total_encontrado' es SIEMPRE el número real de coincidencias, aunque se devuelvan
    menos: el recorte es para la pantalla, no para el conteo.

    'cache_normalizado' permite reusar la conversión a texto normalizado entre búsquedas.
    Sin él, escribir tres veces en el buscador vuelve a convertir el mismo DataFrame tres
    veces, que es la parte cara de todo esto.
    """
    if df is None or df.empty or not terminos:
        return [], 0
    df = _columnas_unicas(df)

    if cache_normalizado is not None and clave_cache is not None and clave_cache in cache_normalizado:
        normalizada, numerica = cache_normalizado[clave_cache]
    else:
        normalizada = _matriz_normalizada(df)
        numerica = _numerica_de(df)
        if cache_normalizado is not None and clave_cache is not None:
            cache_normalizado[clave_cache] = (normalizada, numerica)

    columnas = [str(c) for c in df.columns]
    # Máscara acumulada: arranca en "todas las filas sirven" y cada término la va
    # recortando. Es la lógica Y de siempre, pero resuelta en bloque.
    mascara_total = pd.Series(True, index=df.index)
    columnas_por_termino = []

    for t in terminos:
        mascara_termino = pd.Series(False, index=df.index)
        cols_de_este = {}
        if t['plano']:
            for col in df.columns:
                m = normalizada[col].str.contains(t['plano'], regex=False, na=False)
                if m.any():
                    cols_de_este[col] = m
                    mascara_termino |= m
        if t.get('rango'):
            lo, hi = t['rango']
            # Solo columnas de dinero; si el archivo no tiene ninguna reconocible, se cae a
            # todas las numéricas antes que no devolver nada.
            columnas_dinero = [c for c in numerica if _es_columna_de_dinero(c)] or list(numerica)
            for col in columnas_dinero:
                serie_num = numerica[col]
                m = (serie_num >= lo) & (serie_num <= hi)
                if m.any():
                    cols_de_este[col] = cols_de_este.get(col, m) | m
                    mascara_termino |= m
        elif t['numerico'] is not None:
            for col, serie_num in numerica.items():
                m = (serie_num - t['numerico']).abs() < 0.01
                if m.any():
                    cols_de_este[col] = cols_de_este.get(col, m) | m
                    mascara_termino |= m
        mascara_total &= mascara_termino
        columnas_por_termino.append(cols_de_este)
        if not mascara_total.any():
            return [], 0

    indices = df.index[mascara_total]
    total = len(indices)
    if total == 0:
        return [], 0

    # Solo se materializan a diccionario las filas que se van a devolver. Antes se armaba
    # un dict por CADA fila del archivo, coincidiera o no.
    recorte = indices[:limite_por_fuente]
    sub = df.loc[recorte]
    resultados = []
    for pos, (idx, fila) in enumerate(sub.iterrows()):
        cols_match = set()
        for cols_de_este in columnas_por_termino:
            for col, m in cols_de_este.items():
                if m.loc[idx]:
                    cols_match.add(str(col))
                    break
        resultados.append({
            'fuente': fuente,
            'columnas': columnas,
            'fila': {str(c): fila.get(c, '') for c in df.columns},
            'columnas_coincidentes': cols_match,
        })
    return resultados, total


def _clave_orden_valor(valor):
    """Clave de orden para .sort() al hacer clic en un encabezado de columna (V8.4).
    Agrupa por TIPO en un 'bucket' (fecha < número < texto < vacío) -- así nunca se
    comparan tipos incompatibles entre sí (Python no deja comparar str contra float
    directamente). Dentro de cada bucket ordena por el valor REAL (fecha real, número
    real, o texto en mayúsculas), no como string plano -- para que 900 quede antes que
    1200 en vez de después, como pasaría ordenando alfabéticamente. Los vacíos
    siempre van al final sin importar el sentido del orden."""
    if valor is None or (isinstance(valor, float) and pd.isna(valor)) or str(valor).strip() == '':
        return (3, 0)
    if isinstance(valor, (pd.Timestamp, datetime)):
        return (0, valor)
    if isinstance(valor, (int, float)) and not isinstance(valor, bool):
        return (1, float(valor))
    texto = str(valor).strip()
    numero = parse_money(texto)
    if numero != 0.0:
        return (1, numero)
    return (2, texto.upper())


def _formatear_valor_celda(v):
    """Formatea un valor de celda para mostrar en la tabla de resultados: fechas como
    dd/mm/aaaa, números con separador de miles, vacíos/NaN como texto vacío."""
    if v is None:
        return ""
    if isinstance(v, float) and pd.isna(v):
        return ""
    if isinstance(v, (pd.Timestamp, datetime)):
        return v.strftime('%d/%m/%Y')
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, int):
        return f"{v:,}"
    if isinstance(v, float):
        return f"{v:,.0f}" if v == int(v) else f"{v:,.2f}"
    return str(v)


# Ancho medio de carácter por fuente, para descartar sin medir. Se calcula una vez por
# fuente y se guarda: pedirle a Tk el ancho de un texto es una llamada al motor gráfico y
# es MUCHO más cara que una multiplicación.
_ANCHO_MEDIO_CARACTER = {}


def _ancho_medio(fuente_tk):
    clave = id(fuente_tk)
    if clave not in _ANCHO_MEDIO_CARACTER:
        muestra = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,-/"
        _ANCHO_MEDIO_CARACTER[clave] = fuente_tk.measure(muestra) / len(muestra)
    return _ANCHO_MEDIO_CARACTER[clave]


def _truncar_para_ancho(texto, ancho_max_px, fuente_tk):
    """Recorta 'texto' para que quepa en ancho_max_px, midiendo con la fuente real.

    V10.4 -- ESTO ERA EL CUELLO DE BOTELLA DE TODO EL BUSCADOR. La versión anterior
    quitaba UN CARÁCTER A LA VEZ y llamaba a fuente.measure() en cada vuelta. Cada measure()
    es una llamada al motor gráfico de Tk, así que una celda de 45 caracteres que hay que
    recortar a 20 costaba 25 llamadas. Multiplicado por 25 columnas y por cada fila:
    medido, 300 filas tardaban 171 SEGUNDOS solo en recortar texto. Al subir el tope de
    resultados de 300 a 5.000 eso pasó de lento a inusable -- minutos de espera con la
    ventana congelada.

    Ahora son dos pasos:
      1. Descarte por estimación. La inmensa mayoría de las celdas son claramente más
         cortas que el ancho disponible; con el ancho medio de carácter se resuelven SIN
         una sola llamada a measure().
      2. Cuando sí hay que recortar, búsqueda binaria en vez de uno por uno: unas 6
         llamadas en lugar de 25, y el número no crece con el largo del texto.
    """
    if not texto:
        return texto
    medio = _ancho_medio(fuente_tk)
    # Si ni en el peor caso llega al límite, cabe seguro: ni se mide.
    if len(texto) * medio * 1.35 <= ancho_max_px:
        return texto
    if fuente_tk.measure(texto) <= ancho_max_px:
        return texto

    # Recorte estimado primero: se calcula cuántos caracteres ENTRAN según el ancho medio
    # y se corta ahí de una. Después basta ajustar un poco, casi siempre en una o dos
    # mediciones. La búsqueda binaria pura hacía unas siete por celda, y con 125.000 celdas
    # esa diferencia es la que decide entre una tabla que aparece y una que congela la app.
    estimado = max(1, int(ancho_max_px / medio) - 1)
    recorte = texto[:estimado]
    while recorte and fuente_tk.measure(recorte + "…") > ancho_max_px:
        # Se quitan de a varios: si la estimación se pasó, se pasó por poco.
        recorte = recorte[:-2] if len(recorte) > 2 else recorte[:-1]
    return (recorte + "…") if recorte else "…"


def _calcular_anchos_columnas(columnas, filas_formateadas, fuente_tk, ancho_min=90, ancho_max=260, relleno=24):
    """V8.4: ancho de columna DINÁMICO según el contenido real -- antes todas las
    columnas medían lo mismo (ANCHO_COL fijo, 150px), así que un DISTRITO de 2
    caracteres ocupaba lo mismo que una DESCRIPCIÓN larga (que se truncaba igual de
    agresivo). Ahora cada columna mide lo que necesita su valor MÁS ANCHO (encabezado
    incluido), acotado entre ancho_min y ancho_max para que una celda gigante no se
    coma toda la pantalla. 'filas_formateadas' es una lista de dicts columna->texto YA
    formateado con _formatear_valor_celda (para medir lo que realmente se va a
    dibujar, no el valor crudo)."""
    # V10.4: se mide una MUESTRA, no todas las filas. Medir 5.000 filas por 25 columnas son
    # 125.000 llamadas al motor gráfico solo para decidir un ancho que además está acotado
    # entre ancho_min y ancho_max. Con 400 filas el ancho elegido es prácticamente el mismo
    # -- y si alguna celda fuera del muestreo resulta más larga, se trunca al dibujarla,
    # que es exactamente lo que ya pasaba con las que superan ancho_max.
    #
    # Además se preselecciona por LARGO DE TEXTO antes de medir: dentro de una columna, la
    # celda más ancha casi siempre es la que más caracteres tiene, así que basta medir las
    # pocas candidatas más largas en vez de todas.
    muestra = filas_formateadas[:400]
    anchos = []
    for col in columnas:
        ancho_col = fuente_tk.measure(str(col)) + relleno
        textos = [f.get(col, '') for f in muestra]
        textos = [t for t in textos if t]
        if textos:
            candidatas = sorted(textos, key=len, reverse=True)[:12]
            for texto in candidatas:
                ancho_texto = fuente_tk.measure(texto) + relleno
                if ancho_texto > ancho_col:
                    ancho_col = ancho_texto
                if ancho_col >= ancho_max:
                    break   # ya está tope, no tiene sentido seguir midiendo
        anchos.append(max(ancho_min, min(ancho_max, ancho_col)))
    return anchos


def buscar_comprobante_global(termino, df_global=None, carpeta_salida=None, max_archivos=25, progress_callback=None, cache_archivos=None, cache_normalizado=None, usar_indice=True):
    """Devuelve (resultados, totales_por_fuente). 'resultados' es la lista de coincidencias
    (cada una con 'fuente', 'columnas', 'fila', 'columnas_coincidentes'), cruzando
    Matriz_Nube y los cierres .xlsx guardados en disco. 'totales_por_fuente' es un dict
    {fuente: total_real_encontrado} -- útil para avisar si se está mostrando menos de lo
    que en realidad hay (ver _extraer_coincidencias). Si se escriben varios términos
    separados por espacio, TODOS deben aparecer en la fila (no necesariamente en la misma
    columna). Además de texto, busca por VALOR si algún término se ve como un monto. Nunca
    lanza excepción por un archivo dañado o bloqueado -- lo salta y sigue.

    'cache_archivos' (fusionado desde Axio), si se pasa, es un dict persistente
    entre búsquedas {(ruta_archivo, nombre_hoja): (mtime, DataFrame)} -- una
    hoja solo se vuelve a leer de disco si el archivo cambió de verdad
    (comparando su fecha de modificación); si no cambió, se reusa el
    DataFrame ya en memoria. Sin esto (cache_archivos=None), se comporta
    igual que antes: lee todo de cero en cada llamada."""
    terminos = procesar_terminos_busqueda(termino)
    if not terminos:
        return [], {}
    resultados = []
    totales_por_fuente = {}

    if df_global is not None and not df_global.empty:
        if progress_callback: progress_callback("Buscando en Matriz_Nube (revisando todos los meses)...")
        encontrados, total = _extraer_coincidencias(df_global, terminos, "Matriz_Nube",
                                                    cache_normalizado=cache_normalizado,
                                                    clave_cache="Matriz_Nube")
        resultados.extend(encontrados)
        if total > 0:
            totales_por_fuente["Matriz_Nube"] = total

    # V10.5: los cierres locales salen del ÍNDICE, no de abrir los Excel uno por uno.
    #
    # Leer los archivos costaba unos 4 segundos con 25 cierres, y esos 4 segundos volvían
    # cada vez que se abría la aplicación porque la caché era de memoria. Por eso el
    # interruptor decía "(más lento)" y estaba apagado. Con el índice en SQLite, el costo
    # se paga UNA vez y después buscar en todo el histórico es una consulta.
    #
    # El camino viejo se conserva bajo usar_indice=False: si el índice fallara o quedara a
    # medias, la búsqueda tiene que poder seguir funcionando leyendo los archivos.
    if usar_indice and carpeta_salida and os.path.isdir(carpeta_salida):
        try:
            from axio.dominio.indice import buscar_en_indice, indexar_carpeta
            if progress_callback:
                progress_callback("Revisando cierres locales...")
            indexar_carpeta(carpeta_salida, HOJAS_BUSCABLES,
                            _matriz_normalizada, _numerica_de,
                            max_archivos=max_archivos, progress_callback=progress_callback)
            encontrados_idx, totales_idx = buscar_en_indice(terminos, limite=LIMITE_RESULTADOS_POR_FUENTE)
            resultados.extend(encontrados_idx)
            totales_por_fuente.update(totales_idx)
            return resultados, totales_por_fuente
        except Exception:
            logger.exception("El índice de cierres falló; se leen los archivos directamente")

    if carpeta_salida and os.path.isdir(carpeta_salida):
        archivos = [f for f in os.listdir(carpeta_salida) if f.lower().endswith('.xlsx') and not f.startswith('~$')]
        archivos.sort(key=lambda f: os.path.getmtime(os.path.join(carpeta_salida, f)), reverse=True)
        archivos = archivos[:max_archivos]
        for i, nombre_archivo in enumerate(archivos):
            if progress_callback: progress_callback(f"Buscando en {nombre_archivo} ({i+1}/{len(archivos)})...")
            ruta_archivo = os.path.join(carpeta_salida, nombre_archivo)
            try:
                mtime_actual = os.path.getmtime(ruta_archivo)
                xls = None  # se abre perezosamente -- si TODAS las hojas de este archivo ya están en caché vigente, nunca se llega a abrir
                for nombre_hoja in HOJAS_BUSCABLES:
                    clave_cache = (ruta_archivo, nombre_hoja)
                    cacheado = cache_archivos.get(clave_cache) if cache_archivos is not None else None
                    if cacheado is not None and cacheado[0] == mtime_actual:
                        df_hoja = cacheado[1]
                    else:
                        if xls is None:
                            xls = pd.ExcelFile(ruta_archivo)  # se abre UNA sola vez por archivo, no una vez por hoja
                        if nombre_hoja not in xls.sheet_names:
                            continue
                        df_hoja = xls.parse(nombre_hoja)
                        if cache_archivos is not None:
                            cache_archivos[clave_cache] = (mtime_actual, df_hoja)
                    fuente_hoja = f"{nombre_archivo} · {nombre_hoja}"
                    # La clave incluye el mtime: si el archivo cambió, la versión
                    # normalizada guardada queda obsoleta y hay que rehacerla. Sin el
                    # mtime, editar un cierre y volver a buscar seguiría mostrando lo
                    # viejo -- un resultado desactualizado sin ninguna señal.
                    encontrados, total = _extraer_coincidencias(
                        df_hoja, terminos, fuente_hoja,
                        cache_normalizado=cache_normalizado,
                        clave_cache=(ruta_archivo, nombre_hoja, mtime_actual))
                    resultados.extend(encontrados)
                    if total > 0:
                        totales_por_fuente[fuente_hoja] = total
            except Exception:
                logger.exception(f"No se pudo leer '{nombre_archivo}' durante la búsqueda global (se omite)")
                continue

    return resultados, totales_por_fuente


def _parecido(a, b):
    """De 0 a 100, cuánto se parecen dos textos ya normalizados. Con rapidfuzz si está; si
    no (la versión de navegador no lo trae), con difflib, que da la misma medida."""
    if fuzz is not None:
        return fuzz.ratio(a, b)
    return difflib.SequenceMatcher(None, a, b).ratio() * 100


def _mas_parecido(objetivo, candidatos, minimo):
    """(el candidato más parecido a 'objetivo', su puntaje) o (None, 0) si ninguno llega a
    'minimo'. Con difflib descarta primero por las cotas baratas, como get_close_matches."""
    mejor, mejor_puntaje = None, 0
    comparador = difflib.SequenceMatcher(None, '', objetivo) if fuzz is None else None
    for candidato in candidatos:
        if comparador is not None:
            comparador.set_seq1(candidato)
            if (comparador.real_quick_ratio() * 100 < max(minimo, mejor_puntaje)
                    or comparador.quick_ratio() * 100 < max(minimo, mejor_puntaje)):
                continue
            p = comparador.ratio() * 100
        else:
            p = fuzz.ratio(objetivo, candidato)
        if p > mejor_puntaje:
            mejor, mejor_puntaje = candidato, p
    return (mejor, mejor_puntaje) if mejor_puntaje >= minimo else (None, 0)


def _vocabulario_palabras(df_global, cache=None):
    """{palabra normalizada: [palabra como está escrita, en cuántos valores distintos sale]}
    con todas las palabras de texto de la hoja (nombres, bancos, detalles). Se arma una vez
    por versión de los datos."""
    if cache is not None and cache.get('df') is df_global:
        return cache['vocabulario']
    vocabulario = {}
    for col in df_global.columns:
        serie = df_global[col]
        if not (serie.dtype == object or pd.api.types.is_string_dtype(serie)):
            continue
        for v in serie.dropna().astype(str).unique():
            for palabra in v.split():
                plano = _normalizar_para_busqueda(palabra)
                if len(plano) < 3 or plano.isdigit():
                    continue
                if plano in vocabulario:
                    vocabulario[plano][1] += 1
                else:
                    vocabulario[plano] = [palabra.strip('.,;:()'), 1]
    if cache is not None:
        cache['df'], cache['vocabulario'] = df_global, vocabulario
    return vocabulario


def _distancia(a, b, tope):
    """Cuántas letras hay que cambiar, poner o quitar para pasar de 'a' a 'b' (Levenshtein),
    o tope + 1 en cuanto se sabe que pasa del tope."""
    if abs(len(a) - len(b)) > tope:
        return tope + 1
    anterior = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        actual = [i]
        for j, cb in enumerate(b, 1):
            actual.append(min(anterior[j] + 1, actual[j - 1] + 1, anterior[j - 1] + (ca != cb)))
        if min(actual) > tope:
            return tope + 1
        anterior = actual
    return anterior[-1]


def corregir_palabras(termino, df_global=None, cache=None):
    """'Jesus Nio' -> 'Jesus Niño', o None si no hay nada que corregir. Cada palabra que no
    existe tal cual en la hoja se cambia por la que sí existe a una letra de distancia (a dos
    si la palabra es larga). Por letras y no por porcentaje: en 'Gomes'/'Gomez' una letra es
    el 20 % de la palabra. Las cifras y las palabras cortas no se tocan: una cédula con un
    dígito cambiado es OTRA persona, no un error de dedo."""
    if df_global is None or df_global.empty:
        return None
    try:
        vocabulario = _vocabulario_palabras(_columnas_unicas(df_global), cache)
        palabras, cambiadas = str(termino).split(), 0
        for i, palabra in enumerate(palabras):
            plano = _normalizar_para_busqueda(palabra)
            if len(plano) < 4 or any(c.isdigit() for c in plano) or plano in vocabulario:
                continue
            # La más cercana; entre las igual de cercanas, la que más sale en la hoja.
            tope = 1 if len(plano) < 8 else 2
            mejor, mejor_clave = None, (tope + 1, 0)
            for candidato, (_, veces) in vocabulario.items():
                d = _distancia(plano, candidato, tope)
                if d <= tope and (d, -veces) < mejor_clave:
                    mejor, mejor_clave = candidato, (d, -veces)
            if mejor is None:
                return None
            palabras[i] = vocabulario[mejor][0]
            cambiadas += 1
        return " ".join(palabras) if cambiadas else None
    except Exception:
        logger.exception("Fallo corrigiendo las palabras de la búsqueda")
        return None


def sugerir_termino_parecido(termino, df_global=None, limite_valores=40000, cache=None):
    """Cuando la búsqueda no encuentra nada, propone el valor más parecido que sí existe.

    Hoy una búsqueda sin resultados es un callejón: no se sabe si el pago no existe, si se
    escribió mal la cédula o si falta un dígito. Con rapidfuzz -- que ya está instalado y
    lo usa el motor de conciliación-- se puede responder "no encontré 'BANCOLOMIA', ¿será
    'BANCOLOMBIA'?". Primero se compara con celdas enteras; si no, palabra por palabra
    (ver corregir_palabras), para nombres con una letra mal: 'Jesus Nio' -> 'Jesus Niño'.

    Solo se ofrece con parecido MUY alto (85+). Una sugerencia floja es peor que ninguna:
    manda a buscar por un camino equivocado con aire de certeza.
    """
    if df_global is None or df_global.empty:
        return None
    df_global = _columnas_unicas(df_global)
    objetivo = _normalizar_para_busqueda(termino)
    if len(objetivo) < 4:
        # Con menos de cuatro caracteres casi cualquier cosa se parece a casi todo.
        return None
    try:
        candidatos = {}
        for col in df_global.columns:
            serie = df_global[col]
            if not (serie.dtype == object or pd.api.types.is_string_dtype(serie)):
                continue
            for v in serie.dropna().astype(str).unique()[:limite_valores // max(len(df_global.columns), 1)]:
                plano = _normalizar_para_busqueda(v)
                if plano and abs(len(plano) - len(objetivo)) <= 4:
                    candidatos.setdefault(plano, v)
            if len(candidatos) > limite_valores:
                break
        mejor, _ = _mas_parecido(objetivo, candidatos, 85)
        if mejor is not None:
            return candidatos[mejor]
        return corregir_palabras(termino, df_global, cache)
    except Exception:
        logger.exception("Fallo buscando un término parecido")
        return None


def generar_excel_resultados_busqueda(termino, resultados, ruta_salida):
    """Exporta los resultados del Buscador Global a Excel: una hoja por cada fuente
    (Matriz_Nube, o cada archivo/hoja de cierre), respetando sus columnas reales -- mismo
    agrupamiento que ya se ve en pantalla."""
    wb = Workbook()
    wb.remove(wb.active)
    negrita = Font(bold=True)
    gris = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")

    grupos = {}
    for r in resultados:
        grupos.setdefault(r['fuente'], {'columnas': r['columnas'], 'filas': []})
        grupos[r['fuente']]['filas'].append(r['fila'])

    for fuente, datos in grupos.items():
        nombre_hoja = re.sub(r'[\\/*?:\[\]]', '_', fuente)[:31] or "Resultados"
        base_nombre, sufijo = nombre_hoja, 1
        while nombre_hoja in wb.sheetnames:
            sufijo += 1
            nombre_hoja = f"{base_nombre[:28]}_{sufijo}"
        ws = wb.create_sheet(nombre_hoja)
        for j, col in enumerate(datos['columnas'], start=1):
            c = ws.cell(row=1, column=j, value=str(col))
            c.font = negrita; c.fill = gris
        for i, fila in enumerate(datos['filas'], start=2):
            for j, col in enumerate(datos['columnas'], start=1):
                valor = fila.get(col, '')
                ws.cell(row=i, column=j, value=valor if not (isinstance(valor, float) and pd.isna(valor)) else '')
        for j, col in enumerate(datos['columnas'], start=1):
            ws.column_dimensions[get_column_letter(j)].width = max(12, min(40, len(str(col)) + 4))

    if not wb.sheetnames:
        wb.create_sheet("Resultados").cell(row=1, column=1, value=f"Sin resultados para '{termino}'")

    wb.save(ruta_salida)


# ==============================================================================
# MATRIZ_NUBE -- descarga y normalización de la base en la nube (Google Sheets
# publicado, o una URL/ruta directa a un Excel).
# ==============================================================================
def descargar_base_global(url, config):
    if not url or url.strip() == "": raise ValueError("URL de Base Global no configurada.")
    try:
        if "docs.google.com/spreadsheets" in url:
            gid = ""
            if "gid=" in url:
                gid_num = url.split("gid=")[1].split("&")[0]
                gid = f"&gid={gid_num}"
            url_csv = re.sub(r'/edit.*$', '/export?format=csv' + gid, url)
            # low_memory=False: sin esto pandas lee el CSV por bloques y deduce el tipo
            # de cada columna bloque a bloque. Cuando una columna mezcla números y texto
            # -- muy normal en la Matriz_Nube, donde una columna suelta trae celdas vacías
            # y códigos -- avisa con un DtypeWarning y, peor, puede terminar con la misma
            # columna en dos tipos distintos según dónde caiga el corte. Leyendo de una
            # sola vez el tipo es consistente y el aviso desaparece.
            df = pd.read_csv(url_csv, low_memory=False)
        else:
            todas_las_hojas = pd.read_excel(url, sheet_name=None)
            df = todas_las_hojas["1"] if "1" in todas_las_hojas else list(todas_las_hojas.values())[0]
                
        keywords = ['FECH', 'FEC', 'DATE', 'CEDULA', 'VALOR', 'MONTO', 'CREDIT', 'DEBITO', 'BANCO']
        cols_upper = df.columns.astype(str).str.upper()
        if sum(1 for k in keywords if any(k in c for c in cols_upper)) < 2:
            max_matches = 0
            best_idx = -1
            for i in range(min(30, len(df))):
                fila_str = df.iloc[i].astype(str).str.upper()
                matches = sum(1 for k in keywords if any(k in c for c in fila_str))
                if matches > max_matches:
                    max_matches = matches
                    best_idx = i
            if best_idx != -1 and max_matches >= 2:
                df.columns = df.iloc[best_idx].astype(str).str.strip()
                df = df.iloc[best_idx+1:].reset_index(drop=True)
                    
        df.columns = df.columns.astype(str).str.strip()
        nombre_fecha = config.get('col_fecha', 'Fecha recibo')
        nombre_cedula = config.get('col_cedula', 'Cedula')
        nombre_detalle = config.get('col_detalle', 'Detalle')
        
        alias_map = {
            nombre_fecha: ['fecha', 'fec', 'date', 'recibo'],
            nombre_cedula: ['cedula', 'c.c', 'nit', 'documento'],
            nombre_detalle: ['banco', 'detalle', 'descripcion', 'concepto', 'oficina'],
            'Debito': ['debito', 'cargo', 'retiro', 'debitos'],
            'Credit': ['credito', 'abono', 'deposito', 'ingreso', 'creditos'],
            'Valor': ['valor', 'monto', 'importe']
        }
        
        # Encabezados vacíos o repetidos (fila promovida con varias celdas en blanco) se
        # desambiguan antes de tocar nada.
        df = _columnas_unicas(df)
        nuevas_columnas = {}
        existentes = set(df.columns)
        for col in df.columns:
            col_lower = col.lower()
            for nombre_std, aliases in alias_map.items():
                if nombre_std in nuevas_columnas.values():
                    continue
                # Si la hoja YA trae una columna con ese nombre exacto, esa es la dueña del
                # nombre: renombrar otra encima (p. ej. 'Banco' -> 'Detalle' cuando también
                # existe 'Detalle') duplicaba la columna y rompía el buscador.
                if nombre_std in existentes and nombre_std != col:
                    continue
                if any(alias in col_lower for alias in aliases):
                    nuevas_columnas[col] = nombre_std
                    break
        df = _columnas_unicas(df.rename(columns=nuevas_columnas))
        # (Propio de Axio independiente) Si la cédula llegó sin encabezado, se reconoce por
        # contenido antes de limpiarla: ver COLUMNA DE CÉDULA SIN ENCABEZADO, arriba.
        df = asegurar_columna_cedula(df, nombre_cedula)
        if nombre_cedula in df.columns: df[nombre_cedula] = df[nombre_cedula].apply(limpiar_cedula)
        if nombre_fecha in df.columns: df[nombre_fecha] = pd.to_datetime(df[nombre_fecha], errors='coerce', dayfirst=True).dt.strftime('%d/%m/%Y')
        for col in df.columns:
            if any(p in col.lower() for p in ['val', 'monto', 'cred', 'deb', 'abo', 'retiro', 'ingreso']):
                df[col] = pd.to_numeric(df[col].apply(parse_money), errors='coerce').fillna(0).round(2)
        return df
    except Exception as e: raise ValueError(f"Fallo al interpretar la Base Global en la nube. Detalle: {e}")

# ==============================================================================
# LÍNEAS DE CRÉDITO (fusionado desde Axio) -- carga y normalización de un
# roster (misma URL que Matriz_Nube: Google Sheets publicado, o Excel/CSV
# directo). No asume nombres de columna fijos -- los busca por alias (igual
# que descargar_base_global), así que sirve tanto para 'Congregación' (con
# CCO y nombre de congregación) como para una línea personal que solo traiga
# Cédula y Nombre.
def _columna_cedula_sin_titulo(filas, encabezados, muestra=300):
    """Índice de la columna SIN título cuyos valores son cédulas (al menos el 60% de las
    celdas con algo: solo dígitos y separadores, de 5 a 11 cifras), o None."""
    mejor, mejor_proporcion = None, 0.6
    for i, titulo in enumerate(encabezados):
        if titulo:
            continue
        valores = [str(f[i].value).strip() for f in filas[1:muestra + 1]
                   if i < len(f) and f[i].value is not None and str(f[i].value).strip()]
        if len(valores) < 3:
            continue
        parecidas = sum(1 for v in valores
                        if re.fullmatch(r'[\d.,\s]+', v) and 5 <= len(limpiar_cedula(v)) <= 11)
        if parecidas / len(valores) >= mejor_proporcion:
            mejor, mejor_proporcion = i, parecidas / len(valores)
    return mejor


def descargar_linea_credito(url, clave=None):
    """Descarga y normaliza el roster de UNA línea de crédito. Devuelve un
    dict {cedula_normalizada: [{'cco','congregacion','nombre','distrito',
    'link_obligacion','tarifa','saldo','meses_mora','observacion'}, ...]} --
    una cédula puede tener más de una entrada (ej. un pastor a cargo de más
    de una congregación).

    'tarifa'/'saldo'/'meses_mora'/'observacion' son OPCIONALES y SOLO se
    buscan si 'clave' está en CLAVES_LINEAS_CON_INFO_EXTRA (hoy, solo
    Seguro de Vida) -- NO es una detección genérica por nombre de columna.

    Solo quedan las filas cuyo estado sea ACTIVO -- si la hoja trae una
    columna de estado (alias 'ACTIV'/'ESTADO') y la fila dice INACTIVO, está
    en blanco, o trae basura irreconocible, esa fila se descarta por
    completo. Si la línea no trae columna de estado, no se filtra por eso.

    El hipervínculo hacia la obligación se busca en TODAS las celdas de la
    fila, no en una columna fija.

    Filas sin cédula reconocible (encabezados de zona, filas en blanco, o
    filas rotas con errores #REF! de Excel) se saltan sin generar error."""
    if not url or not url.strip():
        return {}
    url = url.strip()
    try:
        if "docs.google.com/spreadsheets" in url:
            gid = ""
            if "gid=" in url:
                gid_num = url.split("gid=")[1].split("&")[0]
                gid = f"&gid={gid_num}"
            # xlsx, NUNCA csv -- un CSV jamás puede llevar hipervínculos.
            url_descarga = re.sub(r'/edit.*$', '/export?format=xlsx' + gid, url)
        else:
            url_descarga = url
        wb = _leer_workbook_openpyxl(url_descarga)
    except Exception as e:
        raise ValueError(f"No se pudo descargar/leer esta línea de crédito. Detalle: {e}")

    ALIASES_CEDULA = ['CEDULA', 'CÉDULA', 'C.C', 'DOCUMENTO', 'NIT']

    ws, filas, encabezados = None, [], []
    hojas_revisadas = []
    for hoja_candidata in wb.worksheets:
        filas_candidatas = list(hoja_candidata.iter_rows())
        hojas_revisadas.append(hoja_candidata.title)
        if len(filas_candidatas) < 2:
            continue
        encabezados_candidatos = [str(c.value).strip() if c.value is not None else '' for c in filas_candidatas[0]]
        tiene_cedula = any(alias in str(h).upper() for h in encabezados_candidatos for alias in ALIASES_CEDULA)
        if not tiene_cedula:
            # Seguro de Vida (2026) trae la cédula en una columna SIN título: se reconoce
            # por su contenido, igual que en la Matriz_Nube (asegurar_columna_cedula).
            idx = _columna_cedula_sin_titulo(filas_candidatas, encabezados_candidatos)
            if idx is not None:
                encabezados_candidatos[idx] = 'CEDULA'
                tiene_cedula = True
        if tiene_cedula:
            ws, filas, encabezados = hoja_candidata, filas_candidatas, encabezados_candidatos
            break

    if ws is None:
        nombres_hojas = ", ".join(hojas_revisadas) if hojas_revisadas else "(el archivo no tiene hojas)"
        raise ValueError(f"No se encontró una columna de Cédula en ninguna hoja de este archivo (hojas revisadas: {nombres_hojas}) -- revisa el encabezado.")

    cols_por_mayus = {i: encabezados[i].upper() for i in range(len(encabezados))}
    columnas_ya_asignadas = set()

    def _buscar_columna(aliases, usar_ultimo=False):
        candidatos = [i for i, en_mayus in cols_por_mayus.items()
                      if i not in columnas_ya_asignadas and any(alias in en_mayus for alias in aliases)]
        if not candidatos:
            return None
        elegido = candidatos[-1] if usar_ultimo else candidatos[0]
        columnas_ya_asignadas.add(elegido)
        return elegido

    def _buscar_columna_con_todas(palabras):
        """Como _buscar_columna, pero exige que el encabezado tenga TODAS las palabras."""
        for i, en_mayus in cols_por_mayus.items():
            if i not in columnas_ya_asignadas and all(p in en_mayus for p in palabras):
                columnas_ya_asignadas.add(i)
                return i
        return None

    idx_cedula = _buscar_columna(ALIASES_CEDULA)
    idx_cco = _buscar_columna(['CCO', 'CODIGO', 'CÓDIGO'])
    idx_congregacion = _buscar_columna(['CONGREGA', 'IGLESIA'])
    idx_distrito = _buscar_columna(['DTO', 'DISTRITO'])
    # Columnas del resumen de la obligación (V11). Van ANTES que la de estado: el
    # encabezado 'OBSERVACIÓN (Activos/Inactivos)' también contiene 'ACTIV' y, si se
    # buscara después, podría quedarse con la columna que decide si el crédito está activo.
    idx_tipo_credito = _buscar_columna(['TIPO CREDITO', 'TIPO CRÉDITO', 'TIPO DE CREDITO', 'TIPO DE CRÉDITO'])
    idx_obs_estado = (_buscar_columna_con_todas(['OBSERVACI', 'ACTIV'])
                      if clave not in CLAVES_LINEAS_CON_INFO_EXTRA else None)
    idx_fecha_ultimo_pago = _buscar_columna(['ULTIMO PAGO', 'ÚLTIMO PAGO'])
    idx_saldo_actual = _buscar_columna(['SALDO ACTUAL DE LA TABLA'])
    if clave in CLAVES_LINEAS_CON_INFO_EXTRA:
        idx_estado = None
        # Como el saldo: con varias ('TARIFA A JUNIO', 'TARIFA A AGOSTO'), la última es la vigente.
        idx_tarifa = _buscar_columna(['TARIFA'], usar_ultimo=True)
        idx_saldo = _buscar_columna(['SALDO'], usar_ultimo=True)
        idx_mora = _buscar_columna(['MORA'])
        # Por palabras y no por el texto exacto: la hoja pasó de 'OBSERVACION DIRECTIVOS' a
        # 'OBSERVACION de DIRECTIVOS ( NO REPORTAR)'. 'OBSERVACI' cubre la tilde.
        idx_obs_directivos = _buscar_columna_con_todas(['OBSERVACI', 'DIRECTIV'])
        idx_obs_general = _buscar_columna_con_todas(['OBSERVACI', 'GENERAL'])
        if idx_obs_directivos is None and idx_obs_general is None:
            idx_obs_directivos = _buscar_columna(['OBSERVACION', 'OBSERVACIÓN'])
    else:
        idx_estado = _buscar_columna(['ACTIV', 'ESTADO'])
        idx_tarifa = idx_saldo = idx_mora = idx_obs_directivos = idx_obs_general = None
    idx_nombre = _buscar_columna(['NOMBRE', 'RESPONSABLE', 'PASTOR'])

    if idx_cedula is None:
        raise ValueError("No se encontró una columna de Cédula en esta línea de crédito -- revisa el encabezado de la hoja.")

    def _texto_o_none(fila_celdas, idx):
        if idx is None or idx >= len(fila_celdas):
            return None
        v = fila_celdas[idx].value
        if v is None or str(v).strip() in ('', 'nan', 'NaN'):
            return None
        return str(v).strip()

    def _valor_o_none(fila_celdas, idx):
        if idx is None or idx >= len(fila_celdas):
            return None
        v = fila_celdas[idx].value
        if v is None or str(v).strip() in ('', 'nan', 'NaN'):
            return None
        return v

    # Seguro de Vida: no hay una hoja por obligación; todo se gestiona en la maestra. «Ver
    # obligación» lleva a la fila de la persona en esa misma hoja (con su pestaña, gid).
    enlace_a_fila = None
    if clave in CLAVES_LINEAS_CON_INFO_EXTRA and "docs.google.com/spreadsheets" in url:
        base = re.match(r'https://docs\.google\.com/spreadsheets/d/[\w-]+', url)
        gid_hoja = re.search(r'[#&?]gid=(\d+)', url)
        if base:
            ultima_col = get_column_letter(max(1, len(encabezados)))
            enlace_a_fila = (lambda n, b=base.group(0), g=(gid_hoja.group(1) if gid_hoja else '0'):
                             f"{b}/edit#gid={g}&range=A{n}:{ultima_col}{n}")
    roster = {}
    # n_fila: el número de la fila en la hoja (iter_rows empieza en la 1, también openpyxl).
    for n_fila, fila_celdas in enumerate(filas[1:], start=2):
        if idx_cedula >= len(fila_celdas):
            continue
        cedula_raw = fila_celdas[idx_cedula].value
        if cedula_raw is None or str(cedula_raw).strip() in ('', 'nan', 'NaN'):
            continue
        cedula_norm = limpiar_cedula(cedula_raw)
        if cedula_norm == '0':
            continue

        if idx_estado is not None:
            estado_txt = _texto_o_none(fila_celdas, idx_estado)
            if estado_txt is None or estado_txt.strip().upper() != 'ACTIVO':
                continue
        elif clave in CLAVES_LINEAS_CON_INFO_EXTRA and idx_saldo is not None:
            saldo_val = _valor_o_none(fila_celdas, idx_saldo)
            if saldo_val is None:
                continue
            try:
                if float(saldo_val) == 0:
                    continue
            except (TypeError, ValueError):
                pass

        link_obligacion = None
        for celda in fila_celdas:
            if celda.hyperlink is not None:
                link_obligacion = celda.hyperlink.target
                break
        if link_obligacion is None:
            for celda in fila_celdas:
                v = celda.value
                if isinstance(v, str) and v.strip().lower().startswith(('http://', 'https://')):
                    link_obligacion = v.strip()
                    break
        if enlace_a_fila is not None:
            link_obligacion = enlace_a_fila(n_fila)   # el enlace de la celda sigue en 'campos'

        # El tipo de crédito suele llevar un hipervínculo al último registro del crédito.
        link_registro = None
        if idx_tipo_credito is not None and idx_tipo_credito < len(fila_celdas):
            celda_tipo = fila_celdas[idx_tipo_credito]
            if celda_tipo.hyperlink is not None:
                link_registro = celda_tipo.hyperlink.target

        cco_raw = _texto_o_none(fila_celdas, idx_cco)
        distrito_raw = _texto_o_none(fila_celdas, idx_distrito)
        entrada = {
            'cco': _formatear_cco(cco_raw) if cco_raw is not None else None,
            'congregacion': _texto_o_none(fila_celdas, idx_congregacion),
            'nombre': _texto_o_none(fila_celdas, idx_nombre),
            'distrito': (distrito_raw[:-2] if distrito_raw and distrito_raw.endswith('.0') and distrito_raw[:-2].isdigit() else distrito_raw),
            'link_obligacion': link_obligacion,
            'tarifa': _valor_o_none(fila_celdas, idx_tarifa),
            'saldo': _valor_o_none(fila_celdas, idx_saldo),
            # El título de la columna, porque dice a qué mes corresponde ('SALDO A AGOSTO 2026').
            'columna_tarifa': encabezados[idx_tarifa] if idx_tarifa is not None else None,
            'columna_saldo': encabezados[idx_saldo] if idx_saldo is not None else None,
            'meses_mora': _valor_o_none(fila_celdas, idx_mora),
            'observacion_directivos': _texto_o_none(fila_celdas, idx_obs_directivos),
            'observacion_general': _texto_o_none(fila_celdas, idx_obs_general),
            'tipo_credito': _texto_o_none(fila_celdas, idx_tipo_credito),
            'link_registro': link_registro,
            'observacion_estado': _texto_o_none(fila_celdas, idx_obs_estado),
            'fecha_ultimo_pago': _valor_o_none(fila_celdas, idx_fecha_ultimo_pago),
            'saldo_actual': _valor_o_none(fila_celdas, idx_saldo_actual),
            # La fila COMPLETA de la obligación, para verla tal cual en su detalle: solo
            # las celdas con algo, en el orden de la hoja, con su hipervínculo si lo tiene.
            'campos': _campos_de_fila(encabezados, fila_celdas),
        }
        lista = roster.setdefault(cedula_norm, [])
        # Una misma persona puede tener dos créditos activos en la misma congregación (uno
        # de Libre Inversión y una ampliación, por ejemplo): el tipo y el saldo los separan.
        # Lo que sí se une es la misma fila repetida en la hoja.
        def _clave_dedupe(e):
            return (e['cco'] if e['cco'] else (e['nombre'], e['congregacion']),
                    e.get('tipo_credito'), str(e.get('saldo_actual')))
        if not any(_clave_dedupe(e) == _clave_dedupe(entrada) for e in lista):
            lista.append(entrada)
    return roster


def _campos_de_fila(encabezados, fila_celdas):
    """[(encabezado, valor, hipervínculo o None)] de las celdas con datos de una fila. Los
    encabezados de las hojas reales traen saltos de línea ('TIPO CREDITO\\nLink Ultimo
    Registro'): se dejan en una sola línea. Las columnas sin encabezado se nombran por
    su letra para no perder el dato."""
    campos = []
    for i, celda in enumerate(fila_celdas):
        valor = celda.value
        if valor is None or str(valor).strip() in ('', 'nan', 'NaN'):
            continue
        encabezado = ' '.join(str(encabezados[i]).split()) if i < len(encabezados) and encabezados[i] else ''
        if not encabezado:
            encabezado = f"Columna {get_column_letter(i + 1)}"
        enlace = celda.hyperlink.target if celda.hyperlink is not None else None
        campos.append((encabezado, valor, enlace))
    return campos


# ==============================================================================
# DIRECTORIO DE WHATSAPP -- la hoja con el celular de cada asociado (V11)
# ==============================================================================
def normalizar_celular_whatsapp(texto):
    """Devuelve el número listo para wa.me (57 + celular de 10 dígitos que empieza por 3),
    o None si la celda no trae un celular colombiano reconocible. Acepta espacios,
    puntos, guiones, paréntesis y el +57 delante; si la celda trae dos números, toma el
    primero."""
    if texto is None:
        return None
    limpio = re.sub(r'[\s.\-()]', '', str(texto))
    m = re.search(r'(?:\+?57)?(3\d{9})(?!\d)', limpio)
    return '57' + m.group(1) if m else None


def descargar_directorio_whatsapp(url):
    """Descarga la hoja de celulares y devuelve
    {cédula normalizada: {'celular': '573001234567', 'nombre': 'Pérez Gómez Aníbal' o None}}.

    Busca el encabezado en las primeras filas: la columna de cédula es la que se llama
    exactamente CEDULA (la hoja también trae 'CEDULA - NOMBRE', que no sirve), la del
    número la que dice WHATSAPP y la del nombre, la que dice NOMBRE sin decir CEDULA.
    Solo quedan las personas con un celular válido."""
    if not url or not url.strip():
        return {}
    url = url.strip()
    try:
        if "docs.google.com/spreadsheets" in url:
            gid = ""
            if "gid=" in url:
                gid = "&gid=" + url.split("gid=")[1].split("&")[0]
            url = re.sub(r'/edit.*$', '/export?format=csv' + gid, url)
        df = pd.read_csv(url, header=None, dtype=str, keep_default_na=False)
    except Exception as e:
        texto = str(e)
        if '401' in texto or '403' in texto:
            raise ValueError("No hay permiso para leer la hoja de WhatsApp: pide acceso a quien la "
                             "administra. Sin inicio de sesión con Google, la hoja tiene que estar "
                             "compartida como «Cualquier persona con el enlace · Lector».")
        raise ValueError(f"No se pudo descargar la hoja de WhatsApp. Detalle: {e}")

    for i in range(min(10, len(df))):
        encabezados = [str(v).strip().upper() for v in df.iloc[i]]
        idx_cedula = next((j for j, h in enumerate(encabezados) if h in ('CEDULA', 'CÉDULA')), None)
        if idx_cedula is None:
            idx_cedula = next((j for j, h in enumerate(encabezados)
                               if ('CEDULA' in h or 'CÉDULA' in h) and 'NOMBRE' not in h), None)
        idx_celular = next((j for j, h in enumerate(encabezados) if 'WHATSAPP' in h), None)
        idx_nombre = next((j for j, h in enumerate(encabezados)
                           if 'NOMBRE' in h and 'CEDULA' not in h and 'CÉDULA' not in h), None)
        if idx_cedula is not None and idx_celular is not None:
            break
    else:
        raise ValueError("La hoja de WhatsApp no tiene las columnas CEDULA y CelularWhatsApp.")

    directorio = {}
    for fila in df.iloc[i + 1:].itertuples(index=False):
        cedula = str(fila[idx_cedula]).strip()
        celular = normalizar_celular_whatsapp(fila[idx_celular])
        if not cedula or not celular:
            continue
        cedula_norm = limpiar_cedula(cedula)
        if cedula_norm and cedula_norm != '0':
            nombre = str(fila[idx_nombre]).strip() if idx_nombre is not None else ''
            directorio.setdefault(cedula_norm, {'celular': celular, 'nombre': nombre or None})
    return directorio
