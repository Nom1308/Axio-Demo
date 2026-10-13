/* Axio demo: la primera carga de las hojas, como una escena con la lupa del logo.
 *
 * Al iniciar sesión la lupa baja desde la tarjeta al lugar del buscador (la transición la
 * hace puente.js) y se queda ahí, grande: sus tres puntos dorados se van encendiendo a
 * medida que llegan las hojas, unas chispas doradas giran alrededor y debajo se lee qué se
 * está haciendo («Trayendo los Extractos…», «Leyendo Libre Inversión Mayor…»). El buscador
 * no se ve todavía. Al terminar, la lupa da un destello, dice «Todo listo», sube volando a
 * su lugar en la barra y en su lugar aparece el buscador.
 *
 * Lo mueven los eventos de puente.js:
 *   axio-carga-inicio  { accion, fuentes: [{clave, nombre}] }
 *   axio-progreso      { mensaje }            (descargas y lecturas)
 *   axio-paso          { clave }              (esa hoja ya se leyó)
 *   axio-carga-fin     { accion, error }
 * Solo en la primera carga: «Refrescar datos» no lo muestra.
 *
 * Solo guarda en este navegador cuánto tardó la última carga, para repartir el avance.
 * Nada de datos de las hojas.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const leer = (clave, porDefecto) => { try { return localStorage.getItem(clave) ?? porDefecto; } catch (_) { return porDefecto; } };
  const guardar = (clave, valor) => { try { localStorage.setItem(clave, String(valor)); } catch (_) { /* sin almacenamiento */ } };
  const sinMovimiento = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // La escena se ve al menos esto, aunque los datos lleguen al instante: que se alcance a
  // ver la lupa con su animación y no un parpadeo.
  const MS_MINIMO_ESCENA = 2600;

  let activa = false;
  let fuentes = [];          // [{clave, nombre, estado}]  estado: pendiente | leyendo | lista
  let inicioCarga = 0;
  let inicioPaso = 0;
  let descargadas = 0;       // fracción de la etapa de descargas
  let mostrado = 0;          // avance que se ve (0 a 1), persigue al real con suavidad
  let cuadro = 0;
  let ultimoCuadro = 0;
  const duracionEsperada = Math.max(10, Number(leer("axio-duracion-carga", 30)) || 30);   // segundos

  const escena = () => $("#carga-escena");
  const logoEscena = () => $("#carga-escena .ce-logo");

  // ------------------------------------------------------------------ lo que se lee
  let fraseActual = "";
  function frase(texto) {
    const n = $("#carga-escena .ce-frase");
    if (!n || texto === fraseActual) return;
    fraseActual = texto;
    // Cada frase entra de nuevo (ver «escena de carga» en demo.css).
    const nueva = n.cloneNode(false);
    nueva.textContent = texto;
    n.replaceWith(nueva);
  }
  function cuenta() {
    const n = $("#carga-escena .ce-cuenta");
    if (!n) return;
    const listas = fuentes.filter((f) => f.estado === "lista").length;
    n.textContent = `${listas} de ${fuentes.length} hoja${fuentes.length === 1 ? "" : "s"} lista${listas === 1 ? "" : "s"}`;
  }
  // «Leyendo Libre Inversión Mayor…»; WhatsApp y los Extractos con sus propias palabras.
  function fraseDe(f) {
    if (!f) return "Terminando…";
    if (f.clave === "extractos") return "Leyendo los Extractos…";
    if (f.clave === "whatsapp") return "Trayendo los contactos de WhatsApp…";
    return `Leyendo ${f.nombre}…`;
  }

  // ------------------------------------------------------------------ avance
  // La etapa de descargas cuenta como una hoja más; cada hoja leída suma una; la que se está
  // leyendo avanza sola, sin pasar del 90 % de su parte.
  function avanceReal() {
    const total = fuentes.length + 1;
    const listas = fuentes.filter((f) => f.estado === "lista").length;
    const leyendo = fuentes.some((f) => f.estado === "leyendo");
    const enCurso = leyendo ? 0.9 * (1 - Math.exp(-(performance.now() - inicioPaso) / 1600)) : 0;
    const descargas = listas || leyendo ? 1 : descargadas;
    return Math.min(0.97, (descargas + listas + enCurso) / total);
  }

  // Cada punto se enciende en su tercio del avance: el de la izquierda primero.
  function pintar(avance) {
    const l = logoEscena();
    if (!l) return;
    for (let i = 0; i < 3; i++) l.style.setProperty(`--p${i + 1}`, Math.max(0, Math.min(1, avance * 3 - i)).toFixed(3));
  }

  function animar(ahora) {
    if (!activa) return;
    // Si todavía no llega ningún aviso, el tiempo de la carga anterior da una idea.
    const porTiempo = 0.25 * (1 - Math.exp(-((performance.now() - inicioCarga) / 1000) / duracionEsperada));
    const objetivo = Math.max(avanceReal(), porTiempo);
    const dt = ultimoCuadro ? Math.min(200, ahora - ultimoCuadro) : 16;
    ultimoCuadro = ahora;
    mostrado += (objetivo - mostrado) * (1 - Math.exp(-dt / 260));
    pintar(mostrado);
    cuadro = requestAnimationFrame(animar);
  }

  // ------------------------------------------------------------------ empieza
  function empezar(lista) {
    if (activa || !escena()) return;
    activa = true;
    inicioCarga = inicioPaso = performance.now();
    mostrado = descargadas = 0;
    fuentes = (lista && lista.length ? lista : [{ clave: "extractos", nombre: "Extractos" }])
      .map((f) => ({ clave: f.clave, nombre: f.nombre || f.clave, estado: "pendiente" }));
    document.body.classList.add("cargando-app");
    escena().hidden = false;
    escena().classList.remove("ce-terminada");
    logoEscena().classList.add("cargando");
    frase("Conectando con tus hojas de Google…");
    cuenta();
    pintar(0);
    cuadro = requestAnimationFrame(animar);
  }

  window.addEventListener("axio-progreso", (ev) => {
    if (!activa) return;
    const texto = (ev.detail && ev.detail.mensaje) || "";
    const m = /(\d+) de (\d+) listas/.exec(texto);
    if (m) {
      descargadas = Number(m[1]) / Number(m[2]);
      frase("Trayendo los Extractos y las líneas de crédito…");
    }
    // Ya bajaron todas: empieza la lectura, por los Extractos.
    if (/descargadas en/.test(texto)) {
      descargadas = 1;
      if (!fuentes.some((f) => f.estado !== "pendiente")) {
        inicioPaso = performance.now();
        fuentes[0].estado = "leyendo";
        frase(fraseDe(fuentes[0]));
      }
    }
  });

  window.addEventListener("axio-paso", (ev) => {
    if (!activa) return;
    const f = fuentes.find((x) => x.clave === ev.detail.clave);
    if (f) f.estado = "lista";
    fuentes.filter((x) => x.estado === "leyendo").forEach((x) => { if (x !== f) x.estado = "pendiente"; });
    const siguiente = fuentes.find((x) => x.estado === "pendiente");
    inicioPaso = performance.now();
    if (siguiente) siguiente.estado = "leyendo";
    frase(fraseDe(siguiente));
    cuenta();
  });

  // ------------------------------------------------------------------ termina
  async function terminar(error) {
    if (!activa) return;
    guardar("axio-duracion-carga", Math.round((performance.now() - inicioCarga) / 1000));
    // Qué hoja quedó con error, según el estado del motor.
    let fallidas = 0;
    try {
      const est = await (await window.axioFetch("/api/estado")).json();
      fallidas = (est.fuentes || []).filter((f) => f.estado === "error").length;
    } catch (_) { /* sin estado */ }
    const quedan = MS_MINIMO_ESCENA - (performance.now() - inicioCarga);
    if (quedan > 0) await new Promise((r) => setTimeout(r, quedan));
    activa = false;
    cancelAnimationFrame(cuadro);
    fuentes.forEach((f) => { f.estado = "lista"; });
    cuenta();

    // Los puntos que faltan se encienden uno tras otro y la lupa da su destello.
    const l = logoEscena();
    const desde = mostrado, t0 = performance.now(), DURACION = sinMovimiento() ? 0 : 650;
    await new Promise((listo) => {
      const paso = (ahora) => {
        const k = DURACION ? Math.min(1, (ahora - t0) / DURACION) : 1;
        pintar(desde + (1 - desde) * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(paso); else listo();
      };
      requestAnimationFrame(paso);
    });
    if (l) { l.classList.remove("cargando"); l.classList.add("destello"); }
    escena().classList.add("ce-terminada");
    frase(error ? "No se pudieron cargar los datos" : fallidas ? `Listo · ${fallidas} hoja${fallidas === 1 ? "" : "s"} sin cargar` : "Todo listo");
    await new Promise((r) => setTimeout(r, sinMovimiento() ? 300 : 1100));
    revelar();
  }

  // La lupa sube a la barra y el buscador aparece donde ella estaba (View Transitions: la
  // lupa de la escena y el logo de la barra se llaman igual, «logo-axio»).
  function revelar() {
    const cambio = () => {
      escena().hidden = true;
      document.body.classList.remove("cargando-app");
      const panel = $(".panel-busqueda");
      if (panel) panel.classList.add("panel-llega");
    };
    const alFinal = () => {
      const logoBarra = $(".barra .logo-barra");
      if (logoBarra) {
        logoBarra.classList.add("destello");
        setTimeout(() => logoBarra.classList.remove("destello"), 1400);
      }
      const caja = $("#form-busqueda");
      if (caja) {
        caja.classList.add("axio-listo");
        setTimeout(() => caja.classList.remove("axio-listo"), 1600);
      }
      const q = $("#q");
      if (q && !document.querySelector("dialog[open]")) q.focus({ preventScroll: true });
    };
    if (document.startViewTransition && !sinMovimiento()) {
      const t = document.startViewTransition(cambio);
      t.ready.catch(() => {});
      t.finished.then(alFinal, alFinal);
    } else {
      cambio();
      alFinal();
    }
  }

  window.addEventListener("axio-carga-inicio", (ev) => { if (ev.detail.accion === "configurar") empezar(ev.detail.fuentes); });
  window.addEventListener("axio-carga-fin", (ev) => { if (ev.detail.accion === "configurar") terminar(ev.detail.error); });
})();
