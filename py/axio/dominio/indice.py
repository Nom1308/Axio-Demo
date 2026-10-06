"""Índice permanente de los cierres locales, para que Axio los busque al instante.

EL PROBLEMA QUE RESUELVE

El interruptor "Incluir cierres locales guardados" dice "(más lento)" y viene apagado, con
razón: para buscar en el histórico hay que abrir y parsear cada Excel de la carpeta de
salida. Medido con 6 archivos, 0,92 s; con 25 archivos ronda los 4 segundos. Y esos 4
segundos vuelven CADA VEZ QUE SE ABRE LA APLICACIÓN, porque la caché vive en memoria y
muere al cerrar. El resultado práctico es una función que existe y nadie usa.

Acá los cierres se leen UNA vez y se guardan en la misma base SQLite de la aplicación. A
partir de ahí buscar en todo el histórico cuesta lo mismo que una consulta a la base, y el
interruptor deja de tener un motivo para estar apagado.

CÓMO SE MANTIENE AL DÍA

Cada fila indexada guarda el mtime del archivo del que salió. Al indexar se comparan los
mtime: los archivos sin cambios se saltan, los modificados se reindexan y los borrados de
la carpeta se eliminan del índice. No hay que acordarse de "refrescar" nada.

POR QUÉ NO SE USA FTS5

SQLite trae búsqueda de texto completo, que sería más rápida, pero funciona por PALABRAS
completas. Acá se busca por fragmento: 'RCA0001' tiene que encontrar 'RCA-000123', y una
cédula parcial tiene que encontrar la completa. Eso es LIKE '%...%', que obliga a recorrer
la tabla -- pero recorrer 50.000 filas en SQLite son milisegundos, contra segundos de abrir
archivos de Excel. La comparación correcta no es contra FTS5: es contra leer los Excel.
"""

import json
import os
import sqlite3

import pandas as pd

from axio.nucleo.entorno import HAS_ORJSON
from axio.nucleo.registro import logger
from axio.nucleo.rutas import DB_FILE

if HAS_ORJSON:
    import orjson

    def _a_json(obj):
        return orjson.dumps(obj, option=orjson.OPT_SERIALIZE_NUMPY).decode('utf-8')

    def _de_json(txt):
        return orjson.loads(txt)
else:
    def _a_json(obj):
        return json.dumps(obj, ensure_ascii=False, default=str)

    def _de_json(txt):
        return json.loads(txt)


# Separador entre celdas dentro del texto indexado. Se usa un carácter que no aparece en
# datos contables: sin separador, el final de una celda y el principio de la siguiente
# formarían coincidencias falsas ("...12345" + "678..." encontraría "12345678" donde no
# está).
SEP = '\x1f'


def init_indice():
    """Crea la tabla del índice si no existe. Se puede llamar siempre."""
    con = sqlite3.connect(DB_FILE)
    try:
        con.execute("""
            CREATE TABLE IF NOT EXISTS indice_axio (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                archivo TEXT NOT NULL,
                hoja TEXT NOT NULL,
                mtime REAL NOT NULL,
                fuente TEXT NOT NULL,
                columnas TEXT NOT NULL,
                fila TEXT NOT NULL,
                texto TEXT NOT NULL,
                num_min REAL,
                num_max REAL
            )""")
        con.execute("CREATE INDEX IF NOT EXISTS idx_axio_archivo ON indice_axio(archivo, hoja)")
        # Sirve para descartar por rango numérico antes de mirar el texto.
        con.execute("CREATE INDEX IF NOT EXISTS idx_axio_nums ON indice_axio(num_min, num_max)")
        con.commit()
    finally:
        con.close()


def _fila_a_texto(fila_norm):
    return SEP + SEP.join(str(v) for v in fila_norm if v) + SEP


def indexar_carpeta(carpeta, hojas_buscables, normalizador, numerizador,
                    max_archivos=200, progress_callback=None):
    """Pone el índice al día con los Excel de 'carpeta'. Devuelve un resumen.

    'normalizador' y 'numerizador' se reciben como parámetros en vez de importarse de
    axio.py a propósito: si este módulo importara axio.py y axio.py importara este, sería
    un ciclo. Recibirlos deja la dependencia en una sola dirección.
    """
    init_indice()
    resumen = {'indexados': 0, 'sin_cambios': 0, 'eliminados': 0, 'filas': 0, 'errores': []}
    if not carpeta or not os.path.isdir(carpeta):
        return resumen

    con = sqlite3.connect(DB_FILE)
    try:
        conocidos = {r[0]: r[1] for r in con.execute(
            "SELECT archivo, MAX(mtime) FROM indice_axio GROUP BY archivo")}

        archivos = [f for f in os.listdir(carpeta)
                    if f.lower().endswith('.xlsx') and not f.startswith('~$')]
        archivos.sort(key=lambda f: os.path.getmtime(os.path.join(carpeta, f)), reverse=True)
        archivos = archivos[:max_archivos]
        rutas_actuales = {os.path.join(carpeta, f) for f in archivos}

        # Archivos que ya no están en la carpeta: se sacan del índice. Si no, Axio seguiría
        # devolviendo resultados de un cierre borrado y mandaría a abrir un archivo
        # inexistente.
        for ruta_vieja in list(conocidos):
            if ruta_vieja not in rutas_actuales and os.path.dirname(ruta_vieja) == os.path.abspath(carpeta):
                con.execute("DELETE FROM indice_axio WHERE archivo=?", (ruta_vieja,))
                resumen['eliminados'] += 1

        for i, nombre in enumerate(archivos):
            ruta = os.path.join(carpeta, nombre)
            try:
                mtime = os.path.getmtime(ruta)
                if conocidos.get(ruta) == mtime:
                    resumen['sin_cambios'] += 1
                    continue
                if progress_callback:
                    progress_callback(f"Indexando {nombre} ({i + 1}/{len(archivos)})...")

                con.execute("DELETE FROM indice_axio WHERE archivo=?", (ruta,))
                xls = pd.ExcelFile(ruta)
                for hoja in hojas_buscables:
                    if hoja not in xls.sheet_names:
                        continue
                    encabezado = 1 if hoja == 'Peligro_global' else 0
                    df = xls.parse(hoja, header=encabezado)
                    if df.empty:
                        continue
                    normalizada = normalizador(df)
                    numerica = numerizador(df)
                    columnas = _a_json([str(c) for c in df.columns])
                    fuente = f"{os.path.splitext(nombre)[0]} · {hoja}"

                    if numerica:
                        marco_num = pd.DataFrame(numerica)
                        minimos = marco_num.min(axis=1)
                        maximos = marco_num.max(axis=1)
                    else:
                        minimos = maximos = pd.Series([None] * len(df), index=df.index)

                    lote = []
                    for idx, fila in df.iterrows():
                        texto = _fila_a_texto(normalizada.loc[idx].tolist())
                        lote.append((
                            ruta, hoja, mtime, fuente, columnas,
                            _a_json({str(c): (None if pd.isna(v) else v) for c, v in fila.items()}),
                            texto,
                            None if pd.isna(minimos.loc[idx]) else float(minimos.loc[idx]),
                            None if pd.isna(maximos.loc[idx]) else float(maximos.loc[idx]),
                        ))
                    con.executemany(
                        "INSERT INTO indice_axio (archivo,hoja,mtime,fuente,columnas,fila,texto,num_min,num_max)"
                        " VALUES (?,?,?,?,?,?,?,?,?)", lote)
                    resumen['filas'] += len(lote)
                resumen['indexados'] += 1
                con.commit()
            except Exception as e:
                logger.exception(f"No se pudo indexar {nombre}")
                resumen['errores'].append(f"{nombre}: {e}")
        con.commit()
    finally:
        con.close()
    return resumen


def buscar_en_indice(terminos, limite=5000):
    """Busca en el índice. Devuelve (resultados, totales_por_fuente).

    Los términos de texto se resuelven con LIKE en SQL -- que es donde conviene descartar,
    porque baja de decenas de miles de filas a unas pocas antes de tocar Python. Los
    términos numéricos y los rangos se preacotan con num_min/num_max y se confirman después
    sobre las filas que quedaron.
    """
    if not terminos:
        return [], {}
    init_indice()

    condiciones, parametros = [], []
    for t in terminos:
        piezas, sub = [], []
        if t.get('plano'):
            piezas.append("texto LIKE ?")
            sub.append(f"%{t['plano']}%")
        if t.get('rango'):
            lo, hi = t['rango']
            piezas.append("(num_max >= ? AND num_min <= ?)")
            sub += [lo, hi]
        elif t.get('numerico') is not None:
            # Margen de un peso al preacotar: el filtro fino se hace después con la
            # tolerancia real de centavos. Preacotar con la tolerancia exacta correría el
            # riesgo de descartar por redondeo una fila que sí coincide.
            piezas.append("(num_min <= ? AND num_max >= ?)")
            sub += [t['numerico'] + 1, t['numerico'] - 1]
        if not piezas:
            continue
        condiciones.append("(" + " OR ".join(piezas) + ")")
        parametros += sub

    if not condiciones:
        return [], {}

    sql = ("SELECT fuente, columnas, fila, texto, num_min, num_max FROM indice_axio WHERE "
           + " AND ".join(condiciones) + " LIMIT ?")
    parametros.append(limite * 4)   # margen: algunas se descartan en el filtro fino

    con = sqlite3.connect(DB_FILE)
    try:
        filas = con.execute(sql, parametros).fetchall()
    except Exception:
        logger.exception("Fallo consultando el índice de Axio")
        return [], {}
    finally:
        con.close()

    resultados, totales = [], {}
    for fuente, columnas_json, fila_json, texto, _, _ in filas:
        fila = _de_json(fila_json)
        columnas = _de_json(columnas_json)

        # Filtro fino: el LIKE ya garantizó el texto, falta confirmar los montos con la
        # tolerancia de centavos y saber en qué columna cayó cada término.
        cols_match, todos_ok = set(), True
        for t in terminos:
            encontrado = False
            if t.get('plano'):
                for c in columnas:
                    if t['plano'] in _normalizar_valor(fila.get(c)):
                        cols_match.add(c)
                        encontrado = True
                        break
            if not encontrado and (t.get('numerico') is not None or t.get('rango')):
                # Los rangos solo miran columnas de dinero: si no, '>800000' coincide con
                # cualquier cédula y devuelve movimientos de mil pesos.
                if t.get('rango'):
                    candidatas = [c for c in columnas if _es_columna_dinero(c)] or columnas
                else:
                    candidatas = columnas
                for c in candidatas:
                    v = _valor_numerico(fila.get(c))
                    if v is None:
                        continue
                    if t.get('rango'):
                        lo, hi = t['rango']
                        if lo <= v <= hi:
                            cols_match.add(c)
                            encontrado = True
                            break
                    elif abs(v - t['numerico']) < 0.01:
                        cols_match.add(c)
                        encontrado = True
                        break
            if not encontrado:
                todos_ok = False
                break
        if not todos_ok:
            continue

        totales[fuente] = totales.get(fuente, 0) + 1
        if len(resultados) < limite:
            resultados.append({'fuente': fuente, 'columnas': columnas,
                               'fila': fila, 'columnas_coincidentes': cols_match})
    return resultados, totales


# Se importan tarde, dentro de las funciones que los usan, para no crear un ciclo entre
# este módulo y axio.py.
def _es_columna_dinero(nombre):
    from axio.dominio.buscador import _es_columna_de_dinero
    return _es_columna_de_dinero(nombre)


def _normalizar_valor(v):
    from axio.dominio.buscador import _normalizar_para_busqueda
    return '' if v is None else _normalizar_para_busqueda(v)


def _valor_numerico(v):
    from axio.nucleo.utils import parse_money
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str):
        n = parse_money(v)
        return n if n != 0.0 else None
    return None


def estado_indice():
    """Resumen para mostrar en pantalla: cuántos cierres y filas hay indexados."""
    init_indice()
    con = sqlite3.connect(DB_FILE)
    try:
        archivos = con.execute("SELECT COUNT(DISTINCT archivo) FROM indice_axio").fetchone()[0]
        filas = con.execute("SELECT COUNT(*) FROM indice_axio").fetchone()[0]
        return {'archivos': archivos, 'filas': filas}
    except Exception:
        return {'archivos': 0, 'filas': 0}
    finally:
        con.close()


def limpiar_indice():
    """Borra el índice completo. Se reconstruye solo en la próxima búsqueda."""
    init_indice()
    con = sqlite3.connect(DB_FILE)
    try:
        con.execute("DELETE FROM indice_axio")
        con.commit()
    finally:
        con.close()
