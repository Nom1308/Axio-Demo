/* Axio demo: «Atrapa los comprobantes», el juego escondido. 🥚
 *
 * Se abre con 17 clics seguidos en el logo de la lupa (desde el clic 10 la lupa se mueve
 * un poquito, como pista). Se juega en una ventana aparte: no toca nada de Axio.
 * Solo guarda en este navegador el récord.
 */
(function () {
  "use strict";

  const CLICS_SECRETOS = 17;
  const PISTA_DESDE = 10;
  const PAUSA_MAXIMA_MS = 1500;   // más tiempo entre clics y la cuenta vuelve a cero

  // Lo que cae: lo bueno suma, la mora quita una vida.
  const COSAS = [
    { emoji: "🧾", puntos: 10, peso: 40 },
    { emoji: "💵", puntos: 5, peso: 30 },
    { emoji: "💳", puntos: 15, peso: 15 },
    { emoji: "⭐", puntos: 50, peso: 3 },
    { emoji: "🔴", puntos: 0, peso: 18, malo: true },
  ];
  const PESO_TOTAL = COSAS.reduce((s, c) => s + c.peso, 0);
  const FUENTE_EMOJI = "'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif";
  const ALTO = 340;
  const reducirMovimiento = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const leerRecord = () => { try { return Number(localStorage.getItem("axio-record-juego")) || 0; } catch (_) { return 0; } };
  const guardarRecord = (n) => { try { localStorage.setItem("axio-record-juego", String(n)); } catch (_) { /* sin almacenamiento */ } };

  function nodo(etiqueta, props, ...hijos) {
    const n = document.createElement(etiqueta);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const h of hijos) if (h) n.append(h);
    return n;
  }

  // ------------------------------------------------------------------ el secreto: 17 clics
  let clics = 0, ultimoClic = 0;
  document.addEventListener("click", (ev) => {
    const logo = ev.target.closest(".logo");
    if (!logo) return;
    const ahora = Date.now();
    clics = ahora - ultimoClic > PAUSA_MAXIMA_MS ? 1 : clics + 1;
    ultimoClic = ahora;
    if (clics >= PISTA_DESDE && clics < CLICS_SECRETOS && !reducirMovimiento) {
      logo.classList.remove("logo-pista");
      void logo.offsetWidth;   // reinicia la animación
      logo.classList.add("logo-pista");
    }
    if (clics >= CLICS_SECRETOS) {
      clics = 0;
      logo.classList.remove("logo-pista");
      abrir();
    }
  });

  // ------------------------------------------------------------------ ventana
  let ventana = null;
  let juego = null;

  function abrir() {
    if (!ventana) {
      ventana = nodo("dialog", { class: "juego-secreto", "aria-label": "Juego secreto" });
      ventana.addEventListener("close", detener);
      document.body.append(ventana);
    }
    detener();
    const record = leerRecord();
    const lienzo = nodo("canvas", { class: "juego-lienzo", tabindex: "0", "aria-label": "Mueve la bandeja con el mouse o las flechas" });
    ventana.replaceChildren(
      nodo("div", { class: "juego-secreto-cabecera" },
        nodo("strong", { text: "🥚 ¡Encontraste el juego secreto!" }),
        nodo("button", { class: "boton boton-texto boton-cerrar", type: "button", "aria-label": "Cerrar", text: "✕", onclick: () => ventana.close() })),
      nodo("div", { class: "juego-escena" }, lienzo,
        nodo("div", { class: "juego-capa" },
          nodo("div", { class: "juego-portada" },
            nodo("strong", { text: "🎮 Atrapa los comprobantes" }),
            nodo("p", { text: "Atrapa 🧾 💵 💳 ⭐ con la bandeja y esquiva la mora 🔴. Mueve el mouse, el dedo o las flechas." }),
            record ? nodo("p", { class: "juego-record", text: `🏆 Tu récord: ${record} puntos` }) : null,
            nodo("div", { class: "juego-botones" },
              nodo("button", { class: "boton boton-principal", type: "button", text: "▶ Jugar", onclick: empezar }))))));
    if (!ventana.open) ventana.showModal();
    ajustarLienzo();
    ventana.querySelector(".juego-capa .boton-principal").focus();
  }

  function detener() {
    if (juego) { juego.terminado = true; cancelAnimationFrame(juego.cuadro); }
    juego = null;
  }

  function ajustarLienzo() {
    const lienzo = ventana && ventana.querySelector(".juego-lienzo");
    if (!lienzo) return;
    const ancho = lienzo.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;
    lienzo.width = Math.round(ancho * dpr);
    lienzo.height = Math.round(ALTO * dpr);
    lienzo.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    if (juego) { juego.ancho = ancho; juego.x = Math.min(juego.x, ancho - 40); }
  }
  window.addEventListener("resize", () => { if (ventana && ventana.open) ajustarLienzo(); });

  // ------------------------------------------------------------------ el juego
  function empezar() {
    const lienzo = ventana.querySelector(".juego-lienzo");
    ventana.querySelector(".juego-capa").hidden = true;
    detener();
    ajustarLienzo();
    const ancho = lienzo.clientWidth;
    juego = { ancho, x: ancho / 2, objetivo: ancho / 2, cosas: [], textos: [], puntos: 0, vidas: 3, t: 0, proxima: 0.6,
      ultimo: performance.now(), teclas: new Set(), terminado: false, cuadro: 0 };
    lienzo.focus({ preventScroll: true });
    lienzo.onpointermove = (ev) => { if (juego) { const r = lienzo.getBoundingClientRect(); juego.objetivo = ev.clientX - r.left; } };
    lienzo.onpointerdown = (ev) => {
      if (juego && juego.vidas <= 0) { empezar(); return; }
      lienzo.onpointermove(ev);
    };
    lienzo.onkeydown = (ev) => {
      if (!juego) return;
      if (juego.vidas <= 0 && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); empezar(); return; }
      if (["ArrowLeft", "ArrowRight", "a", "d", "A", "D"].includes(ev.key)) { juego.teclas.add(ev.key.toLowerCase()); ev.preventDefault(); }
    };
    lienzo.onkeyup = (ev) => { if (juego) juego.teclas.delete(ev.key.toLowerCase()); };
    juego.cuadro = requestAnimationFrame(paso);
  }

  function elegirCosa() {
    let r = Math.random() * PESO_TOTAL;
    for (const c of COSAS) { r -= c.peso; if (r <= 0) return c; }
    return COSAS[0];
  }

  function paso() {
    const j = juego;
    if (!j || j.terminado) return;
    // Reloj propio: entre 0 y 50 ms por paso, aunque la pestaña se pause.
    const ahora = performance.now();
    const dt = Math.max(0, Math.min(0.05, (ahora - j.ultimo) / 1000));
    j.ultimo = ahora;
    j.t += dt;
    const velocidad = 130 + Math.min(220, j.t * 4.5);   // se pone más difícil con el tiempo

    const izquierda = j.teclas.has("arrowleft") || j.teclas.has("a"), derecha = j.teclas.has("arrowright") || j.teclas.has("d");
    if (izquierda || derecha) j.objetivo = j.x + (derecha ? 1 : -1) * 520 * dt;
    j.objetivo = Math.max(36, Math.min(j.ancho - 36, j.objetivo));
    j.x += (j.objetivo - j.x) * Math.min(1, dt * 14);

    if (j.vidas > 0) {
      j.proxima -= dt;
      if (j.proxima <= 0) {
        const c = elegirCosa();
        j.cosas.push({ ...c, x: 24 + Math.random() * (j.ancho - 48), y: -20, vy: velocidad * (0.8 + Math.random() * 0.45), giro: (Math.random() - 0.5) * 2, angulo: 0 });
        j.proxima = Math.max(0.28, 0.75 - j.t * 0.008);
      }
    }
    const yBandeja = ALTO - 34;
    for (const c of j.cosas) {
      c.y += c.vy * dt;
      c.angulo += c.giro * dt;
      if (!c.fuera && c.y > yBandeja - 18 && c.y < yBandeja + 12 && Math.abs(c.x - j.x) < 42 && j.vidas > 0) {
        c.fuera = true;
        if (c.malo) {
          j.vidas--;
          j.textos.push({ x: c.x, y: yBandeja - 30, texto: "−1 ♥", color: "#FF6B6B", vida: 1 });
          j.sacudir = 0.35;
          if (j.vidas <= 0 && j.puntos > leerRecord()) { guardarRecord(j.puntos); j.recordNuevo = true; }
        } else {
          j.puntos += c.puntos;
          j.textos.push({ x: c.x, y: yBandeja - 30, texto: "+" + c.puntos, color: c.puntos >= 50 ? "#FBBF24" : "#34D399", vida: 1 });
        }
      }
    }
    j.cosas = j.cosas.filter((c) => !c.fuera && c.y < ALTO + 30);
    for (const tx of j.textos) { tx.y -= 40 * dt; tx.vida -= dt * 1.2; }
    j.textos = j.textos.filter((tx) => tx.vida > 0);
    if (j.sacudir) j.sacudir = Math.max(0, j.sacudir - dt);

    dibujar(j);
    j.cuadro = requestAnimationFrame(paso);
  }

  function dibujar(j) {
    const ctx = ventana.querySelector(".juego-lienzo").getContext("2d");
    ctx.save();
    ctx.clearRect(0, 0, j.ancho, ALTO);
    if (j.sacudir && !reducirMovimiento) ctx.translate((Math.random() - 0.5) * 8 * j.sacudir / 0.35, 0);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `28px ${FUENTE_EMOJI}`;
    for (const c of j.cosas) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.angulo);
      if (c.malo) { ctx.shadowColor = "rgba(255,80,80,.9)"; ctx.shadowBlur = 14; }
      else if (c.puntos >= 50) { ctx.shadowColor = "rgba(251,191,36,.9)"; ctx.shadowBlur = 16; }
      ctx.fillText(c.emoji, 0, 0);
      ctx.restore();
    }

    // La bandeja: una carpeta con brillo azul de Axio.
    const yBandeja = ALTO - 34;
    const g = ctx.createLinearGradient(j.x - 40, 0, j.x + 40, 0);
    g.addColorStop(0, "#2F7DF6");
    g.addColorStop(1, "#4FA3FF");
    ctx.shadowColor = "rgba(47,125,246,.8)";
    ctx.shadowBlur = 18;
    ctx.fillStyle = g;
    redondeado(ctx, j.x - 40, yBandeja, 80, 14, 7);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = `22px ${FUENTE_EMOJI}`;
    ctx.fillText("📂", j.x, yBandeja - 8);

    ctx.font = "700 16px system-ui, sans-serif";
    for (const tx of j.textos) {
      ctx.globalAlpha = Math.max(0, tx.vida);
      ctx.fillStyle = tx.color;
      ctx.fillText(tx.texto, tx.x, tx.y);
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,.92)";
    ctx.font = "700 15px system-ui, sans-serif";
    ctx.fillText(`🧾 ${j.puntos} puntos`, 14, 20);
    ctx.textAlign = "right";
    ctx.fillText("♥".repeat(j.vidas) + "♡".repeat(3 - j.vidas), j.ancho - 14, 20);

    if (j.vidas <= 0) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(255,255,255,.95)";
      ctx.font = "700 22px system-ui, sans-serif";
      ctx.fillText(j.recordNuevo ? "🏆 ¡Récord nuevo!" : "¡Te alcanzó la mora! 🔴", j.ancho / 2, ALTO / 2 - 22);
      ctx.font = "500 14px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,.75)";
      ctx.fillText(`${j.puntos} puntos · clic o Enter para otra partida`, j.ancho / 2, ALTO / 2 + 8);
    }
    ctx.restore();
  }

  function redondeado(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
})();
