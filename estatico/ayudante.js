/* Axio demo: un ayudante que lee líneas de crédito mientras trabajador.js lee las suyas.
 *
 * Python en el navegador tiene un solo hilo: leer siete hojas de Excel es leerlas una
 * detrás de otra. Con uno o dos ayudantes (cada uno con su propio Python) se leen a la
 * vez. Recibe la hoja ya descargada, la lee con el mismo código de Axio y devuelve el
 * resultado empaquetado (pickle) para que el trabajador lo use tal cual. Si algo falla,
 * lo dice y el trabajador lee esa línea por su cuenta.
 */
"use strict";

importScripts("python.js" + self.location.search);

const listo = prepararPython(() => {});

self.onmessage = async (ev) => {
  const { clave, urlOriginal, url, datos, estado, urlFinal, tipo } = ev.data;
  try {
    const nav = await listo;
    const t0 = performance.now();
    nav.guardar_precarga(url, datos, estado, urlFinal, tipo);
    const roster = aBytes(nav.leer_linea(urlOriginal, clave));
    console.info(`[Axio] Ayudante: ${clave} leída en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    postMessage({ clave, datos: roster }, [roster.buffer]);
  } catch (e) {
    postMessage({ clave, error: String(e && e.message || e).trim().split("\n").pop() });
  }
};
