/* Axio demo: la primera carga de las hojas, escondida en el logo.
 *
 * Nada de franjas, anillos ni porcentajes: los tres puntos dorados del logo de la barra
 * empiezan apagados y se van encendiendo, uno tras otro, a medida que llegan las hojas
 * (Extractos, cada línea de crédito, WhatsApp). Al terminar, el logo da un destello y el
 * buscador un brillo suave. Nadie lo lee como una carga: el logo cobra vida. El detalle de
 * cada hoja (lista o con error) sigue en el menú de la cuenta y en los avisos del buscador.
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

  let activa = false;
  let fuentes = [];          // [{clave, estado}]  estado: pendiente | leyendo | lista
  let inicioCarga = 0;
  let inicioPaso = 0;
  let descargadas = 0;       // fracción de la etapa de descargas
  let mostrado = 0;          // avance que se ve (0 a 1), persigue al real con suavidad
  let cuadro = 0;
  let ultimoCuadro = 0;
  const duracionEsperada = Math.max(10, Number(leer("axio-duracion-carga", 30)) || 30);   // segundos

  const logo = () => $(".barra .logo-barra");

  // Avance real: la etapa de descargas cuenta como una hoja más; cada hoja leída suma una;
  // la que se está leyendo avanza sola, sin pasar del 90 % de su parte.
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
    const l = logo();
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

  function empezar(lista) {
    if (activa) return;
    activa = true;
    inicioCarga = inicioPaso = performance.now();
    mostrado = descargadas = 0;
    fuentes = (lista && lista.length ? lista : [{ clave: "extractos" }]).map((f) => ({ clave: f.clave, estado: "pendiente" }));
    const l = logo();
    if (l) { l.classList.add("cargando"); pintar(0); }
    cuadro = requestAnimationFrame(animar);
  }

  window.addEventListener("axio-progreso", (ev) => {
    if (!activa) return;
    const texto = (ev.detail && ev.detail.mensaje) || "";
    const m = /(\d+) de (\d+) listas/.exec(texto);
    if (m) descargadas = Number(m[1]) / Number(m[2]);
    if (/descargadas en/.test(texto)) descargadas = 1;
    // El primer «Leyendo…» es el de los Extractos.
    if (/^Leyendo/.test(texto) && !fuentes.some((f) => f.estado !== "pendiente")) {
      inicioPaso = performance.now();
      fuentes[0].estado = "leyendo";
    }
  });

  window.addEventListener("axio-paso", (ev) => {
    if (!activa) return;
    const f = fuentes.find((x) => x.clave === ev.detail.clave);
    if (f) f.estado = "lista";
    const siguiente = fuentes.find((x) => x.estado === "pendiente");
    inicioPaso = performance.now();
    if (siguiente) siguiente.estado = "leyendo";
  });

  // Terminó: los tres puntos encendidos, el destello del logo y un brillo en el buscador.
  function terminar() {
    if (!activa) return;
    activa = false;
    cancelAnimationFrame(cuadro);
    guardar("axio-duracion-carga", Math.round((performance.now() - inicioCarga) / 1000));
    const l = logo();
    if (l) {
      // Los puntos que faltan se encienden uno tras otro (~0,65 s) y después el destello.
      const desde = mostrado, t0 = performance.now(), DURACION = 650;
      const paso = (ahora) => {
        const k = Math.min(1, (ahora - t0) / DURACION);
        pintar(desde + (1 - desde) * (1 - Math.pow(1 - k, 3)));
        if (k < 1) { requestAnimationFrame(paso); return; }
        l.classList.remove("cargando");
        l.classList.add("destello");
        setTimeout(() => l.classList.remove("destello"), 1400);
      };
      requestAnimationFrame(paso);
    }
    const caja = $("#form-busqueda");
    if (caja) {
      setTimeout(() => {
        caja.classList.add("axio-listo");
        setTimeout(() => caja.classList.remove("axio-listo"), 1600);
      }, 450);
    }
    const q = $("#q");
    if (q && !document.querySelector("dialog[open]") && !(document.activeElement && document.activeElement.closest("input, textarea, select"))) {
      q.focus({ preventScroll: true });
    }
  }

  window.addEventListener("axio-carga-inicio", (ev) => { if (ev.detail.accion === "configurar") empezar(ev.detail.fuentes); });
  window.addEventListener("axio-carga-fin", (ev) => { if (ev.detail.accion === "configurar") terminar(); });
})();
