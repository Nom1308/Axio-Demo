/* Axio demo: arranque de Python, compartido por trabajador.js y ayudante.js.
 *
 * Carga Pyodide (Python compilado a WebAssembly), le instala pandas y openpyxl, baja el
 * código de Axio (py/) y deja importado motor/navegador.py.
 */
"use strict";

const VERSION_PYODIDE = "0.29.3";
importScripts(`https://cdn.jsdelivr.net/pyodide/v${VERSION_PYODIDE}/full/pyodide.js`);

const BASE = new URL("../", self.location.href).href;   // raíz del sitio

async function bajarTexto(ruta) {
  const resp = await fetch(BASE + ruta, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`No se pudo bajar ${ruta} (HTTP ${resp.status})`);
  return resp.text();
}

// Devuelve el módulo navegador de Python. avisar(texto) cuenta por dónde va.
async function prepararPython(avisar) {
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
  return pyodide.pyimport("navegador");
}

// bytes de Python -> Uint8Array con su propio buffer (para transferirlo sin copiar otra vez).
function aBytes(valor) {
  const vista = valor.getBuffer("u8");
  try { return vista.data.slice(); } finally { vista.release(); valor.destroy(); }
}
