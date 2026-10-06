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
import re
import secrets
import threading

from axio.dominio.buscador import (
    CLAVES_LINEAS_CON_INFO_EXTRA, DIRECTORIO_CARTERA_DEFECTO, LIMITE_FILAS_DIBUJADAS,
    _formatear_valor_celda, asegurar_columna_cedula, aviso_columna_cedula,
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

# En la web la Matriz_Nube se presenta como «Extractos», que es como la llama la gente.
# Solo cambia lo que se ve: por dentro (caché, escritorio, Excel) sigue siendo Matriz_Nube.
NOMBRES_VISIBLES_FUENTE = {'Matriz_Nube': 'Extractos'}


def _nombre_visible(fuente):
    return NOMBRES_VISIBLES_FUENTE.get(fuente, fuente)


def _cedula_con_puntos(cedula_limpia):
    return f"{int(cedula_limpia):,}".replace(',', '.') if cedula_limpia.isdigit() else cedula_limpia


def _hora_iso(momento):
    return momento.strftime("%Y-%m-%d %H:%M:%S") if momento else None


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

        self.cache_normalizado = {}
        self.cache_archivos = {}
        self._busquedas = OrderedDict()

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

            rosters, hora_lineas, errores = self._cargar_lineas(config)
            whatsapp, error_whatsapp = self._cargar_whatsapp(config)

            # Todo se reemplaza de una vez al final: mientras se descargaba, las búsquedas
            # siguieron usando la copia anterior completa, nunca una mitad nueva.
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
        }

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
        fila = r['fila']

        distrito = obtener_distrito_de_fila(fila)
        directorio = self.config.get('directorio_cartera', DIRECTORIO_CARTERA_DEFECTO)
        persona = buscar_encargado_cartera(distrito, directorio) if distrito is not None else None

        cedula = obtener_cedula_de_fila(fila)
        lineas, motivo_sin_lineas = None, None
        if cedula is not None and self.rosters:
            lineas = self._lineas_de_cedula(limpiar_cedula(cedula))
        elif cedula is None:
            motivo_sin_lineas = "En esta fila no hay ningún campo con forma de cédula; por eso no se consultan las líneas de crédito."
        elif not any(str(l.get('url', '')).strip() for l in self.config.get('lineas_credito', [])):
            motivo_sin_lineas = "No hay líneas de crédito configuradas en el servidor."
        else:
            motivo_sin_lineas = "Las líneas de crédito no se pudieron cargar. Un administrador puede revisar el error con «Refrescar datos»."

        cedula_limpia = limpiar_cedula(cedula) if cedula is not None else None
        return {
            'fuente': _nombre_visible(r['fuente']),
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
                       for c in r['columnas']],
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
        }

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
