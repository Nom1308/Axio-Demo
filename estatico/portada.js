/* Axio: la presentación de la página de inicio de sesión.
 *
 * Lo comparten el login del servidor (plantillas/login.html) y la portada de la versión de
 * navegador (la demo). Nada de esto toca datos: es solo la puesta en escena.
 *
 *   - Puntos dorados que flotan en el fondo y, al final, viajan al logo y se funden en sus
 *     tres puntos (window.axioPortada.reunir). En la demo eso pasa cuando el motor de Python
 *     está listo (puente.js); en el servidor, apenas se dibuja el logo.
 *   - «Axio» se revela letra por letra y una onda dorada lo recorre; la frase, palabra por
 *     palabra.
 *   - La tarjeta se inclina levemente siguiendo el mouse (o la inclinación del celular), con
 *     un reflejo de luz encima; el fondo se mueve un poco más lento y da sensación de capas.
 *   - La aurora del fondo cambia de tono según la hora: mañana, tarde o noche.
 *
 * Con «reducir movimiento» en el sistema no se mueve nada: todo aparece en su sitio.
 */
(function () {
  "use strict";

  const sinMovimiento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const raiz = document.documentElement;

  // ------------------------------------------------------------------ el cielo según la hora
  const hora = new Date().getHours();
  raiz.dataset.momento = hora >= 5 && hora < 12 ? "manana" : hora >= 12 && hora < 18 ? "tarde" : "noche";

  const tarjeta = document.querySelector(".tarjeta-login");
  const logo = document.querySelector(".logo-entrada");
  const nada = () => Promise.resolve();
  window.axioPortada = { reunir: nada, apagar: () => {} };
  if (!tarjeta || !logo || sinMovimiento) return;

  // ------------------------------------------------------------------ nombre y frase
  // Cada letra (y cada palabra) en su propio span, con --i para escalonar la entrada. El
  // texto completo queda en aria-label: un lector de pantalla lo lee entero.
  function partir(nodo, porLetra, clase) {
    if (!nodo) return;
    const texto = nodo.textContent.trim();
    nodo.setAttribute("aria-label", texto);
    nodo.textContent = "";
    const trozos = porLetra ? [...texto] : texto.split(/\s+/);
    trozos.forEach((t, i) => {
      if (i && !porLetra) nodo.append(" ");
      const s = document.createElement("span");
      s.className = clase;
      s.textContent = t;
      s.setAttribute("aria-hidden", "true");
      s.style.setProperty("--i", i);
      nodo.append(s);
    });
  }
  const titulo = tarjeta.querySelector(".login-marca h1");
  const frase = tarjeta.querySelector(".login-marca .subtitulo");
  partir(titulo, true, "letra");
  partir(frase, false, "palabra");
  if (titulo) titulo.classList.add("titulo-letras");
  if (frase) frase.classList.add("frase-palabras");

  // ------------------------------------------------------------------ puntos dorados
  const lienzo = document.createElement("canvas");
  lienzo.className = "particulas";
  lienzo.setAttribute("aria-hidden", "true");
  (document.querySelector(".aurora") || document.body.firstChild).after(lienzo);
  const ctx = lienzo.getContext("2d");
  let ancho = 0, alto = 0, escala = 1;

  function medir() {
    escala = Math.min(2, window.devicePixelRatio || 1);
    ancho = window.innerWidth;
    alto = window.innerHeight;
    lienzo.width = Math.round(ancho * escala);
    lienzo.height = Math.round(alto * escala);
    ctx.setTransform(escala, 0, 0, escala, 0, 0);
  }
  medir();
  window.addEventListener("resize", medir);

  // Un punto de luz dibujado una vez y estampado muchas (más barato que un desenfoque).
  const sello = document.createElement("canvas");
  sello.width = sello.height = 64;
  const s = sello.getContext("2d");
  const brillo = s.createRadialGradient(32, 32, 0, 32, 32, 32);
  brillo.addColorStop(0, "rgba(255, 236, 170, 1)");
  brillo.addColorStop(.18, "rgba(255, 210, 90, .95)");
  brillo.addColorStop(.45, "rgba(252, 180, 0, .35)");
  brillo.addColorStop(1, "rgba(252, 180, 0, 0)");
  s.fillStyle = brillo;
  s.fillRect(0, 0, 64, 64);

  const azar = (a, b) => a + Math.random() * (b - a);
  const cuantos = ancho < 600 ? 34 : 64;
  const puntos = Array.from({ length: cuantos }, () => ({
    x: azar(0, ancho), y: azar(0, alto),
    vx: azar(-6, 6), vy: azar(-9, -2),        // suben despacio, como polvo de luz
    r: azar(.8, 2.6), fase: azar(0, 6.3), parpadeo: azar(.6, 1.6),
  }));

  let estado = "flotar";      // flotar → reunir → fin
  let inicioReunion = 0;
  const DURACION_REUNION = 950;
  let anterior = performance.now();
  let encendido = true;
  let opacidadGeneral = 0;    // entran suavemente

  // Los tres puntos dorados del logo, en pantalla (el dibujo mide 64 × 64).
  function destinos() {
    const r = logo.getBoundingClientRect();
    const k = r.width / 64;
    return [[50, 13, 4.5, .5], [41, 9, 2.6, .25], [55.5, 22, 2.6, .25]].map(([x, y, radio, peso]) =>
      ({ x: r.left + x * k, y: r.top + y * k, radio: radio * k, peso }));
  }

  const suave = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function cuadro(ahora) {
    if (!encendido) return;
    const dt = Math.min(.05, (ahora - anterior) / 1000);
    anterior = ahora;
    ctx.clearRect(0, 0, ancho, alto);
    opacidadGeneral = Math.min(1, opacidadGeneral + dt * .8);
    let llegaron = 0;
    for (const p of puntos) {
      let x, y, r, a;
      if (estado === "flotar") {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.y < -10) { p.y = alto + 10; p.x = azar(0, ancho); }
        if (p.x < -10) p.x = ancho + 10;
        if (p.x > ancho + 10) p.x = -10;
        x = p.x + Math.sin(ahora / 1700 + p.fase) * 6;
        y = p.y;
        r = p.r;
        a = (.25 + .3 * (1 + Math.sin(ahora / 1000 * p.parpadeo + p.fase)) / 2) * opacidadGeneral;
      } else {
        // Viajan en curva hasta su punto del logo y se apagan al fundirse en él.
        const t = Math.max(0, Math.min(1, ((ahora - inicioReunion) / DURACION_REUNION - p.retraso) / (1 - p.retraso)));
        const e = suave(t);
        const u = 1 - e;
        x = u * u * p.desde.x + 2 * u * e * p.control.x + e * e * p.meta.x;
        y = u * u * p.desde.y + 2 * u * e * p.control.y + e * e * p.meta.y;
        r = p.r + (p.meta.radio * .6 - p.r) * e;
        a = t < .85 ? .55 + .45 * e : (1 - t) / .15;
        if (t >= 1) llegaron++;
      }
      if (a <= 0) continue;
      const lado = r * 9;
      ctx.globalAlpha = Math.min(1, a);
      ctx.drawImage(sello, x - lado / 2, y - lado / 2, lado, lado);
    }
    ctx.globalAlpha = 1;
    if (estado === "reunir" && llegaron === puntos.length) { estado = "fin"; apagar(); return; }
    requestAnimationFrame(cuadro);
  }
  requestAnimationFrame(cuadro);

  // Se juntan en el logo. La promesa se cumple un poco antes de que lleguen: en ese
  // momento hay que empezar a dibujar el mango y los puntos para que coincidan.
  function reunir() {
    if (estado !== "flotar") return nada();
    const metas = destinos();
    inicioReunion = performance.now();
    for (const p of puntos) {
      const u = Math.random();
      const meta = u < metas[0].peso ? metas[0] : u < metas[0].peso + metas[1].peso ? metas[1] : metas[2];
      const desde = { x: p.x, y: p.y };
      const dx = meta.x - desde.x, dy = meta.y - desde.y;
      const giro = azar(-.45, .45);   // curva hacia un lado o el otro
      p.desde = desde;
      p.meta = { x: meta.x + azar(-1.5, 1.5), y: meta.y + azar(-1.5, 1.5), radio: meta.radio };
      p.control = { x: desde.x + dx * .5 - dy * giro, y: desde.y + dy * .5 + dx * giro };
      p.retraso = azar(0, .18);
    }
    estado = "reunir";
    return new Promise((listo) => setTimeout(listo, DURACION_REUNION * .5));
  }

  function apagar() {
    lienzo.classList.add("apagando");
    setTimeout(() => { encendido = false; lienzo.remove(); window.removeEventListener("resize", medir); }, 900);
  }

  // ------------------------------------------------------------------ profundidad
  // La tarjeta se inclina hasta ~5° hacia el puntero, con un reflejo donde está la luz; el
  // fondo se corre un poco al revés. Se activa al terminar la entrada de la tarjeta (antes,
  // su animación de aparición manda sobre la inclinación).
  const conMouse = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  let vivo = false;
  tarjeta.addEventListener("animationend", (ev) => { if (ev.target === tarjeta) { vivo = true; tarjeta.classList.add("tarjeta-viva"); } });
  setTimeout(() => { vivo = true; tarjeta.classList.add("tarjeta-viva"); }, 1200);   // por si la animación no avisa

  function inclinar(nx, ny) {
    // nx, ny entre -0,5 y 0,5: dónde está la luz respecto del centro de la pantalla.
    if (!vivo) return;
    tarjeta.style.setProperty("--rx", (-ny * 7).toFixed(2) + "deg");
    tarjeta.style.setProperty("--ry", (nx * 9).toFixed(2) + "deg");
    raiz.style.setProperty("--px", (-nx * 26).toFixed(1) + "px");
    raiz.style.setProperty("--py", (-ny * 20).toFixed(1) + "px");
  }

  function alMover(ev) {
    inclinar(ev.clientX / window.innerWidth - .5, ev.clientY / window.innerHeight - .5);
    const r = tarjeta.getBoundingClientRect();
    tarjeta.style.setProperty("--lx", ((ev.clientX - r.left) / r.width * 100).toFixed(1) + "%");
    tarjeta.style.setProperty("--ly", ((ev.clientY - r.top) / r.height * 100).toFixed(1) + "%");
    tarjeta.classList.add("con-luz");
  }
  function alSalir() { inclinar(0, 0); tarjeta.classList.remove("con-luz"); }
  // En el celular, con la inclinación del teléfono (donde el navegador lo da sin pedir permiso).
  function alInclinar(ev) {
    if (ev.gamma == null || ev.beta == null) return;
    const nx = Math.max(-.5, Math.min(.5, ev.gamma / 50));
    const ny = Math.max(-.5, Math.min(.5, (ev.beta - 45) / 60));
    inclinar(nx, ny);
  }

  if (conMouse) {
    document.addEventListener("pointermove", alMover, { passive: true });
    document.addEventListener("pointerleave", alSalir);
  } else if ("DeviceOrientationEvent" in window && typeof DeviceOrientationEvent.requestPermission !== "function") {
    window.addEventListener("deviceorientation", alInclinar, { passive: true });
  }

  // ------------------------------------------------------------------ para quien la usa
  window.axioPortada = {
    reunir,
    // Al dejar la portada (la demo entra a la aplicación en la misma página).
    apagar: () => {
      document.removeEventListener("pointermove", alMover);
      document.removeEventListener("pointerleave", alSalir);
      window.removeEventListener("deviceorientation", alInclinar);
      raiz.style.removeProperty("--px");
      raiz.style.removeProperty("--py");
      if (encendido) apagar();
    },
  };

  // En el servidor no hay motor que esperar: los puntos se juntan apenas el aro de la lupa
  // está dibujado, a tiempo con los puntos dorados de la entrada (ver «entrada» en estilos.css).
  if (!document.body.classList.contains("esperando-motor")) setTimeout(reunir, 600);
})();
