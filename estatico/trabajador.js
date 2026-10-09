/* Axio demo: el "servidor" que corre dentro de la pestaña.
 *
 * Arranca Pyodide (Python compilado a WebAssembly), le instala pandas y openpyxl, baja el
 * código de Axio (py/) y responde las llamadas /api/... de app.js con motor/navegador.py.
 * Va en un Worker para que buscar en 60.000 filas no congele la página.
 */
"use strict";

const VERSION_PYODIDE = "0.29.3";
importScripts(`https://cdn.jsdelivr.net/pyodide/v${VERSION_PYODIDE}/full/pyodide.js`);

const BASE = new URL("../", self.location.href).href;   // raíz del sitio
const avisar = (mensaje) => postMessage({ tipo: "progreso", mensaje });

async function bajarTexto(ruta) {
  const resp = await fetch(BASE + ruta, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`No se pudo bajar ${ruta} (HTTP ${resp.status})`);
  return resp.text();
}

async function arrancar() {
  avisar("Descargando el motor de Python…");
  const pyodide = await loadPyodide();

  avisar("Instalando pandas…");
  await pyodide.loadPackage(["pandas", "sqlite3", "orjson", "micropip"]);
  avisar("Instalando openpyxl…");
  await pyodide.pyimport("micropip").install("openpyxl");

  avisar("Cargando Axio…");
  const lista = (await bajarTexto("py/archivos.txt")).split("\n").map((s) => s.trim()).filter(Boolean);
  const archivos = await Promise.all(lista.map(async (rel) => [rel, await bajarTexto("py/" + rel)]));
  archivos.push(["navegador.py", await bajarTexto("motor/navegador.py")]);
  for (const [rel, texto] of archivos) {
    const ruta = "/app/" + rel;
    pyodide.FS.mkdirTree(ruta.slice(0, ruta.lastIndexOf("/")));
    pyodide.FS.writeFile(ruta, texto);
  }
  pyodide.runPython(`
import os, sys
os.environ['AXIO_CARPETA_DATOS'] = '/datos'
sys.path.insert(0, '/app')
import navegador
`);
  postMessage({ tipo: "motor-listo" });
  return pyodide.pyimport("navegador");
}

// bytes de Python -> Uint8Array con su propio buffer (para transferirlo sin copiar otra vez).
function aBytes(valor) {
  const vista = valor.getBuffer("u8");
  try { return vista.data.slice(); } finally { vista.release(); valor.destroy(); }
}

const motor = arrancar();
motor.catch((e) => postMessage({ tipo: "error-motor", error: String(e && e.message || e) }));

// ------------------------------------------------------------------ descargas en paralelo
// Python baja cada hoja con una petición síncrona, una detrás de otra, y además no puede
// empezar hasta que el motor termine de instalarse. Aquí se bajan todas a la vez apenas
// llega el config, MIENTRAS el motor se prepara, y Python las encuentra listas (ver
// guardar_precarga en motor/navegador.py). Lo que falle aquí, Python lo vuelve a intentar
// a su manera y da el mensaje de error de siempre.
const HOSTS_GOOGLE = ["docs.google.com", "sheets.googleapis.com", "www.googleapis.com"];
const DESCARGAS_A_LA_VEZ = 6;
let tokenGoogle = "";
let ultimoConfig = null;
let motorListo = false;

// Las mismas URLs que arman descargar_base_global (csv), descargar_linea_credito (xlsx,
// para conservar los hipervínculos) y descargar_directorio_whatsapp (csv) en
// axio/dominio/buscador.py. Si alguna no coincide, solo se pierde la precarga de esa hoja.
function urlExportacion(url, formato) {
  url = String(url || "").trim();
  if (!url.includes("docs.google.com/spreadsheets")) return url;
  const gid = url.includes("gid=") ? "&gid=" + url.split("gid=")[1].split("&")[0] : "";
  return url.replace(/\/edit.*$/s, "/export?format=" + formato + gid);
}

function urlsPrevistas(textoConfig) {
  const config = JSON.parse(textoConfig);
  const urls = [];
  if (String(config.url_base_global || "").trim()) urls.push(urlExportacion(config.url_base_global, "csv"));
  for (const linea of config.lineas_credito || []) {
    if (String(linea.url || "").trim()) urls.push(urlExportacion(linea.url, "xlsx"));
  }
  if (String(config.url_whatsapp || "").trim()) urls.push(urlExportacion(config.url_whatsapp, "csv"));
  return [...new Set(urls)].filter((u) => u.startsWith("https://"));
}

async function bajarUna(url) {
  const cabeceras = tokenGoogle && HOSTS_GOOGLE.includes(new URL(url).hostname) ? { Authorization: "Bearer " + tokenGoogle } : {};
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const resp = await fetch(url, { headers: cabeceras, cache: "no-store" });
      if (resp.status >= 500 || resp.status === 429) continue;
      return { estado: resp.status, datos: new Uint8Array(await resp.arrayBuffer()), urlFinal: resp.url, tipo: resp.headers.get("Content-Type") || "" };
    } catch (_) { /* sin conexión o corte de Google: otro intento */ }
  }
  return null;
}

// Devuelve las descargas que salieron bien: [{ url, estado, datos, urlFinal, tipo }].
async function precargar(urls) {
  const inicio = performance.now();
  const bajadas = [];
  let listas = 0, siguiente = 0;
  const contar = () => avisar(`Descargando las hojas a la vez: ${listas} de ${urls.length} listas` + (motorListo ? "…" : " (y preparando el motor)…"));
  contar();
  const tomar = async () => {
    while (siguiente < urls.length) {
      const url = urls[siguiente++];
      const t0 = performance.now();
      const r = await bajarUna(url);
      listas++;
      console.info(`[Axio] ${r ? (r.datos.length / 1048576).toFixed(1) + " MB" : "FALLÓ"} en ${((performance.now() - t0) / 1000).toFixed(1)} s · ${url.replace(/\/export.*$/, "")}`);
      if (r && r.estado < 400) bajadas.push({ url, ...r });
      contar();
    }
  };
  await Promise.all(Array.from({ length: Math.min(DESCARGAS_A_LA_VEZ, urls.length) }, tomar));
  const total = ((performance.now() - inicio) / 1000).toFixed(1);
  console.info(`[Axio] Descargas: ${total} s en total`);
  avisar(`${bajadas.length} de ${urls.length} hojas descargadas en ${total} s` + (motorListo ? ". Leyéndolas…" : ". Terminando de preparar el motor…"));
  return bajadas;
}

async function cargarDatos(accion, config) {
  if (accion === "configurar") ultimoConfig = config;
  let descargas = Promise.resolve([]);
  try {
    if (ultimoConfig) descargas = precargar(urlsPrevistas(ultimoConfig));
  } catch (e) {
    console.warn("[Axio] No se pudieron precargar las hojas; se bajan de a una", e);
  }
  const nav = await motorConToken();
  for (const b of await descargas) nav.guardar_precarga(b.url, b.datos, b.estado, b.urlFinal, b.tipo);
  const inicio = performance.now();
  // Por pasos (ver _pasos_carga en web/servicio.py): después de cada uno se suelta el
  // control un instante, y las búsquedas que llegaron mientras tanto se atienden. El primer
  // paso deja los Extractos listos: desde ahí puente.js deja pasar las búsquedas.
  const pasos = accion === "configurar" ? nav.configurar_por_pasos(config) : nav.recargar_por_pasos();
  try {
    let t = performance.now();
    let paso = pasos.next();
    let primero = true;
    while (!paso.done) {
      console.info(`[Axio] Lectura de ${paso.value}: ${((performance.now() - t) / 1000).toFixed(1)} s`);
      postMessage({ tipo: "paso", clave: paso.value });
      if (primero) {
        primero = false;
        console.info(`[Axio] Extractos listos para buscar: ${((performance.now() - inicio) / 1000).toFixed(1)} s`);
        postMessage({ tipo: "parcial" });
      }
      await new Promise((r) => setTimeout(r, 0));
      nav.fijar_token(tokenGoogle);   // pudo renovarse mientras tanto
      t = performance.now();
      paso = pasos.next();
    }
    console.info(`[Axio] Lectura y armado de los datos: ${((performance.now() - inicio) / 1000).toFixed(1)} s`);
    return paso.value;
  } finally {
    pasos.destroy();
  }
}
motor.then(() => { motorListo = true; }, () => {});

// El token se guarda al instante (no espera al motor: así el inicio de sesión y las
// descargas no quedan frenados mientras se instala Python) y se le pasa a Python justo
// antes de cada llamada.
async function motorConToken() {
  const nav = await motor;
  nav.fijar_token(tokenGoogle);
  return nav;
}

// Python corre en un solo hilo y cada llamada es síncrona. La carga va por pasos: las
// búsquedas se atienden entre uno y otro (puente.js las manda desde el aviso "parcial").
self.onmessage = async (ev) => {
  const { id, accion } = ev.data;
  try {
    if (accion === "token") {
      tokenGoogle = ev.data.token || "";
      postMessage({ tipo: "respuesta", id });
    } else if (accion === "configurar" || accion === "recargar") {
      const estado = await cargarDatos(accion, ev.data.config);
      postMessage({ tipo: "respuesta", id, estado: JSON.parse(estado) });
    } else if (accion === "api") {
      const nav = await motorConToken();
      const proxy = nav.atender(ev.data.url);
      const codigo = proxy.get(0), tipo = proxy.get(1), cuerpoPy = proxy.get(2);
      proxy.destroy();
      const cuerpo = aBytes(cuerpoPy).buffer;
      postMessage({ tipo: "respuesta", id, codigo, tipoContenido: tipo, cuerpo }, [cuerpo]);
    } else if (accion === "excel") {
      const d = ev.data;
      const nav = await motorConToken();
      postMessage({ tipo: "respuesta", id, datos: JSON.parse(nav.leer_excel(d.archivo, d.hoja || "", d.filas, d.columnas)) });
    }
  } catch (e) {
    // Un error de Python trae su traceback completo; a la pantalla solo va la última línea.
    const texto = String(e && e.message || e).trim().split("\n").pop();
    postMessage({ tipo: "respuesta", id, error: texto });
  }
};
