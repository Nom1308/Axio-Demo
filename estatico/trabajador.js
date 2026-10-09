/* Axio demo: el "servidor" que corre dentro de la pestaña.
 *
 * Arranca Pyodide (Python compilado a WebAssembly), le instala pandas y openpyxl, baja el
 * código de Axio (py/) y responde las llamadas /api/... de app.js con motor/navegador.py.
 * Va en un Worker para que buscar en 60.000 filas no congele la página.
 */
"use strict";

// prepararPython, aBytes y BASE (compartidos con ayudante.js).
importScripts("python.js" + self.location.search);

const avisar = (mensaje) => postMessage({ tipo: "progreso", mensaje });

async function arrancar() {
  const nav = await prepararPython(avisar);
  postMessage({ tipo: "motor-listo" });
  return nav;
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
  // https y, para las pruebas en este equipo, http://localhost.
  return [...new Set(urls)].filter((u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u));
}

// ------------------------------------------------------------------ ayudantes
// Leer las hojas es lo que más tarda, y Python lee de a una. Si el equipo tiene núcleos y
// memoria de sobra, uno o dos ayudantes (ayudante.js, cada uno con su propio Python) leen
// algunas líneas mientras este trabajador lee los Extractos y las demás. Arrancan apenas
// llega el config, a la par de las descargas, y se cierran al terminar la carga.
function ayudantesDelEquipo() {
  if (typeof Worker === "undefined") return 0;
  const nucleos = navigator.hardwareConcurrency || 2;
  const memoria = navigator.deviceMemory || 4;   // GB (solo Chrome lo dice; si no, 4)
  return Math.max(0, Math.min(2, nucleos - 2, memoria >= 8 ? 2 : memoria >= 4 ? 1 : 0));
}

// Preparar Python toma varios segundos: los ayudantes arrancan con la página, mientras se
// inicia sesión, para estar listos cuando lleguen las hojas.
let ayudantesPreparados = [];

// Los que hacen falta para estas líneas (uno por cada tres), de los preparados; los que
// sobran se cierran. En un «Refrescar» ya no hay: uno nuevo tardaría más en preparar su
// Python que lo que ahorra, así que ahí lee solo el trabajador, como siempre.
function tomarAyudantes(nLineas) {
  const n = Math.floor(nLineas / 3);
  const lista = ayudantesPreparados;
  ayudantesPreparados = [];
  lista.slice(n).forEach((a) => a.cerrar());
  return lista.slice(0, n);
}

function crearAyudante() {
  const w = new Worker("ayudante.js" + self.location.search);
  const esperando = new Map();   // clave -> resolver
  const responder = (clave, respuesta) => { const r = esperando.get(clave); if (r) { esperando.delete(clave); r(respuesta); } };
  w.onmessage = (ev) => responder(ev.data.clave, ev.data);
  w.onerror = (ev) => { ev.preventDefault(); for (const clave of [...esperando.keys()]) responder(clave, { clave, error: "el ayudante se detuvo" }); };
  return {
    carga: 0,
    leer(linea) {
      return new Promise((resolver) => {
        esperando.set(linea.clave, resolver);
        // Una copia: el trabajador conserva la suya por si tiene que leerla él.
        const datos = linea.datos.slice();
        w.postMessage({ ...linea, datos }, [datos.buffer]);
      });
    },
    cerrar() { w.terminate(); for (const clave of [...esperando.keys()]) responder(clave, { clave, error: "cerrado" }); },
  };
}

// Reparte las líneas descargadas: las más pesadas primero, cada una a quien tenga menos
// trabajo. El trabajador empieza con los Extractos encima. Devuelve {clave: promesa}.
function repartir(ayudantes, lineas, pesoExtractos) {
  const promesas = {};
  let propio = pesoExtractos;
  for (const l of [...lineas].sort((a, b) => b.datos.length - a.datos.length)) {
    const libre = ayudantes.reduce((m, a) => (a.carga < m.carga ? a : m), ayudantes[0]);
    if (libre && libre.carga < propio) {
      libre.carga += l.datos.length;
      promesas[l.clave] = libre.leer(l);
    } else {
      propio += l.datos.length;
    }
  }
  return promesas;
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
  let lineasConfig = [];   // [{clave, urlOriginal, url}] de las líneas con dirección
  let ayudantes = [];
  try {
    if (ultimoConfig) {
      descargas = precargar(urlsPrevistas(ultimoConfig));
      lineasConfig = (JSON.parse(ultimoConfig).lineas_credito || []).filter((l) => String(l.url || "").trim())
        .map((l) => ({ clave: l.clave, urlOriginal: l.url, url: urlExportacion(l.url, "xlsx") }));
      ayudantes = tomarAyudantes(lineasConfig.length);
      if (ayudantes.length) console.info(`[Axio] ${ayudantes.length} ayudante(s) para leer las líneas a la vez`);
    }
  } catch (e) {
    console.warn("[Axio] No se pudieron precargar las hojas; se bajan de a una", e);
  }
  let nav, bajadas;
  try {
    nav = await motorConToken();
    bajadas = await descargas;
  } catch (e) {
    ayudantes.forEach((a) => a.cerrar());
    throw e;
  }
  for (const b of bajadas) nav.guardar_precarga(b.url, b.datos, b.estado, b.urlFinal, b.tipo);

  // Las líneas que van a los ayudantes (solo las que se descargaron bien aquí).
  let deAyudantes = {};
  if (ayudantes.length) {
    const porUrl = new Map(bajadas.map((b) => [b.url, b]));
    const lineas = lineasConfig.filter((l) => porUrl.has(l.url)).map((l) => ({ ...porUrl.get(l.url), ...l }));
    const extractos = bajadas.find((b) => !lineasConfig.some((l) => l.url === b.url));
    // Un CSV se lee varias veces más rápido que un Excel del mismo tamaño.
    deAyudantes = repartir(ayudantes, lineas, extractos ? extractos.datos.length / 4 : 0);
  }
  nav.delegar(JSON.stringify(Object.keys(deAyudantes)));

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
      // «esperar:<clave>»: esa línea la está leyendo un ayudante; se espera su resultado
      // (sin frenar las búsquedas) y se le pasa a Python. Si el ayudante falló, Python la
      // lee por su cuenta.
      if (typeof paso.value === "string" && paso.value.startsWith("esperar:")) {
        const clave = paso.value.slice(8);
        const r = await (deAyudantes[clave] || Promise.resolve({ error: "sin ayudante" }));
        if (r.error) console.warn(`[Axio] El ayudante no pudo leer ${clave} (${r.error}); se lee aquí`);
        if (r.error) nav.recibir_roster(clave);
        else nav.recibir_roster(clave, r.datos);
        paso = pasos.next();
        continue;
      }
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
    ayudantes.forEach((a) => a.cerrar());   // su memoria se libera al terminar
  }
}
motor.then(() => { motorListo = true; }, () => {});
ayudantesPreparados = Array.from({ length: ayudantesDelEquipo() }, crearAyudante);

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
