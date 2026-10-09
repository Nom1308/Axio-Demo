/* Axio demo: la pantalla de la primera carga.
 *
 * Debajo del buscador: un anillo con el avance, el mensaje de lo que se está haciendo y una
 * tarjeta por hoja (Extractos, cada línea de crédito, WhatsApp) que se enciende cuando esa
 * hoja queda lista. Lo mueven los eventos de puente.js:
 *   axio-carga-inicio  { accion, fuentes: [{clave, nombre}] }
 *   axio-progreso      { mensaje }            (descargas y lecturas)
 *   axio-paso          { clave }              (esa hoja ya se leyó)
 *   axio-carga-parcial                         (ya se puede buscar en los Extractos)
 *   axio-carga-fin     { accion, error }
 * Al terminar, una onda sale del buscador hasta los bordes de la pantalla y el panel se
 * recoge. Solo en la primera carga: «Refrescar datos» no lo muestra.
 *
 * Solo guarda en este navegador cuánto tardó la última carga, para estimar el anillo. Nada
 * de datos de las hojas.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const leer = (clave, porDefecto) => { try { return localStorage.getItem(clave) ?? porDefecto; } catch (_) { return porDefecto; } };
  const guardar = (clave, valor) => { try { localStorage.setItem(clave, String(valor)); } catch (_) { /* sin almacenamiento */ } };
  const sinMovimiento = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const ICONOS = { extractos: "☁️", whatsapp: "💬" };
  const TEXTOS = { pendiente: "En espera", bajando: "Descargando", leyendo: "Leyendo", lista: "Lista", error: "Con error" };

  let panel = null;
  let fuentes = [];          // [{clave, nombre, estado, nodo}]
  let inicioCarga = 0;
  let cuadro = 0;
  let mostrado = 0;          // avance que se ve (0 a 1), persigue al real con suavidad
  let inicioPaso = 0;
  let descargadas = 0;       // fracción de la etapa de descargas
  const duracionEsperada = Math.max(10, Number(leer("axio-duracion-carga", 30)) || 30);   // segundos

  function nodo(etiqueta, props, ...hijos) {
    const n = document.createElement(etiqueta);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "style") n.style.cssText = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const h of hijos) if (h) n.append(h);
    return n;
  }

  // ------------------------------------------------------------------ panel
  function abrir(lista) {
    if (panel) return;
    inicioCarga = inicioPaso = performance.now();
    mostrado = descargadas = 0;
    fuentes = (lista && lista.length ? lista : [{ clave: "extractos", nombre: "Extractos" }]).map((f, i) => ({ ...f, estado: "pendiente", i }));

    const anillo = nodo("div", { class: "carga-orbe", "aria-hidden": "true" },
      nodo("span", { class: "carga-halo" }),
      nodo("span", { class: "carga-anillo" }),
      nodo("span", { class: "carga-orbita" }, nodo("i"), nodo("i"), nodo("i")),
      nodo("span", { class: "carga-centro" },
        nodo("span", { class: "carga-logo" }),
        nodo("strong", { class: "carga-porcentaje", text: "0 %" })));

    const tarjetas = nodo("ul", { class: "carga-fuentes" });
    for (const f of fuentes) {
      f.nodo = nodo("li", { class: "carga-fuente pendiente", style: `--i:${f.i}` },
        nodo("span", { class: "carga-fuente-icono", "aria-hidden": "true", text: ICONOS[f.clave] || "💳" }),
        nodo("span", { class: "carga-fuente-texto" },
          nodo("strong", { text: f.nombre }),
          nodo("span", { class: "carga-fuente-estado", text: TEXTOS.pendiente })),
        nodo("span", { class: "carga-fuente-marca", "aria-hidden": "true" }));
      tarjetas.append(f.nodo);
    }

    panel = nodo("section", { class: "carga", "aria-label": "Cargando Axio", "aria-live": "polite" },
      nodo("div", { class: "carga-cabecera" },
        anillo,
        nodo("div", { class: "carga-titulos" },
          nodo("strong", { class: "carga-titulo", text: "Preparando tus datos" }),
          nodo("span", { class: "carga-mensaje", text: "⏳ Preparando Axio…" }),
          nodo("div", { class: "carga-barra" }, nodo("span", { class: "carga-relleno" })))),
      tarjetas);
    const zona = $("#asociado-zona");
    zona.parentNode.insertBefore(panel, zona);
    cuadro = requestAnimationFrame(animar);
  }

  function ponerEstado(f, estado) {
    if (!f || f.estado === estado || (f.estado === "lista" && estado !== "error")) return;
    f.estado = estado;
    f.nodo.className = "carga-fuente " + estado;
    f.nodo.querySelector(".carga-fuente-estado").textContent = TEXTOS[estado];
  }

  // Avance real: la etapa de descargas cuenta como una hoja más; cada hoja leída suma una;
  // la que se está leyendo avanza sola, sin pasar del 90 % de su parte.
  function avanceReal() {
    const total = fuentes.length + 1;
    const listas = fuentes.filter((f) => f.estado === "lista" || f.estado === "error").length;
    const leyendo = fuentes.some((f) => f.estado === "leyendo");
    const enCurso = leyendo ? 0.9 * (1 - Math.exp(-(performance.now() - inicioPaso) / 1600)) : 0;
    const descargas = listas || leyendo ? 1 : descargadas;
    return Math.min(0.99, (descargas + listas + enCurso) / total);
  }

  let ultimoCuadro = 0;
  function animar(ahora) {
    if (!panel) return;
    // Si todavía no llega ningún aviso, el tiempo de la carga anterior da una idea.
    const porTiempo = 0.25 * (1 - Math.exp(-((performance.now() - inicioCarga) / 1000) / duracionEsperada));
    const objetivo = Math.max(avanceReal(), porTiempo);
    // Persigue al avance real con suavidad, igual de rápido con 30 o con 144 cuadros por segundo.
    const dt = ultimoCuadro ? Math.min(200, ahora - ultimoCuadro) : 16;
    ultimoCuadro = ahora;
    mostrado += (objetivo - mostrado) * (1 - Math.exp(-dt / 220));
    pintarAvance(mostrado);
    cuadro = requestAnimationFrame(animar);
  }

  function pintarAvance(f) {
    if (!panel) return;
    panel.style.setProperty("--avance", f.toFixed(4));
    panel.querySelector(".carga-porcentaje").textContent = Math.floor(f * 100) + " %";
  }

  // ------------------------------------------------------------------ eventos de la carga
  window.addEventListener("axio-progreso", (ev) => {
    if (!panel) return;
    const texto = ev.detail.mensaje || "";
    panel.querySelector(".carga-mensaje").textContent = "⏳ " + texto;
    const m = /(\d+) de (\d+) listas/.exec(texto);
    if (m) {
      descargadas = Number(m[1]) / Number(m[2]);
      for (const f of fuentes) if (f.estado === "pendiente") ponerEstado(f, "bajando");
    }
    if (/descargadas en/.test(texto)) {
      descargadas = 1;
      for (const f of fuentes) if (f.estado === "bajando") ponerEstado(f, "pendiente");
    }
    // El primer «Leyendo…» es el de los Extractos.
    if (/^Leyendo/.test(texto) && !fuentes.some((f) => f.estado === "leyendo" || f.estado === "lista")) {
      inicioPaso = performance.now();
      ponerEstado(fuentes[0], "leyendo");
    }
  });

  window.addEventListener("axio-paso", (ev) => {
    if (!panel) return;
    const f = fuentes.find((x) => x.clave === ev.detail.clave);
    ponerEstado(f, "lista");
    // La siguiente pendiente es la que se empieza a leer (WhatsApp va después de las líneas).
    const siguiente = fuentes.find((x) => x.estado !== "lista" && x.estado !== "error");
    inicioPaso = performance.now();
    if (siguiente) ponerEstado(siguiente, "leyendo");
  });

  window.addEventListener("axio-carga-parcial", () => {
    if (!panel || panel.querySelector(".carga-nota")) return;
    panel.querySelector(".carga-titulos").append(nodo("p", { class: "carga-nota",
      text: "✓ Ya puedes buscar en los Extractos. Las líneas de crédito se suman solas." }));
  });

  // ------------------------------------------------------------------ final
  async function terminar(error) {
    if (!panel) return;
    const p = panel;
    panel = null;
    cancelAnimationFrame(cuadro);
    guardar("axio-duracion-carga", Math.round((performance.now() - inicioCarga) / 1000));

    // Qué hoja quedó con error, según el estado del motor.
    let conError = new Set();
    try {
      const est = await (await window.axioFetch("/api/estado")).json();
      conError = new Set((est.fuentes || []).filter((f) => f.estado === "error").map((f) => f.clave));
    } catch (_) { /* sin estado: todas se marcan listas */ }
    fuentes.forEach((f, i) => setTimeout(() => ponerEstado(f, conError.has(f.clave) ? "error" : "lista"), i * 60));

    p.style.setProperty("--avance", "1");
    p.querySelector(".carga-porcentaje").textContent = "100 %";
    p.classList.add("carga-completa");
    p.querySelector(".carga-titulo").textContent = error || conError.size ? "Axio está listo, con avisos" : "¡Axio está listo!";
    p.querySelector(".carga-mensaje").textContent = conError.size
      ? `⚠️ ${conError.size} hoja${conError.size === 1 ? "" : "s"} no se pudo cargar: revisa el menú de tu cuenta`
      : "✓ Todas las hojas cargadas · ¡a buscar!";
    const nota = p.querySelector(".carga-nota");
    if (nota) nota.remove();

    const caja = $("#form-busqueda");
    setTimeout(() => {
      if (caja) {
        onda(caja, conError.size ? "ambar" : "azul");
        caja.classList.add("axio-listo");
        setTimeout(() => caja.classList.remove("axio-listo"), 1600);
      }
    }, 650);
    setTimeout(() => {
      p.style.height = p.offsetHeight + "px";
      requestAnimationFrame(() => p.classList.add("carga-cerrando"));
      setTimeout(() => p.remove(), 650);
      const q = $("#q");
      if (q && !document.querySelector("dialog[open]") && !document.activeElement.closest("input, textarea, select")) q.focus({ preventScroll: true });
    }, 2100);
  }

  // Una onda de luz que sale del buscador hasta los bordes de la pantalla: «ya terminó».
  function onda(desde, tono) {
    if (sinMovimiento() || !desde.animate) return;
    const r = desde.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const radio = Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy)) + 40;
    const capa = nodo("div", { class: "onda-capa " + tono, "aria-hidden": "true" });
    document.body.append(capa);
    const anillos = [0, 160, 330].map((retraso, i) => {
      const a = nodo("span", { class: "onda-anillo" + (i === 0 ? " onda-principal" : ""),
        style: `left:${cx}px;top:${cy}px;width:${radio * 2}px;height:${radio * 2}px;margin:${-radio}px 0 0 ${-radio}px` });
      capa.append(a);
      return a.animate([
        { transform: "scale(0.02)", opacity: 0 },
        { opacity: i === 0 ? 1 : 0.7, offset: 0.12 },
        { transform: "scale(1)", opacity: 0 },
      ], { duration: 1500 + i * 150, delay: retraso, easing: "cubic-bezier(.16, .84, .3, 1)", fill: "both" }).finished;
    });
    const destello = nodo("span", { class: "onda-destello", style: `left:${cx}px;top:${cy}px` });
    capa.append(destello);
    destello.animate([{ opacity: 0, transform: "translate(-50%, -50%) scale(.4)" }, { opacity: 1, offset: 0.25 },
      { opacity: 0, transform: "translate(-50%, -50%) scale(2.6)" }], { duration: 1100, easing: "ease-out", fill: "both" });
    Promise.all(anillos).then(() => capa.remove(), () => capa.remove());
  }
  window.axioOnda = onda;

  window.addEventListener("axio-carga-inicio", (ev) => { if (ev.detail.accion === "configurar") abrir(ev.detail.fuentes); });
  window.addEventListener("axio-carga-fin", (ev) => { if (ev.detail.accion === "configurar") terminar(ev.detail.error); });
})();
