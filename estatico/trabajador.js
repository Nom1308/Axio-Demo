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

// Los mensajes se atienden de a uno: Python corre en un solo hilo y cada llamada es
// síncrona, así que mientras se descargan las hojas las demás esperan en la cola.
self.onmessage = async (ev) => {
  const { id, accion } = ev.data;
  try {
    const nav = await motor;
    if (accion === "token") {
      nav.fijar_token(ev.data.token || "");
      postMessage({ tipo: "respuesta", id });
    } else if (accion === "configurar" || accion === "recargar") {
      const estado = accion === "configurar" ? nav.configurar(ev.data.config) : nav.recargar();
      postMessage({ tipo: "respuesta", id, estado: JSON.parse(estado) });
    } else if (accion === "api") {
      const proxy = nav.atender(ev.data.url);
      const codigo = proxy.get(0), tipo = proxy.get(1), cuerpoPy = proxy.get(2);
      proxy.destroy();
      const cuerpo = aBytes(cuerpoPy).buffer;
      postMessage({ tipo: "respuesta", id, codigo, tipoContenido: tipo, cuerpo }, [cuerpo]);
    } else if (accion === "excel") {
      const d = ev.data;
      postMessage({ tipo: "respuesta", id, datos: JSON.parse(nav.leer_excel(d.archivo, d.hoja || "", d.filas, d.columnas)) });
    }
  } catch (e) {
    // Un error de Python trae su traceback completo; a la pantalla solo va la última línea.
    const texto = String(e && e.message || e).trim().split("\n").pop();
    postMessage({ tipo: "respuesta", id, error: texto });
  }
};
