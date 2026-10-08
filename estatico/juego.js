/* Axio demo: «Atrapa los comprobantes», un minijuego para la espera de la primera carga.
 *
 * Aparece debajo del buscador cuando empieza a cargar (evento axio-carga-inicio de
 * puente.js), con la barra de avance real arriba. Es opcional: «No, gracias» lo cierra.
 * Cuando la carga termina (axio-carga-fin), lo que hay en pantalla vuela hacia el buscador,
 * el panel se cierra y Axio queda listo: el juego "se fusiona" con la aplicación.
 *
 * Solo guarda en este navegador el récord y cuánto tardó la última carga (para estimar la
 * barra). Nada de datos de las hojas.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const reducirMovimiento = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const leer = (clave, porDefecto) => { try { return Number(localStorage.getItem(clave)) || porDefecto; } catch (_) { return porDefecto; } };
  const guardar = (clave, valor) => { try { localStorage.setItem(clave, String(valor)); } catch (_) { /* sin almacenamiento */ } };

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
  const ALTO = 300;

  let panel = null;
  let juego = null;          // estado de la partida en curso
  let inicioCarga = 0;
  let duracionEsperada = Math.max(15, leer("axio-duracion-carga", 45));   // segundos
  let cuadroBarra = null;

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

  // ------------------------------------------------------------------ panel y barra de carga
  function abrirPanel() {
    if (panel) return;
    inicioCarga = performance.now();
    const mensaje = nodo("span", { class: "juego-mensaje", text: "Preparando Axio…" });
    const relleno = nodo("span", { class: "juego-relleno" });
    const porcentaje = nodo("span", { class: "juego-porcentaje", text: "0 %" });
    const lienzo = nodo("canvas", { class: "juego-lienzo", tabindex: "0", "aria-label": "Minijuego: mueve la bandeja con el mouse o las flechas" });
    const capa = nodo("div", { class: "juego-capa" },
      nodo("div", { class: "juego-portada" },
        nodo("strong", { text: "🎮 ¿Un juego mientras carga?" }),
        nodo("p", { text: "Atrapa los comprobantes 🧾 💵 💳 ⭐ con la bandeja y esquiva la mora 🔴. Mueve el mouse, el dedo o las flechas." }),
        nodo("p", { class: "juego-record", text: leer("axio-record-juego", 0) ? `🏆 Tu récord: ${leer("axio-record-juego", 0)} puntos` : null }),
        nodo("div", { class: "juego-botones" },
          nodo("button", { class: "boton boton-principal", type: "button", text: "▶ Jugar", onclick: empezar }),
          nodo("button", { class: "boton", type: "button", text: "No, gracias", onclick: noJugar }))));
    panel = nodo("section", { class: "juego", "aria-label": "Cargando Axio" },
      nodo("div", { class: "juego-cabecera" }, mensaje, porcentaje),
      nodo("div", { class: "juego-barra" }, relleno),
      nodo("div", { class: "juego-escena" }, lienzo, capa));
    const zona = $("#asociado-zona");
    zona.parentNode.insertBefore(panel, zona);
    window.addEventListener("resize", ajustarLienzo);
    ajustarLienzo();
    dibujarQuieto();
    cuadroBarra = requestAnimationFrame(avanzarBarra);
  }

  // La barra estima con lo que tardó la última carga; los mensajes de descarga ("3 de 9")
  // la empujan. Nunca llega a 100 % hasta que de verdad termina.
  let pisoBarra = 0;
  function avanzarBarra() {
    if (!panel) return;
    const t = (performance.now() - inicioCarga) / 1000;
    const estimado = 1 - Math.exp(-2.2 * t / duracionEsperada);
    ponerAvance(Math.max(pisoBarra, Math.min(0.96, estimado)));
    cuadroBarra = requestAnimationFrame(avanzarBarra);
  }
  function ponerAvance(f) {
    if (!panel) return;
    panel.querySelector(".juego-relleno").style.width = (f * 100).toFixed(1) + "%";
    panel.querySelector(".juego-porcentaje").textContent = Math.floor(f * 100) + " %";
  }

  window.addEventListener("axio-progreso", (ev) => {
    if (!panel) return;
    const texto = ev.detail.mensaje || "";
    panel.querySelector(".juego-mensaje").textContent = "⏳ " + texto;
    const m = /(\d+) de (\d+)/.exec(texto);
    if (m && /Descargando/.test(texto)) pisoBarra = Math.max(pisoBarra, 0.1 + 0.3 * Number(m[1]) / Number(m[2]));
    if (/Leyendo|descargadas/.test(texto)) pisoBarra = Math.max(pisoBarra, 0.45);
  });

  // ------------------------------------------------------------------ el juego
  function ajustarLienzo() {
    if (!panel) return;
    const lienzo = panel.querySelector(".juego-lienzo");
    const ancho = lienzo.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;
    lienzo.width = Math.round(ancho * dpr);
    lienzo.height = Math.round(ALTO * dpr);
    const ctx = lienzo.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (juego) { juego.ancho = ancho; juego.x = Math.min(juego.x, ancho - 40); }
    else dibujarQuieto();
  }

  // Fondo con cosas quietas mientras se elige jugar o no.
  function dibujarQuieto() {
    const lienzo = panel && panel.querySelector(".juego-lienzo");
    if (!lienzo) return;
    const ctx = lienzo.getContext("2d");
    const ancho = lienzo.clientWidth || 600;
    ctx.clearRect(0, 0, ancho, ALTO);
    ctx.font = `26px ${FUENTE_EMOJI}`;
    ctx.globalAlpha = 0.18;
    const fijos = ["🧾", "💵", "💳", "⭐", "🧾", "💵", "🔴", "🧾"];
    fijos.forEach((e, k) => ctx.fillText(e, (k + 0.5) * ancho / fijos.length - 13, 60 + (k % 3) * 70));
    ctx.globalAlpha = 1;
  }

  function empezar() {
    const lienzo = panel.querySelector(".juego-lienzo");
    panel.querySelector(".juego-capa").hidden = true;
    const ancho = lienzo.clientWidth;
    juego = { ancho, x: ancho / 2, objetivo: ancho / 2, cosas: [], textos: [], puntos: 0, vidas: 3, atrapados: 0,
      t: 0, proxima: 0.6, ultimo: performance.now(), teclas: new Set(), terminado: false, cuadro: 0 };
    lienzo.focus({ preventScroll: true });
    lienzo.onpointermove = (ev) => { const r = lienzo.getBoundingClientRect(); juego.objetivo = ev.clientX - r.left; };
    lienzo.onpointerdown = lienzo.onpointermove;
    lienzo.onkeydown = (ev) => {
      if (["ArrowLeft", "ArrowRight", "a", "d", "A", "D"].includes(ev.key)) { juego.teclas.add(ev.key.toLowerCase()); ev.preventDefault(); }
    };
    lienzo.onkeyup = (ev) => juego.teclas.delete(ev.key.toLowerCase());
    juego.cuadro = requestAnimationFrame(paso);
  }

  function noJugar() {
    panel.querySelector(".juego-escena").classList.add("juego-plegada");
  }

  function elegirCosa() {
    let r = Math.random() * PESO_TOTAL;
    for (const c of COSAS) { r -= c.peso; if (r <= 0) return c; }
    return COSAS[0];
  }

  function paso() {
    const j = juego;
    if (!j || j.terminado) return;
    // Reloj propio (no el del cuadro): entre 0 y 50 ms por paso, aunque la pestaña se pause.
    const ahora = performance.now();
    const dt = Math.max(0, Math.min(0.05, (ahora - j.ultimo) / 1000));
    j.ultimo = ahora;
    j.t += dt;
    const velocidad = 130 + Math.min(220, j.t * 4.5);   // se pone más difícil con el tiempo

    // Bandeja: sigue al mouse, o se mueve con las flechas.
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
        } else {
          j.puntos += c.puntos;
          j.atrapados++;
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
    const lienzo = panel.querySelector(".juego-lienzo");
    const ctx = lienzo.getContext("2d");
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

    // Marcador
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
      ctx.fillText("¡Te alcanzó la mora! 🔴", j.ancho / 2, ALTO / 2 - 22);
      ctx.font = "500 14px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,.75)";
      ctx.fillText(`${j.puntos} puntos · clic o Enter para otra partida`, j.ancho / 2, ALTO / 2 + 8);
      if (!j.esperandoOtra) {
        j.esperandoOtra = true;
        anotarRecord(j.puntos);
        const otra = (ev) => { if (ev.type === "pointerdown" || ev.key === "Enter" || ev.key === " ") { lienzo.removeEventListener("pointerdown", otra); lienzo.removeEventListener("keydown", otra); cancelAnimationFrame(j.cuadro); juego = null; empezar(); } };
        lienzo.addEventListener("pointerdown", otra);
        lienzo.addEventListener("keydown", otra);
      }
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

  function anotarRecord(puntos) {
    const record = leer("axio-record-juego", 0);
    if (puntos > record) guardar("axio-record-juego", puntos);
    return puntos > record;
  }

  // ------------------------------------------------------------------ la fusión
  // Al terminar la carga, lo que hay en pantalla vuela al buscador y el panel se recoge.
  function fusionar(error) {
    if (!panel) return;
    cancelAnimationFrame(cuadroBarra);
    guardar("axio-duracion-carga", Math.round((performance.now() - inicioCarga) / 1000));
    ponerAvance(1);
    panel.querySelector(".juego-mensaje").textContent = error ? "⚠️ Terminó con avisos: revisa las fuentes" : "✨ ¡Axio está listo!";
    const j = juego;
    let resumen = "";
    if (j) {
      j.terminado = true;
      cancelAnimationFrame(j.cuadro);
      const nuevo = j.vidas > 0 && anotarRecord(j.puntos);
      resumen = ` · atrapaste ${j.atrapados} comprobante${j.atrapados === 1 ? "" : "s"} (${j.puntos} puntos${nuevo ? ", ¡récord nuevo! 🏆" : ""})`;
    }
    const caja = $("#form-busqueda");
    const lienzo = panel.querySelector(".juego-lienzo");
    const desde = lienzo.getBoundingClientRect();
    const hasta = (caja || lienzo).getBoundingClientRect();
    const voladores = j && !reducirMovimiento
      ? [...j.cosas.filter((c) => !c.malo).map((c) => ({ emoji: c.emoji, x: c.x, y: c.y })), { emoji: "📂", x: j.x, y: ALTO - 42 }]
      : [];
    voladores.forEach((c, k) => {
      const chispa = nodo("span", { class: "juego-chispa", text: c.emoji, "aria-hidden": "true" });
      chispa.style.left = desde.left + c.x + "px";
      chispa.style.top = desde.top + c.y + "px";
      document.body.append(chispa);
      const dx = hasta.left + 60 + Math.random() * Math.max(40, hasta.width - 200) - (desde.left + c.x);
      const dy = hasta.top + hasta.height / 2 - (desde.top + c.y);
      chispa.animate([
        { transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5 - 60}px)) scale(1.25)`, opacity: 1, offset: 0.45 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.2)`, opacity: 0 },
      ], { duration: 900, delay: k * 35, easing: "cubic-bezier(.5,0,.3,1)", fill: "forwards" }).finished.then(() => chispa.remove());
    });
    const espera = voladores.length ? 900 + voladores.length * 35 : 250;
    setTimeout(() => {
      if (caja) {
        caja.classList.add("axio-fusion");
        setTimeout(() => caja.classList.remove("axio-fusion"), 1600);
      }
      const p = panel;
      panel = null;
      juego = null;
      window.removeEventListener("resize", ajustarLienzo);
      p.style.height = p.offsetHeight + "px";
      requestAnimationFrame(() => p.classList.add("juego-cerrando"));
      setTimeout(() => p.remove(), 650);
      avisoListo((error ? "⚠️ Axio cargó con avisos" : "✨ Axio está listo") + resumen);
      const q = $("#q");
      if (q && !document.querySelector("dialog[open]")) q.focus({ preventScroll: true });
    }, espera);
  }

  function avisoListo(texto) {
    const t = $("#toast");
    if (!t) return;
    t.textContent = texto;
    t.hidden = false;
    t.classList.add("visible");
    clearTimeout(avisoListo.temporizador);
    avisoListo.temporizador = setTimeout(() => { t.classList.remove("visible"); t.hidden = true; }, 5000);
  }

  // Solo en la primera carga (al entrar); «Refrescar datos» no saca el juego.
  window.addEventListener("axio-carga-inicio", (ev) => { if (ev.detail.accion === "configurar") abrirPanel(); });
  window.addEventListener("axio-carga-fin", (ev) => { if (ev.detail.accion === "configurar") fusionar(ev.detail.error); });
})();
