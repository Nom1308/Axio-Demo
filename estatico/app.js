/* Axio Web: página del buscador.
 *
 * Todo lo que viene de las hojas se pinta con textContent, nunca con innerHTML: una celda
 * de la Matriz_Nube la escribe cualquiera, y con innerHTML un texto con etiquetas se
 * ejecutaría en el navegador de quien la mira.
 */
(function () {
  "use strict";

  const CSRF = document.querySelector('meta[name="csrf"]').content;
  const ES_ADMIN = document.body.dataset.admin === "1";
  const CLAVE_RECIENTES = "axio_recientes";
  const ESTADOS = {
    ingresado: "Ingresado (RWS)",
    gestion_cartera: "En gestión de Cartera",
    pendiente_recaudo: "Pendiente Recaudo",
    referencia_erronea: "Referencia no encontrada",
  };

  // ------------------------------------------------------------------ tema
  // «Sistema» sigue al equipo (claro u oscuro); «Claro» y «Oscuro» lo fijan. La elección se
  // recuerda en este navegador y se aplica antes de pintar nada.
  const CLAVE_TEMA = "axio.tema";
  function leerTema() {
    try { const t = sessionStorage.getItem(CLAVE_TEMA); return t === "claro" || t === "oscuro" ? t : "sistema"; } catch (_) { return "sistema"; }
  }
  function aplicarTema(tema) {
    const raiz = document.documentElement;
    if (tema === "claro") raiz.dataset.theme = "light";
    else if (tema === "oscuro") raiz.dataset.theme = "dark";
    else delete raiz.dataset.theme;
  }
  function elegirTema(tema) {
    try { tema === "sistema" ? sessionStorage.removeItem(CLAVE_TEMA) : sessionStorage.setItem(CLAVE_TEMA, tema); } catch (_) { /* sin almacenamiento */ }
    aplicarTema(tema);
  }
  aplicarTema(leerTema());

  const $ = (sel) => document.querySelector(sel);
  const form = $("#form-busqueda");
  const campo = $("#q");
  const btnBuscar = $("#btn-buscar");
  const estadoBusqueda = $("#estado-busqueda");
  const contenedor = $("#resultados");
  const barraResultados = $("#barra-resultados");
  const zonaAsociado = $("#asociado-zona");
  const zonaUsuario = $(".usuario");
  const filtro = $("#filtro");
  const ocultarVacias = $("#ocultar-vacias");
  const dialogo = $("#detalle");
  const cuerpoDetalle = $("#detalle-cuerpo");

  let busqueda = null;          // última respuesta de /api/buscar
  let historiaAsociado = null;  // pagos y línea de tiempo de la persona (ver pintarAsociado)
  const orden = {};             // fuente -> {col, asc}
  let sondeo = null;
  let alTerminarCarga = null;   // búsqueda a lanzar apenas se pueda buscar
  let alCompletarCarga = null;  // búsqueda hecha a medias, a repetir cuando termine todo

  // ------------------------------------------------------------------ utilidades
  function el(etiqueta, props, ...hijos) {
    const nodo = document.createElement(etiqueta);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") nodo.className = v;
        else if (k === "text") nodo.textContent = v;
        // Por CSSOM y no con setAttribute: la política de seguridad (CSP) bloquea los
        // atributos style escritos en línea, pero no los estilos asignados desde script.
        else if (k === "style") nodo.style.cssText = v;
        else if (k.startsWith("on")) nodo.addEventListener(k.slice(2), v);
        else nodo.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const h of hijos) {
      if (h === null || h === undefined || h === false) continue;
      nodo.append(h instanceof Node ? h : document.createTextNode(String(h)));
    }
    return nodo;
  }

  async function api(url, opciones = {}) {
    const resp = await window.axioFetch(url, {
      credentials: "same-origin",
      ...opciones,
      headers: { "X-CSRF-Token": CSRF, ...(opciones.headers || {}) },
    });
    if (resp.status === 401) {
      window.location.href = "/login";
      throw new Error("La sesión expiró.");
    }
    return resp;
  }

  async function apiJson(url, opciones) {
    const resp = await api(url, opciones);
    let datos = {};
    try { datos = await resp.json(); } catch (_) { /* sin cuerpo JSON */ }
    if (!resp.ok && resp.status !== 202) throw new Error(datos.error || `Error ${resp.status}`);
    return { status: resp.status, datos };
  }

  let temporizadorToast = null;
  function toast(texto) {
    const t = $("#toast");
    t.textContent = texto;
    t.hidden = false;
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => { t.hidden = true; }, 2200);
  }

  // navigator.clipboard solo existe con HTTPS (o en localhost). En una red interna por
  // HTTP no está, así que se cae al método viejo, que funciona en cualquier navegador.
  // boton: el que se tocó; por un instante se vuelve «✓ Copiado» (ver confirmarCopia).
  async function copiar(texto, mensaje, boton) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(texto);
      } else {
        const area = el("textarea", { readonly: true, style: "position:fixed;opacity:0" });
        area.value = texto;
        ([...document.querySelectorAll("dialog[open]")].pop() || document.body).append(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      toast(mensaje || "Copiado.");
      if (boton) confirmarCopia(boton, /^Cédula/.test(mensaje || "") ? "Copiada" : "Copiado");
    } catch (_) {
      toast("No se pudo copiar.");
    }
  }

  // Una palomita que se dibuja (el aro y luego la marca).
  function palomita(clase) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", clase);
    svg.setAttribute("aria-hidden", "true");
    const marca = document.createElementNS(ns, "path");
    marca.setAttribute("d", "M5 12.5l4.2 4.2L19 7");
    marca.setAttribute("pathLength", "1");
    svg.append(marca);
    return svg;
  }

  // El botón de copiar responde él mismo: «✓ Copiado» un momento y vuelve a lo de antes,
  // sin cambiar de ancho. Los de solo ícono (📋) muestran solo la palomita.
  function confirmarCopia(boton, texto) {
    if (boton.classList.contains("boton-copiado")) return;
    const antes = [...boton.childNodes].filter((n) => !(n.classList && n.classList.contains("onda-boton")));
    const soloIcono = boton.textContent.trim().length <= 2;
    boton.style.minWidth = boton.offsetWidth + "px";
    boton.replaceChildren(palomita("palomita"), soloIcono ? "" : texto);
    boton.classList.add("boton-copiado");
    setTimeout(() => {
      boton.replaceChildren(...antes);
      boton.classList.remove("boton-copiado");
      boton.style.minWidth = "";
    }, 1600);
  }

  function normalizar(texto) {
    return String(texto).toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.\-,/\s_$#()]/g, "");
  }

  function haceCuanto(iso) {
    if (!iso) return "";
    const momento = new Date(iso.replace(" ", "T"));
    const min = Math.round((Date.now() - momento.getTime()) / 60000);
    if (min < 1) return "hace un momento";
    if (min < 60) return `hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.round(h / 24);
    return `hace ${d} día${d === 1 ? "" : "s"}`;
  }

  const formatoMiles = new Intl.NumberFormat("es-CO");

  // ------------------------------------------------------------------ movimiento
  // Detalles de animación (ver «MOVIMIENTO» en estilos.css). Con «reducir movimiento» en el
  // sistema no se hace ninguno.
  const sinMovimiento = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Una cifra como "$ 15,328,095" o "$ 17,333,333.33" sube desde cero hasta su valor.
  function contarHasta(nodo, texto) {
    const m = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(\D*)$/.exec(String(texto || ""));
    if (!m || sinMovimiento()) return;
    const decimales = m[2].includes(".") ? m[2].split(".")[1].length : 0;
    const valor = Number(m[2].replace(/,/g, ""));
    if (!isFinite(valor) || valor < 100) return;
    const cifra = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimales, maximumFractionDigits: decimales });
    const inicio = performance.now(), duracion = 950;
    const paso = (t) => {
      const p = Math.min(1, (t - inicio) / duracion);
      nodo.textContent = p < 1 ? m[1] + cifra.format(valor * (1 - Math.pow(1 - p, 3))) + m[3] : texto;
      if (p < 1) requestAnimationFrame(paso);
    };
    requestAnimationFrame(paso);
  }

  // Un entero (pagos, créditos) sube desde cero hasta su valor, con separador de miles.
  function contarEntero(nodo, n, sufijo = "") {
    nodo.textContent = formatoMiles.format(n) + sufijo;
    if (sinMovimiento() || n < 2) return;
    const inicio = performance.now(), duracion = 900;
    const paso = (t) => {
      const p = Math.min(1, (t - inicio) / duracion);
      nodo.textContent = formatoMiles.format(Math.round(n * (1 - Math.pow(1 - p, 3)))) + sufijo;
      if (p < 1) requestAnimationFrame(paso);
    };
    requestAnimationFrame(paso);
  }

  // Gráficos vivos: lo que crece o entra en cascada (columnas, barras, movimientos) espera a
  // estar en pantalla para animarse. Hasta entonces lleva .por-ver, que deja sus animaciones
  // en pausa en el primer cuadro (ver estilos.css). alVer se llama una vez, al aparecer.
  const observadorVista = "IntersectionObserver" in window ? new IntersectionObserver((entradas) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      observadorVista.unobserve(e.target);
      e.target.classList.remove("por-ver");
      if (e.target.alVer) { e.target.alVer(); e.target.alVer = null; }
    }
  }, { threshold: 0.2 }) : null;
  // Al imprimir (botón o Ctrl+P), lo que no se alcanzó a ver sale completo y no en pausa.
  function soltarPorVer() {
    document.querySelectorAll(".por-ver").forEach((n) => {
      if (observadorVista) observadorVista.unobserve(n);
      n.classList.remove("por-ver");
      if (n.alVer) { n.alVer(); n.alVer = null; }
    });
  }
  window.addEventListener("beforeprint", soltarPorVer);
  function animarAlVer(nodo, alVer) {
    if (!observadorVista || sinMovimiento()) { if (alVer) alVer(); return; }
    nodo.classList.add("por-ver");
    nodo.alVer = alVer || null;
    observadorVista.observe(nodo);
  }

  // Onda al presionar un botón, desde donde se tocó.
  document.addEventListener("pointerdown", (ev) => {
    const boton = ev.target.closest && ev.target.closest(".boton");
    if (!boton || boton.disabled || sinMovimiento()) return;
    const r = boton.getBoundingClientRect();
    const lado = Math.max(r.width, r.height) * 2.2;
    const onda = el("span", { class: "onda-boton", "aria-hidden": "true",
      style: `width:${lado}px;height:${lado}px;left:${ev.clientX - r.left - lado / 2}px;top:${ev.clientY - r.top - lado / 2}px` });
    boton.append(onda);
    setTimeout(() => onda.remove(), 600);
  }, { passive: true });

  // La luz de las tarjetas de crédito sigue al mouse.
  document.addEventListener("pointermove", (ev) => {
    const tarjeta = ev.target.closest && ev.target.closest(".tarjeta-credito");
    if (!tarjeta) return;
    const r = tarjeta.getBoundingClientRect();
    tarjeta.style.setProperty("--mx", `${ev.clientX - r.left}px`);
    tarjeta.style.setProperty("--my", `${ev.clientY - r.top}px`);
  }, { passive: true });

  // ------------------------------------------------------------------ logo de la barra
  // Mientras se descargan las hojas, los tres puntos dorados del logo se encienden a medida
  // que cada una queda lista, y al final el logo da un destello: la carga no se ve como
  // carga. La versión de navegador lo hace con sus propios avisos (estatico/espera.js) y
  // lo marca con data-carga-propia.
  const logoBarra = document.querySelector(".barra .logo-barra");
  let logoCargando = false;
  let logoAvance = 0;
  function encenderLogo(avance) {
    logoAvance = avance;
    for (let i = 0; i < 3; i++) logoBarra.style.setProperty(`--p${i + 1}`, Math.max(0, Math.min(1, avance * 3 - i)).toFixed(3));
  }
  // Al terminar, los puntos que faltan se encienden uno tras otro (~0,65 s); después, listo().
  function completarLogo(listo) {
    const desde = logoAvance, t0 = performance.now(), DURACION = sinMovimiento() ? 0 : 650;
    const paso = (ahora) => {
      const k = DURACION ? Math.min(1, (ahora - t0) / DURACION) : 1;
      encenderLogo(desde + (1 - desde) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(paso); else listo();
    };
    requestAnimationFrame(paso);
  }
  function logoSegunEstado(est) {
    if (!logoBarra || "cargaPropia" in logoBarra.dataset || !est.fuentes || !est.fuentes.length) return;
    if (est.cargando) {
      const hechas = est.fuentes.filter((f) => f.estado !== "pendiente").length;
      logoBarra.classList.add("cargando");
      logoCargando = true;
      encenderLogo(Math.min(0.97, hechas / est.fuentes.length));
    } else if (logoCargando) {
      logoCargando = false;
      completarLogo(() => {
        logoBarra.classList.remove("cargando");
        logoBarra.classList.add("destello");
        setTimeout(() => logoBarra.classList.remove("destello"), 1400);
      });
    }
  }

  // ------------------------------------------------------------------ despedida
  // Al cerrar la sesión (o por inactividad), los tres puntos dorados del logo se sueltan y
  // se dispersan como polvo de luz mientras la página se apaga: la entrada, al revés.
  // Devuelve una promesa que se cumple al terminar (~1 s); sin movimiento, al instante.
  function despedida() {
    if (sinMovimiento() || !logoBarra || document.body.classList.contains("despidiendo")) return Promise.resolve();
    const r = logoBarra.getBoundingClientRect();
    const k = r.width / 64;
    const origenes = [[41, 9, 10], [50, 13, 20], [55.5, 22, 10]];   // x, y del punto y cuántas chispas
    const lienzo = el("canvas", { class: "despedida", "aria-hidden": "true" });
    const escala = Math.min(2, window.devicePixelRatio || 1);
    lienzo.width = Math.round(window.innerWidth * escala);
    lienzo.height = Math.round(window.innerHeight * escala);
    document.body.append(lienzo);
    const ctx = lienzo.getContext("2d");
    ctx.scale(escala, escala);
    const chispas = origenes.flatMap(([x, y, n]) => Array.from({ length: n }, () => {
      const angulo = Math.random() * Math.PI * 2;
      const fuerza = 60 + Math.random() * 260;
      return { x: r.left + x * k, y: r.top + y * k, vx: Math.cos(angulo) * fuerza, vy: Math.sin(angulo) * fuerza * .7 + 40, tam: 1 + Math.random() * 2.2 };
    }));
    logoBarra.classList.add("suelto");
    document.body.classList.add("despidiendo");
    const DURACION = 1000;
    const inicio = performance.now();
    let anterior = inicio;
    return new Promise((listo) => {
      function cuadro(ahora) {
        const t = (ahora - inicio) / DURACION;
        const dt = Math.min(.05, (ahora - anterior) / 1000);
        anterior = ahora;
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        for (const c of chispas) {
          c.x += c.vx * dt;
          c.y += c.vy * dt;
          c.vx *= .965;
          c.vy = c.vy * .965 + 30 * dt;   // caen muy despacio, como polvo
          const radio = c.tam * 4.5;
          const brillo = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, radio);
          brillo.addColorStop(0, `rgba(255, 220, 120, ${Math.max(0, 1 - t)})`);
          brillo.addColorStop(1, "rgba(252, 180, 0, 0)");
          ctx.fillStyle = brillo;
          ctx.fillRect(c.x - radio, c.y - radio, radio * 2, radio * 2);
        }
        if (t < 1) requestAnimationFrame(cuadro);
        else listo();
      }
      requestAnimationFrame(cuadro);
    });
  }
  window.axioDespedida = despedida;

  // «Salir» del servidor: primero la despedida, después el formulario de siempre.
  const formularioSalir = document.querySelector('form[action$="logout"]');
  if (formularioSalir) {
    formularioSalir.addEventListener("submit", (ev) => {
      ev.preventDefault();
      despedida().then(() => formularioSalir.submit());
    });
  }

  let animarEntrada = false;   // la próxima pintada de resultados entra en cascada
  let temporizadorEntrada = null;

  // ------------------------------------------------------------------ estado de fuentes
  async function cargarEstado() {
    try {
      const { datos } = await apiJson("/api/estado");
      pintarEstado(datos);
      return datos;
    } catch (e) {
      return null;
    }
  }

  function pintarEstado(est) {
    ultimoEstado = est;
    if (!menu.hidden) pintarMenu();
    const zona = $("#fuentes");
    zona.replaceChildren();
    const m = est.matriz, l = est.lineas;

    // Mientras se cargan las hojas no hay aviso aquí: lo cuenta el logo de la barra (ver
    // «logo de la barra») y el detalle está en el menú de la cuenta.
    if (!m.configurada) {
      zona.append(el("span", { class: "ambar", text: "⚠️ No hay URL de los Extractos (Matriz_Nube) en config_axio.json del servidor." }));
    } else if (m.error) {
      zona.append(el("span", { class: "error", text: "❌ Los Extractos no se pudieron cargar" }));
    } else if (m.filas) {
      const casilla = el("input", { type: "checkbox", id: "ver-tabla" });
      casilla.checked = !ventanaTabla.hidden;
      casilla.addEventListener("change", () => (casilla.checked ? abrirTabla() : cerrarTabla()));
      const casillaTablero = el("input", { type: "checkbox", id: "ver-tablero" });
      casillaTablero.checked = !ventanaTablero.hidden;
      casillaTablero.addEventListener("change", () => (casillaTablero.checked ? abrirTablero() : cerrarTablero()));
      zona.append(el("span", { text: `☁️ Extractos: ${formatoMiles.format(m.filas)} filas · ${haceCuanto(m.hora)}` }),
        el("label", { class: "interruptor interruptor-tabla", title: "Muestra debajo los totales de Cartera: pagos por estado, por mes y por distrito, y los créditos en mora" },
          casillaTablero, " Tablero"),
        el("label", { class: "interruptor interruptor-tabla", title: "Muestra debajo los Extractos completos, tal cual la hoja, con filtros en los encabezados" },
          casilla, " Ver todos los pagos"));
      if (ventanaTablero.hidden && preferencia(CLAVE_VER_TABLERO)) abrirTablero();
      else if (!ventanaTablero.hidden) refrescarTableroSiCambio(est);
      if (ventanaTabla.hidden && tablaPreferida()) abrirTabla();
    }
    if (l.configuradas) {
      const errores = Object.keys(l.errores || {});
      zona.append(el("span", {
        class: errores.length ? "ambar" : null,
        text: `💳 Líneas de crédito: ${l.cargadas.length}${l.hora ? " · " + haceCuanto(l.hora) : ""}${errores.length ? ` (${errores.length} con error)` : ""}`,
      }));
    }
    const w = est.whatsapp;
    if (w && w.configurado) {
      zona.append(el("span", {
        class: w.error ? "ambar" : null,
        text: w.error ? "💬 WhatsApp: sin acceso a la hoja" : `💬 WhatsApp: ${formatoMiles.format(w.contactos)} contactos`,
      }));
    }
    if (est.cierres_locales) zona.append(el("span", { text: "📂 Incluye cierres locales" }));
    if (ES_ADMIN) {
      zona.append(el("button", {
        class: "boton", type: "button", text: "↻ Refrescar datos", disabled: est.cargando,
        title: "Vuelve a descargar la Matriz_Nube y las líneas de crédito",
        onclick: refrescar,
      }));
    }

    const avisos = [];
    if (m.error) avisos.push(["aviso-error", "Extractos: " + m.error]);
    if (w && w.error) avisos.push(["aviso-ambar", "WhatsApp: " + w.error]);
    if (m.aviso) avisos.push(["aviso-info", m.aviso]);
    for (const [nombre, err] of Object.entries(l.errores || {})) avisos.push(["aviso-ambar", `Línea «${nombre}»: ${err}`]);
    if (avisos.length) {
      const caja = el("div", { class: "avisos-fuentes" });
      for (const [clase, texto] of avisos) caja.append(el("p", { class: "aviso " + clase, text: texto }));
      zona.append(caja);
      caja.style.flexBasis = "100%";
    }

    logoSegunEstado(est);
    if (est.cargando) programarSondeo();
    if (alTerminarCarga && (!est.cargando || est.parcial)) {
      // Una búsqueda quedó esperando a que cargaran los datos: se lanza apenas se puede
      // buscar (en la primera carga, cuando ya están los Extractos).
      const pendiente = alTerminarCarga;
      alTerminarCarga = null;
      pendiente();
    }
    if (alCompletarCarga && !est.cargando) {
      const pendiente = alCompletarCarga;
      alCompletarCarga = null;
      pendiente();
    }
  }

  function programarSondeo() {
    clearTimeout(sondeo);
    sondeo = setTimeout(cargarEstado, 2000);
  }

  async function refrescar() {
    try {
      const { datos } = await apiJson("/api/refrescar", { method: "POST" });
      toast(datos.mensaje);
      cargarEstado();
    } catch (e) {
      toast(e.message);
    }
  }

  // ------------------------------------------------------------------ recientes
  function leerRecientes() {
    try { return JSON.parse(sessionStorage.getItem(CLAVE_RECIENTES)) || []; } catch (_) { return []; }
  }
  function guardarReciente(t) {
    const lista = [t, ...leerRecientes().filter((x) => x !== t)].slice(0, 8);
    try { sessionStorage.setItem(CLAVE_RECIENTES, JSON.stringify(lista)); } catch (_) { /* sin almacenamiento */ }
    pintarRecientes();
  }
  function pintarRecientes() {
    const zona = $("#recientes");
    const lista = leerRecientes();
    zona.replaceChildren();
    zona.hidden = false;
    if (lista.length) zona.append(el("span", { text: "Recientes:" }));
    for (const t of lista) {
      zona.append(el("button", { type: "button", text: t, onclick: () => { campo.value = t; buscar(); } }));
    }
    zona.append(el("button", { type: "button", class: "recientes-varias", text: "🔎 Buscar varias cédulas…",
      title: "Pega una lista de cédulas y mira el estado de todas a la vez", onclick: () => abrirBuscarVarias() }));
  }

  // ------------------------------------------------------------------ búsqueda
  async function buscar() {
    const termino = campo.value.trim();
    if (!termino) { campo.focus(); return; }
    cerrarSugerencias();
    btnBuscar.disabled = true;
    btnBuscar.textContent = "Buscando…";
    estadoBusqueda.className = "estado-busqueda";
    estadoBusqueda.textContent = "Buscando…";
    const pedido = apiJson("/api/buscar?q=" + encodeURIComponent(termino));
    pedido.catch(() => {});   // el error se atiende abajo, después de la transición
    // La primera búsqueda: la portada se retira y el buscador sube a su lugar arriba,
    // deslizándose desde donde estaba (el ancho lo cambia su propia transición en
    // estilos.css). Se mueve el buscador de verdad, así su vidrio desenfocado no parpadea.
    const panel = $(".panel-busqueda");
    const primera = !document.body.classList.contains("con-busqueda");
    const antes = primera ? panel.getBoundingClientRect().top : 0;
    document.body.classList.add("con-busqueda");
    pintarEsqueleto(termino);
    if (primera && !sinMovimiento() && panel.animate) {
      const salto = antes - panel.getBoundingClientRect().top;
      if (Math.abs(salto) > 2) {
        panel.animate([{ transform: `translateY(${salto}px)` }, { transform: "none" }],
          { duration: 520, easing: "cubic-bezier(.2, .85, .25, 1)" });
      }
    }
    try {
      const { status, datos } = await pedido;
      quitarEsqueleto();
      if (status === 202) {
        estadoBusqueda.textContent = "⏳ " + datos.mensaje + " La búsqueda se hará sola cuando terminen de cargar.";
        alTerminarCarga = buscar;
        cargarEstado();
        return;
      }
      const repetida = Boolean(busqueda && busqueda.termino === datos.termino && filtro.value);
      busqueda = datos;
      if (!repetida) filtro.value = "";
      guardarReciente(termino);
      if (datos.asociado) anotarPersona(datos.asociado);
      animarEntrada = !repetida;
      pintarResultados();
      if (datos.parcial) {
        // Se buscó solo en los Extractos: las líneas de crédito siguen cargando. Al terminar,
        // la misma búsqueda se repite sola (si nadie escribió otra cosa) y suma los créditos.
        estadoBusqueda.append(el("span", { class: "nota-parcial",
          text: "⏳ Las líneas de crédito todavía se están cargando: esta búsqueda se completará sola en un momento." }));
        alCompletarCarga = () => { if (campo.value.trim() === termino) buscar(); };
      }
      cargarEstado();
    } catch (e) {
      quitarEsqueleto();
      estadoBusqueda.className = "estado-busqueda error";
      estadoBusqueda.textContent = "❌ " + e.message;
    } finally {
      btnBuscar.disabled = false;
      btnBuscar.textContent = "Buscar";
    }
  }

  function pintarResultados() {
    contenedor.replaceChildren();
    if (!busqueda) return;
    // Cascada solo en la pintada de una búsqueda nueva; al filtrar u ordenar, nada se mueve.
    contenedor.classList.toggle("resultados-nuevos", animarEntrada);
    clearTimeout(temporizadorEntrada);
    if (animarEntrada) temporizadorEntrada = setTimeout(() => contenedor.classList.remove("resultados-nuevos"), 2000);
    animarEntrada = false;

    // Si se buscó una cédula, primero va el resumen de la persona (sus créditos activos en
    // todas las líneas y su WhatsApp), arriba de la barra de resultados. Después, lo de siempre.
    zonaAsociado.replaceChildren();
    historiaAsociado = null;
    if (busqueda.asociado) zonaAsociado.append(pintarAsociado(busqueda.asociado));

    if (!busqueda.grupos.length) {
      barraResultados.hidden = true;
      estadoBusqueda.className = "estado-busqueda";
      const sugerencia = busqueda.sugerencia ? el("span", { class: "sugerencia" }, "¿Quisiste decir ",
        el("button", { type: "button", text: busqueda.sugerencia, onclick: () => { campo.value = busqueda.sugerencia; buscar(); } }), "?") : null;
      if (busqueda.asociado) {
        // Se encontró a la persona (su ficha está arriba), solo que sin pagos: basta una línea.
        estadoBusqueda.replaceChildren(`No hay pagos en los Extractos para «${busqueda.termino}».`);
      } else {
        estadoBusqueda.replaceChildren();
        contenedor.append(sinResultados(busqueda.termino, sugerencia));
      }
      if (historiaAsociado) contenedor.append(historiaAsociado);
      return;
    }

    barraResultados.hidden = false;
    estadoBusqueda.textContent = "";
    if (busqueda.corregido_de) {
      // Se buscó con la palabra corregida (ver corregir_palabras en el servidor).
      estadoBusqueda.append(el("span", { class: "nota-corregida" },
        `✨ No había resultados para «${busqueda.corregido_de}»: se muestran los de «${busqueda.termino}».`));
    }
    const n = busqueda.total;
    $("#resumen").textContent = `${formatoMiles.format(n)} resultado${n === 1 ? "" : "s"} para «${busqueda.termino}» en ${busqueda.grupos.length} fuente${busqueda.grupos.length === 1 ? "" : "s"}`;

    const textoFiltro = normalizar(filtro.value.trim());
    let visibles = 0;
    let historiaPuesta = !historiaAsociado;
    for (const g of busqueda.grupos) {
      const nodo = pintarGrupo(g, textoFiltro);
      if (nodo) { contenedor.append(nodo); visibles++; }
      // Los pagos y la línea de tiempo de la persona, justo después de sus Extractos.
      if (!historiaPuesta && g.fuente === "Extractos") { contenedor.append(historiaAsociado); historiaPuesta = true; }
    }
    if (!historiaPuesta) contenedor.append(historiaAsociado);
    if (!visibles) estadoBusqueda.textContent = "Ningún resultado coincide con el filtro.";
  }

  // Nada encontrado: la lupa del logo buscando de un lado a otro, con sus tres puntos dorados
  // sueltos flotando alrededor, y qué probar.
  function sinResultados(termino, sugerencia) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = (etiqueta, atributos) => {
      const n = document.createElementNS(ns, etiqueta);
      for (const [k, v] of Object.entries(atributos)) n.setAttribute(k, v);
      return n;
    };
    const dibujo = svg("svg", { viewBox: "0 0 120 90", class: "sr-dibujo", "aria-hidden": "true" });
    const lupa = svg("g", { class: "sr-lupa" });
    lupa.append(svg("circle", { cx: "52", cy: "40", r: "18", fill: "none", "stroke-width": "7" }),
      svg("path", { d: "M65 53l15 15", fill: "none", "stroke-width": "8", "stroke-linecap": "round" }));
    dibujo.append(lupa,
      svg("circle", { class: "sr-punto", cx: "90", cy: "18", r: "5" }),
      svg("circle", { class: "sr-punto", cx: "22", cy: "22", r: "3.2" }),
      svg("circle", { class: "sr-punto", cx: "98", cy: "58", r: "3.2" }));
    return el("div", { class: "sin-resultados" }, dibujo,
      el("strong", { text: `Nada por aquí para «${termino}»` }),
      el("p", { text: "Prueba con la cédula sin puntos, solo un apellido, el número de recibo o un monto." }),
      sugerencia);
  }

  // Mientras se busca: siluetas suaves con la forma de lo que va a llegar (la ficha si es
  // una cédula, y una tabla de resultados).
  function pintarEsqueleto(termino) {
    const filas = (n) => Array.from({ length: n }, (_, i) => el("div", { class: "esqueleto-fila", style: `--i:${i}` },
      ...[18, 30, 22, 14].map((w) => el("span", { class: "esqueleto-linea", style: `width:${w}%` }))));
    contenedor.replaceChildren(el("div", { class: "grupo esqueleto", "aria-hidden": "true" },
      el("div", { class: "esqueleto-titulo" }, el("span", { class: "esqueleto-linea", style: "width:120px" })), ...filas(5)));
    contenedor.setAttribute("aria-busy", "true");
    if (/^[\d.\s]{5,}$/.test(termino)) {
      zonaAsociado.replaceChildren(el("div", { class: "asociado esqueleto", "aria-hidden": "true" },
        el("div", { class: "asociado-cabecera" }, el("span", { class: "asociado-avatar esqueleto-bloque" }),
          el("div", { class: "asociado-nombre" }, el("span", { class: "esqueleto-linea", style: "width:220px;height:16px" }),
            el("span", { class: "esqueleto-linea", style: "width:140px" })))));
    }
  }
  function quitarEsqueleto() {
    contenedor.removeAttribute("aria-busy");
    contenedor.querySelectorAll(".esqueleto").forEach((n) => n.remove());
    zonaAsociado.querySelectorAll(".esqueleto").forEach((n) => n.remove());
  }

  function claveOrden(v) {
    if (!v) return [3, 0];
    let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
    if (m) return [0, Number(m[3] + m[2] + m[1])];
    if (/^-?[\d,]+(\.\d+)?$/.test(v)) return [1, Number(v.replace(/,/g, ""))];
    return [2, v.toUpperCase()];
  }

  function pintarGrupo(g, textoFiltro) {
    let filas = g.filas;
    if (textoFiltro) filas = filas.filter((f) => f.v.some((v) => normalizar(v).includes(textoFiltro)));
    if (!filas.length) return null;

    const o = orden[g.fuente];
    if (o) {
      filas = [...filas].sort((a, b) => {
        const ka = claveOrden(a.v[o.col]), kb = claveOrden(b.v[o.col]);
        if (ka[0] === 3 || kb[0] === 3) return ka[0] - kb[0];   // vacíos siempre al final
        const cmp = ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
        return o.asc ? cmp : -cmp;
      });
    }

    let indicesCols = g.columnas.map((_, j) => j);
    if (ocultarVacias.checked) indicesCols = indicesCols.filter((j) => g.filas.some((f) => f.v[j] !== ""));
    const conEstado = g.filas.some((f) => f.e);

    const cabecera = el("tr", null, conEstado ? el("th", { title: "Estado del pago" }) : null);
    for (const j of indicesCols) {
      cabecera.append(el("th", {
        text: g.columnas[j], scope: "col", title: "Ordenar por " + g.columnas[j],
        "aria-sort": o && o.col === j ? (o.asc ? "ascending" : "descending") : null,
        onclick: () => {
          const actual = orden[g.fuente];
          orden[g.fuente] = { col: j, asc: !(actual && actual.col === j && actual.asc) };
          pintarResultados();
        },
      }));
    }

    const cuerpo = el("tbody");
    let n = 0;
    for (const f of filas) {
      const coinciden = new Set(f.m);
      // La fila entera va del color de su estado de pago, igual que en la Matriz_Nube.
      const tr = el("tr", { class: f.e ? "fila-" + f.e : null, tabindex: "0", style: n < 40 ? `--i:${n++}` : null, onclick: (ev) => abrirDetalle(f.i, ev.currentTarget), onkeydown: (ev) => { if (ev.key === "Enter") abrirDetalle(f.i, ev.currentTarget); } });
      // data-label: en el celular cada fila se ve como una tarjeta, con el nombre de la
      // columna al lado de cada dato (ver «celular» en estilos.css).
      if (conEstado) {
        tr.append(el("td", { class: "estado", "data-label": f.e ? ESTADOS[f.e] || f.e : "Sin gestionar" },
          f.e ? el("span", { class: "punto e-" + f.e, title: ESTADOS[f.e] || f.e }) : null));
      }
      for (const j of indicesCols) {
        const v = f.v[j];
        const clases = [coinciden.has(j) ? "coincide" : "", /^-?[\d,]+(\.\d+)?$/.test(v) ? "num" : "", v === "" ? "vacia" : ""].join(" ").trim();
        tr.append(el("td", { class: clases || null, title: v.length > 30 ? v : null, text: v, "data-label": g.columnas[j] }));
      }
      cuerpo.append(tr);
    }

    const conteo = textoFiltro
      ? `${formatoMiles.format(filas.length)} de ${formatoMiles.format(g.total)}`
      : formatoMiles.format(g.total);
    return el("details", { class: "grupo", open: true },
      el("summary", null, el("span", { class: "titulo", text: g.fuente }), el("span", { class: "conteo", text: conteo })),
      el("div", { class: "tabla-envoltura" }, el("table", null, el("thead", null, cabecera), cuerpo)),
      g.recortado ? el("p", { class: "recorte", text: `Se muestran ${formatoMiles.format(g.filas.length)} de ${formatoMiles.format(g.total)}. «Exportar a Excel» trae todos.` }) : null,
    );
  }

  async function exportar() {
    if (!busqueda) return;
    const boton = $("#btn-exportar");
    boton.disabled = true;
    try {
      const resp = await api("/api/exportar/" + encodeURIComponent(busqueda.id));
      if (!resp.ok) {
        let msg = `Error ${resp.status}`;
        try { msg = (await resp.json()).error || msg; } catch (_) { /* nada */ }
        throw new Error(msg);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const nombre = "Busqueda_" + busqueda.termino.replace(/[^\w\-]+/g, "_").slice(0, 60) + ".xlsx";
      const a = el("a", { href: url, download: nombre });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      toast("No se pudo exportar: " + e.message);
    } finally {
      boton.disabled = false;
    }
  }

  // ------------------------------------------------------------------ detalle
  function abrirDetalle(i, origen) {
    return abrirDetalleDe(`/api/detalle/${encodeURIComponent(busqueda.id)}/${i}`, origen);
  }

  // ------------------------------------------------------------------ la fila se vuelve el detalle
  // Al tocar una fila (o una tarjeta, o un pago de la línea de tiempo), la ventana del
  // detalle crece desde ese elemento hasta su lugar, mientras el fondo se oscurece y se
  // desenfoca poco a poco; el contenido aparece cuando la ventana ya está en su sitio. Al
  // cerrarla hace el camino inverso. Se anima la ventana de verdad (no una foto de la
  // página), así el fondo desenfocado y el contenido nunca parpadean.
  let origenDetalle = null;
  const MS_ABRIR = 420, MS_CERRAR = 300;

  function enPantalla(n) {
    if (!n || !n.isConnected) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
  }

  // Lo que hay que mover para que la ventana quede encima del elemento de origen.
  function haciaOrigen(origen) {
    const o = origen.getBoundingClientRect(), f = dialogo.getBoundingClientRect();
    return `translate(${o.left - f.left}px, ${o.top - f.top}px) scale(${Math.max(.05, o.width / f.width)}, ${Math.max(.05, o.height / f.height)})`;
  }

  function mostrarDialogo(origen) {
    origenDetalle = origen || null;
    dialogo.classList.remove("cerrando");
    const desdeOrigen = enPantalla(origen) && !sinMovimiento() && Boolean(dialogo.animate);
    dialogo.classList.toggle("desde-origen", desdeOrigen);
    dialogo.showModal();
    dialogo.scrollTop = 0;
    if (!desdeOrigen) return;
    dialogo.classList.add("creciendo");   // el contenido espera, invisible
    dialogo.animate([
      { transform: haciaOrigen(origen), borderRadius: "14px", opacity: .5 },
      { transform: "none", borderRadius: "24px", opacity: 1 },
    ], { duration: MS_ABRIR, easing: "cubic-bezier(.2, .85, .25, 1)" });
    setTimeout(() => dialogo.classList.remove("creciendo"), MS_ABRIR * .55);
  }

  function cerrarDetalle() {
    if (!dialogo.open || dialogo.classList.contains("cerrando")) return;
    const origen = origenDetalle;
    origenDetalle = null;
    if (sinMovimiento() || !dialogo.animate) { dialogo.close(); return; }
    dialogo.classList.add("cerrando");   // el contenido se apaga y el fondo se aclara
    const final = enPantalla(origen)
      ? [{ transform: "none", opacity: 1 }, { transform: haciaOrigen(origen), borderRadius: "14px", opacity: 0 }]
      : [{ transform: "none", opacity: 1 }, { transform: "translateY(10px) scale(.97)", opacity: 0 }];
    const a = dialogo.animate(final, { duration: MS_CERRAR, easing: "cubic-bezier(.4, 0, .6, 1)", fill: "forwards" });
    const terminar = () => {
      if (!dialogo.classList.contains("cerrando")) return;
      dialogo.close();
      dialogo.classList.remove("cerrando", "desde-origen");
      a.cancel();
    };
    a.finished.then(terminar, terminar);
  }

  // Primero los datos y después la ventana, que llega ya llena (sin «Cargando…» que se
  // cambia por el contenido). Si tardan más de un cuarto de segundo, se abre con «Cargando…».
  async function abrirDetalleDe(url, origen) {
    const pedido = apiJson(url).then((r) => ({ datos: r.datos }), (error) => ({ error }));
    const pintar = (r) => (r.error
      ? cuerpoDetalle.replaceChildren(el("p", { class: "aviso aviso-error", text: r.error.message }))
      : pintarDetalle(r.datos));
    if (dialogo.open && !dialogo.classList.contains("cerrando")) {
      cuerpoDetalle.replaceChildren(el("p", { class: "gris", text: "Cargando…" }));
      pintar(await pedido);
      return;
    }
    const pronto = await Promise.race([pedido, new Promise((r) => setTimeout(() => r(null), 250))]);
    if (pronto) {
      pintar(pronto);
      mostrarDialogo(origen);
      return;
    }
    $("#detalle-titulo").textContent = "Detalle del resultado";
    cuerpoDetalle.replaceChildren(el("p", { class: "gris", text: "Cargando…" }));
    mostrarDialogo(origen);
    pintar(await pedido);
  }

  // Enlace a una hoja o archivo de Google. La versión de navegador (con sesión de Google)
  // define window.axioMejorarEnlace para agregarle la vista previa al pasar el mouse y
  // abrir la tabla dentro de Axio; en el servidor queda como un enlace normal.
  function enlaceHoja(texto, url, extra) {
    const a = el("a", { class: "boton boton-chico", href: url, target: "_blank", rel: "noopener noreferrer", text: texto, ...(extra || {}) });
    if (typeof window.axioMejorarEnlace === "function") window.axioMejorarEnlace(a, url);
    return a;
  }

  function pintarCampos(lista) {
    const campos = el("div", { class: "campos" });
    for (const c of lista) {
      const entrada = el("input", { readonly: true, "aria-label": c.columna });
      entrada.value = c.valor || "—";
      campos.append(el("div", { class: "campo" },
        el("span", { class: "nombre", text: c.columna }),
        entrada,
        el("div", { class: "campo-acciones" },
          c.enlace ? enlaceHoja("↗", c.enlace, { title: "Abrir enlace" }) : null,
          el("button", { class: "boton boton-chico", type: "button", title: "Copiar", text: "📋", onclick: (ev) => copiar(c.valor, "Copiado.", ev.currentTarget) }))));
    }
    return campos;
  }

  let ultimoDetalle = null;   // el pago abierto, para volver a él desde una obligación

  function pintarDetalle(d) {
    ultimoDetalle = d;
    $("#detalle-titulo").textContent = "Detalle del resultado";
    const partes = [el("p", { class: "fuente-detalle", text: "📂 " + d.fuente })];

    // El estado puede cambiar sin volver a buscar (al gestionar el pago, ver abajo).
    const estado = el("div", { class: "estado-pago" });
    let estadoInicial = true;
    const mostrarEstado = (e) => {
      estado.style.display = e ? "" : "none";
      if (e) { estado.style.background = e.color; estado.textContent = `${e.icono} ${e.etiqueta}`; }
      // Cuando cambia después de abrir (se gestionó el pago), un pulso para que se note.
      if (!estadoInicial && e) {
        estado.classList.remove("estado-cambio");
        void estado.offsetWidth;   // reinicia la animación
        estado.classList.add("estado-cambio");
      }
      estadoInicial = false;
    };
    mostrarEstado(d.estado_pago);
    partes.push(estado);

    // La versión de navegador (con sesión de Google) agrega aquí cómo gestionar el pago en
    // la Matriz_Nube: RWS, nota de Cartera, crédito, nota de Recaudo. En el servidor no
    // aparece nada.
    if (typeof window.axioGestionPago === "function") {
      const gestion = window.axioGestionPago(d, mostrarEstado);
      if (gestion) partes.push(gestion);
    }

    // Encargado de Cartera: lo primero que se quiere ver.
    const cartera = el("div", { class: "tarjeta" });
    if (d.distrito === null) {
      cartera.append(el("p", { class: "gris", text: "ℹ️ Esta fuente no trae columna de Distrito; no se puede ubicar un encargado de Cartera." }));
    } else if (d.encargado) {
      cartera.append(
        el("h3", { text: `📇 Encargado de Cartera · Distrito ${d.distrito}` }),
        el("p", null, el("strong", { text: d.encargado.nombre }), d.encargado.cargo ? `  ·  ${d.encargado.cargo}` : ""),
      );
      if (d.encargado.extension) {
        cartera.append(el("div", { class: "fila-flex" },
          el("span", { class: "gris", text: `☎️ Extensión ${d.encargado.extension}` }),
          el("button", { class: "boton boton-chico", type: "button", text: "Copiar", onclick: (ev) => copiar(d.encargado.extension, "Extensión copiada.", ev.currentTarget) })));
      } else {
        cartera.append(el("p", { class: "gris", text: "☎️ Sin extensión registrada" }));
      }
    } else {
      cartera.append(el("p", { class: "aviso aviso-ambar", text: `⚠️ Ningún encargado asignado al distrito «${d.distrito}» en el Directorio de Cartera.` }));
    }
    partes.push(cartera);

    if (d.cedula) {
      partes.push(el("div", { class: "fila-flex" },
        el("strong", { text: "🪪 Cédula:" }),
        el("span", { class: "cedula-valor", text: d.cedula }),
        el("button", { class: "boton boton-principal boton-chico", type: "button", text: "📋 Copiar cédula",
          onclick: (ev) => copiar(d.cedula_limpia || d.cedula, "Cédula copiada, lista para pegar en Siasoft.", ev.currentTarget) }),
        d.whatsapp ? anotarAlTocar(botonWhatsapp(d.whatsapp, mensajePago(d)), { tipo: "whatsapp", plantilla: "Sobre un pago" }, d.cedula_limpia) : null));
    }

    const creditos = el("div", { class: "tarjeta" }, el("h3", { text: "💳 Líneas de crédito" }));
    if (d.lineas === null) {
      creditos.append(el("p", { class: "gris", text: "ℹ️ " + d.motivo_sin_lineas }));
    } else if (!d.lineas.length) {
      creditos.append(el("p", { class: "gris", text: "Sin créditos activos en las líneas cargadas para esta cédula." }));
    } else {
      for (const linea of d.lineas) {
        for (const e of linea.entradas) creditos.append(pintarCredito(linea.linea, e));
      }
    }
    partes.push(creditos);

    partes.push(el("div", null, el("h3", { class: "gris", style: "margin:4px 0 8px;font-size:13px", text: "Todos los campos" }), pintarCampos(d.campos)));

    const textoCompleto = d.campos.map((c) => `${c.columna}: ${c.valor}`).join("\n");
    partes.push(el("div", { class: "pie-detalle" },
      el("button", { class: "boton", type: "button", text: "📋 Copiar todo el detalle", onclick: (ev) => copiar(textoCompleto, "Detalle copiado.", ev.currentTarget) }),
      el("button", { class: "boton boton-principal", type: "button", text: "Cerrar", onclick: cerrarDetalle })));

    cuerpoDetalle.replaceChildren(...partes);
    dialogo.scrollTop = 0;
  }

  // ------------------------------------------------------------------ detalle de una obligación
  // La fila completa del crédito en la hoja de su línea, presentada como el detalle de un
  // pago: estado arriba, resumen, enlaces y todos los campos con su botón de copiar.
  function buscarCampo(campos, ...palabras) {
    const c = (campos || []).find((x) => palabras.every((p) => x.columna.toUpperCase().includes(p)));
    return c ? c.valor : null;
  }

  // ------------------------------------------------------------------ colores de las líneas
  // Los mismos que pone el formato condicional de las hojas de las líneas de crédito.
  // La fila va en rojo o verde según «ESTADO: MORA/DIA»: esa es la columna que manda, no
  // «ESTADO PAGO AUTOMATICO», que en varias hojas dice «al día» con la fila en rojo.
  const sinTildes = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase();

  function estadoCredito(e) {
    const valor = buscarCampo(e.campos, "MORA/DIA") || buscarCampo(e.campos, "ESTADO PAGO AUTOMATICO") || "";
    const v = sinTildes(valor);
    if (/MORA/.test(v) || (!v && e.en_mora === true)) return { mora: true, texto: "En mora" };
    if (/DIA/.test(v) || (!v && e.en_mora === false)) return { mora: false, texto: "Al día" };
    return { mora: null, texto: "Activo" };
  }

  // Columna «OBSERVACIÓN (Activos/Inactivos)»: cada novedad con su color en la hoja.
  const NOVEDADES_CREDITO = {
    "PAZ Y SALVO": ["#F1C232", "#1f1f1f"],
    "ACUERDO DE PAGO": ["#0B5394", "#fff"],
    "REFINANCIACION": ["#A2C4C9", "#1f1f1f"],
    "RETANQUEO": ["#F9CB9C", "#1f1f1f"],
    "AMPLIACION": ["#8E7CC3", "#1f1f1f"],
    "DESCUENTO DE ANTICIPO": ["#990000", "#fff"],
    "AUXILIO DE RETIRO MINISTERIO": ["#274E13", "#fff"],
  };

  function etiquetasCredito(e) {
    const etiquetas = [];
    const novedad = sinTildes(e.observacion_estado);
    const color = NOVEDADES_CREDITO[novedad];
    if (color) {
      etiquetas.push(el("span", { class: "etiqueta-hoja", style: `background:${color[0]};color:${color[1]}`,
        text: e.observacion_estado, title: "Observación en la hoja de la línea" }));
    }
    // «PENDIENTES AREA CARTERA» = LLAMAR: en la hoja, la celda de al lado va en morado.
    if (sinTildes(buscarCampo(e.campos, "PENDIENTES AREA CARTERA")) === "LLAMAR") {
      etiquetas.push(el("span", { class: "etiqueta-hoja", style: "background:#B4A7D6;color:#1f1f1f",
        text: "📞 Llamar", title: "Pendiente del área de Cartera" }));
    }
    return etiquetas;
  }

  // origen: la tarjeta que se tocó, desde donde crece la ventana (ver mostrarDialogo).
  function abrirObligacion(nombreLinea, e, origen) {
    const desdePago = dialogo.open && ultimoDetalle ? ultimoDetalle : null;
    if (!dialogo.open) {
      pintarObligacion(nombreLinea, e, null);
      mostrarDialogo(origen);
      return;
    }
    pintarObligacion(nombreLinea, e, desdePago);
  }

  function pintarObligacion(nombreLinea, e, desdePago) {
    $("#detalle-titulo").textContent = "Detalle de la obligación";

    const partes = [el("p", { class: "fuente-detalle", text: "💳 " + nombreLinea })];

    // Al día / en mora, como lo marca la hoja de la línea.
    const estado = estadoCredito(e);
    partes.push(el("div", { class: "estado-pago " + (estado.mora ? "estado-mora" : "estado-activo") },
      `${estado.mora ? "🔴" : "🟢"} Crédito activo${estado.mora !== null ? " · " + estado.texto : ""}`));
    const etiquetas = etiquetasCredito(e);
    if (etiquetas.length) partes.push(el("div", { class: "etiquetas-credito" }, ...etiquetas));

    const descripcion = [e.congregacion, e.cco ? "CCO " + e.cco : null, e.distrito ? "Distrito " + e.distrito : null].filter(Boolean);
    const cabecera = el("div", { class: "tarjeta" },
      el("h3", { text: "📄 Obligación" }),
      el("p", null, el("strong", { text: e.tipo_credito || nombreLinea })),
      descripcion.length ? el("p", { class: "gris", text: descripcion.join("  ·  ") }) : null,
      e.nombre ? el("p", { class: "gris", text: "👤 " + e.nombre }) : null);
    const enlaces = el("div", { class: "fila-flex" });
    if (e.link_registro) enlaces.append(enlaceHoja("🔗 Último registro", e.link_registro));
    if (e.link_obligacion && e.link_obligacion !== e.link_registro) enlaces.append(enlaceHoja("🔗 Ver obligación", e.link_obligacion));
    if (enlaces.childElementCount) cabecera.append(enlaces);
    partes.push(cabecera);

    const resumen = [
      [e.saldo_actual ? "Saldo actual" : etiquetaColumna(e.columna_saldo, "Saldo actual"),
        e.saldo_actual ? "$ " + e.saldo_actual : (e.saldo ? "$ " + e.saldo : null)],
      ["Último pago", e.fecha_ultimo_pago],
      ["Última cuota paga", buscarCampo(e.campos, "ULTIMA CUOTA PAGA")],
      ["Altura", buscarCampo(e.campos, "ALTURA")],
      ["Observación", e.observacion_estado],
      [etiquetaColumna(e.columna_tarifa, "Tarifa"), e.tarifa ? "$ " + e.tarifa : null],
      ["Meses en mora", e.meses_mora],
    ].filter(([, v]) => v);
    if (resumen.length) {
      partes.push(el("dl", { class: "credito-datos obligacion-resumen" },
        ...resumen.map(([etiqueta, valor]) => el("div", null, el("dt", { text: etiqueta }), el("dd", { text: valor })))));
    }

    const campos = e.campos || [];
    partes.push(el("div", null,
      el("h3", { class: "gris", style: "margin:4px 0 8px;font-size:13px", text: `Todos los campos de la hoja · ${campos.length}` }),
      pintarCampos(campos)));

    const textoCompleto = [`${nombreLinea}`, ...campos.map((c) => `${c.columna}: ${c.valor}`)].join("\n");
    partes.push(el("div", { class: "pie-detalle" },
      desdePago ? el("button", { class: "boton", type: "button", text: "← Volver al pago", onclick: () => pintarDetalle(desdePago) }) : null,
      el("button", { class: "boton", type: "button", text: "📋 Copiar todo", onclick: (ev) => copiar(textoCompleto, "Obligación copiada.", ev.currentTarget) }),
      el("button", { class: "boton boton-principal", type: "button", text: "Cerrar", onclick: cerrarDetalle })));

    cuerpoDetalle.replaceChildren(...partes);
    dialogo.scrollTop = 0;
  }

  // El chat de WhatsApp con un mensaje ya escrito: se abre en WhatsApp para revisarlo y
  // enviarlo (o cambiarlo); nada sale solo.
  function botonWhatsapp(enlace, mensaje) {
    const href = mensaje ? `${enlace}?text=${encodeURIComponent(mensaje)}` : enlace;
    return el("a", { class: "boton boton-whatsapp boton-chico", href, target: "_blank", rel: "noopener noreferrer",
      title: mensaje ? "Abre el chat con un mensaje listo para revisar y enviar" : "Abrir el chat de WhatsApp de esta persona", text: "💬 WhatsApp" });
  }

  const anotarAlTocar = (nodo, accion, cedula) => { nodo.addEventListener("click", () => anotarAccion(accion, cedula)); return nodo; };

  // "PÉREZ GÓMEZ ANÍBAL" -> "Pérez Gómez Aníbal".
  const nombrePropio = (texto) => String(texto || "").toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()).trim();

  function mensajeAsociado(a, creditos) {
    const enMora = creditos.filter((x) => x.estado.mora);
    const partes = [`Hola, ${nombrePropio(a.nombre) || "buen día"}. Le saludamos del área de Cartera.`];
    if (enMora.length) {
      partes.push(enMora.length === 1 ? "Según nuestros registros, tiene una obligación pendiente:" : `Según nuestros registros, tiene ${enMora.length} obligaciones pendientes:`);
      for (const x of enMora) {
        const saldo = x.e.saldo_actual || x.e.saldo;
        const datos = [saldo ? `saldo ${conPesos(saldo)}` : null, x.e.meses_mora ? `${x.e.meses_mora} ${x.e.meses_mora === "1" ? "mes" : "meses"} en mora` : null].filter(Boolean);
        partes.push(`• ${x.e.tipo_credito && x.e.tipo_credito !== x.linea ? x.e.tipo_credito : x.linea}${datos.length ? ": " + datos.join(", ") : ""}`);
      }
      partes.push("Quedamos atentos para ayudarle a ponerse al día.");
    } else {
      partes.push("Quedamos atentos a cualquier inquietud.");
    }
    return partes.join("\n");
  }

  function mensajePago(d) {
    // Exacto: «NOMBRE / TIPO» también contiene la palabra.
    const campoNombre = (d.campos || []).find((c) => c.columna.trim().toUpperCase() === "NOMBRE");
    const nombre = nombrePropio(campoNombre ? campoNombre.valor : "");
    const fecha = buscarCampo(d.campos, "FECHA");
    const valor = buscarCampo(d.campos, "VALOR");
    const sobre = [fecha ? `del ${fecha}` : null, valor ? `por ${conPesos(valor)}` : null].filter(Boolean).join(" ");
    return `Hola${nombre && !/^#/.test(nombre) ? ", " + nombre : ""}. Le saludamos del área de Cartera.\n`
      + `Le escribimos sobre su pago${sobre ? " " + sobre : ""}. Quedamos atentos.`;
  }

  // "Pérez Gómez Aníbal" -> "PG".
  const iniciales = (nombre) => String(nombre || "?").trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join("") || "?";

  // '15/07/2026' o '2026-07-15' -> Date (o null).
  function aFecha(texto) {
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto || "");
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(texto || "");
    return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
  }
  const fechaCorta = (f) => `${String(f.getDate()).padStart(2, "0")} ${MESES_CORTOS[f.getMonth()]} ${f.getFullYear()}`;

  // Pagos de los últimos 12 meses (hasta el mes del último pago): una columna por mes. Tocar
  // un mes con pagos llama alElegir(clave 'aaaa-mm'); el nodo trae marcarMes(clave o null)
  // para resaltar el elegido.
  function graficoPagos(pagos, alElegir) {
    const conFecha = pagos.filter((p) => p.fecha && p.valor !== null);
    if (!conFecha.length) return null;
    const ultimo = aFecha(conFecha[0].fecha);
    const meses = [];
    for (let i = 11; i >= 0; i--) {
      const f = new Date(ultimo.getFullYear(), ultimo.getMonth() - i, 1);
      meses.push({ clave: `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, "0")}`, suma: 0, n: 0 });
    }
    const porClave = Object.fromEntries(meses.map((m) => [m.clave, m]));
    for (const p of conFecha) {
      const m = porClave[p.fecha.slice(0, 7)];
      if (m) { m.suma += p.valor; m.n += 1; }
    }
    const tope = topeRedondo(Math.max(1, ...meses.map((m) => m.suma)));
    const total = meses.reduce((s, m) => s + m.suma, 0);
    const marco = el("div", { class: "tb-columnas-marco ficha-columnas" },
      el("div", { class: "tb-eje", "aria-hidden": "true" },
        ...[1, 0.5, 0].map((f) => el("span", { style: `bottom:${f * 100}%` }, el("em", { text: f ? pesosCortos(tope * f) : "0" })))),
      el("div", { class: "tb-columnas", role: "list" }, ...meses.map((m, i) => {
        const tip = `${nombreMes(m.clave, true)}\n${m.n ? `${m.n} pago${m.n === 1 ? "" : "s"} · ${pesos(m.suma)}\nToca para ver sus pagos` : "Sin pagos"}`;
        const anioCambia = i === 0 || meses[i - 1].clave.slice(0, 4) !== m.clave.slice(0, 4);
        const partes = [
          el("span", { class: "tb-pila", style: `height:${(m.suma / tope) * 100}%` }, m.suma ? el("span", { style: "flex:1;background:var(--g-acento)" }) : null),
          el("span", { class: "tb-mes" + ((meses.length - 1 - i) % 3 ? " tb-mes-menor" : ""), text: nombreMes(m.clave) + (anioCambia ? " " + m.clave.slice(2, 4) : "") })];
        // --i: las columnas crecen una tras otra (ver «gráficos vivos» en estilos.css).
        return m.n
          ? el("button", { type: "button", class: "tb-columna", role: "listitem", "data-mes": m.clave, "data-tip": tip,
              "aria-label": tip.replace(/\n/g, ". "), style: `--i:${i}`, onclick: () => alElegir && alElegir(m.clave) }, ...partes)
          : el("span", { class: "tb-columna tb-columna-vacia", role: "listitem", tabindex: "0", "data-tip": tip, "aria-label": tip.replace("\n", ": "), style: `--i:${i}` }, ...partes);
      })));
    const nodo = el("div", { class: "ficha-grafico" },
      el("div", { class: "ficha-subtitulo" }, el("span", { text: "Pagos de los últimos 12 meses" }), el("strong", { text: pesos(total) })),
      marco);
    nodo.marcarMes = (clave) => {
      marco.classList.toggle("con-mes", Boolean(clave));
      for (const c of marco.querySelectorAll("[data-mes]")) {
        c.classList.toggle("tb-columna-activa", c.dataset.mes === clave);
        c.setAttribute("aria-pressed", String(c.dataset.mes === clave));
      }
    };
    return nodo;
  }

  // Línea de tiempo: cada pago (con su estado y las notas de la gestión) y el último pago
  // registrado en cada crédito, del más reciente al más viejo. El nodo trae filtrarMes(clave
  // o null): con un mes, solo los movimientos de ese mes (lo pide el gráfico de pagos);
  // alQuitarMes se llama cuando se quita el filtro desde aquí.
  const MOVIMIENTOS_VISIBLES = 6;
  function lineaDeTiempo(pagos, creditos, alQuitarMes) {
    const eventos = pagos.map((p) => ({ fecha: aFecha(p.fecha), pago: p }));
    for (const x of creditos) {
      const f = aFecha(x.e.fecha_ultimo_pago);
      if (f) eventos.push({ fecha: f, credito: x });
    }
    if (!eventos.length) return null;
    eventos.sort((a, b) => (b.fecha ? b.fecha.getTime() : 0) - (a.fecha ? a.fecha.getTime() : 0));

    const item = (ev) => {
      if (ev.credito) {
        const x = ev.credito;
        return el("li", { class: "tl-item tl-credito" },
          el("span", { class: "tl-punto", "aria-hidden": "true" }),
          el("time", { text: ev.fecha ? fechaCorta(ev.fecha) : "Sin fecha" }),
          el("div", { class: "tl-cuerpo" },
            el("strong", { text: `💳 Último pago registrado en ${x.linea}` }),
            x.e.tipo_credito && x.e.tipo_credito !== x.linea ? el("span", { class: "gris", text: x.e.tipo_credito }) : null));
      }
      const p = ev.pago;
      const notas = [
        p.rws ? ["Recibo (RWS)", p.rws] : null,
        p.nota_cartera ? ["Nota de Cartera", p.nota_cartera] : null,
        p.nota_recaudo ? ["Nota de Recaudo", p.nota_recaudo] : null,
      ].filter(Boolean);
      return el("li", { class: "tl-item" + (p.e ? " tl-" + p.e : "") },
        el("span", { class: "tl-punto", "aria-hidden": "true", style: `background:${colorEstado(p.e || "sin")}` }),
        el("time", { text: ev.fecha ? fechaCorta(ev.fecha) : "Sin fecha" }),
        el("button", { type: "button", class: "tl-cuerpo tl-pago", title: "Ver el detalle de este pago",
          onclick: (ev) => abrirDetalleDe(`/api/tabla/detalle/${p.p}`, ev.currentTarget) },
          el("span", { class: "tl-linea1" },
            el("strong", { text: p.valor !== null ? pesos(p.valor) : "Pago" }),
            el("span", { class: "tl-estado", text: NOMBRES_ESTADO[p.e || "sin"] })),
          el("span", { class: "gris", text: [p.detalle, p.banco].filter(Boolean).join(" · ") }),
          ...notas.map(([etiqueta, texto]) => el("span", { class: "tl-nota" }, el("em", { text: etiqueta + ": " }), texto))));
    };

    // --i: los movimientos entran uno tras otro (ver «gráficos vivos» en estilos.css).
    const items = (lista) => lista.map((ev, i) => { const li = item(ev); li.style.setProperty("--i", Math.min(i, 12)); return li; });
    const claveMes = (f) => (f ? `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, "0")}` : "");
    const lista = el("ol", { class: "tl-lista" });
    const resumen = el("strong");
    const pie = el("div");
    const nodo = el("div", { class: "ficha-tiempo" },
      el("div", { class: "ficha-subtitulo" }, el("span", { text: "Línea de tiempo" }), resumen), lista, pie);

    nodo.filtrarMes = (clave) => {
      const delMes = clave ? eventos.filter((ev) => claveMes(ev.fecha) === clave) : eventos;
      if (clave) {
        const n = delMes.filter((ev) => ev.pago).length;
        resumen.replaceChildren(el("span", { class: "tl-filtro" },
          `${nombreMes(clave, true)} · ${n} pago${n === 1 ? "" : "s"}`,
          el("button", { type: "button", class: "tl-filtro-quitar", title: "Ver todos los movimientos", "aria-label": "Ver todos los movimientos", text: "✕",
            onclick: () => { nodo.filtrarMes(null); if (alQuitarMes) alQuitarMes(); } })));
        lista.replaceChildren(...items(delMes));
        pie.replaceChildren();
        return;
      }
      resumen.replaceChildren(`${pagos.length} pago${pagos.length === 1 ? "" : "s"} en Extractos`);
      lista.replaceChildren(...items(eventos.slice(0, MOVIMIENTOS_VISIBLES)));
      pie.replaceChildren(eventos.length > MOVIMIENTOS_VISIBLES
        ? el("button", { type: "button", class: "boton boton-chico tl-mas", text: `Ver los ${eventos.length} movimientos`,
            onclick: (ev) => { lista.replaceChildren(...items(eventos)); ev.currentTarget.remove(); } })
        : "");
    };
    // Para imprimir la ficha: todos los movimientos, sin filtro de mes.
    nodo.mostrarTodo = () => {
      nodo.filtrarMes(null);
      if (alQuitarMes) alQuitarMes();
      lista.replaceChildren(...items(eventos));
      pie.replaceChildren();
    };
    nodo.filtrarMes(null);
    return nodo;
  }

  function pintarAsociado(a) {
    const pagos = a.pagos || [];
    // Primero los créditos en mora (lo que hay que gestionar), después los demás; dentro de
    // cada grupo, en el orden de las líneas.
    const todos = creditosDe(a);

    const datosClave = [
      ["🪪", "CC " + a.cedula],
      a.distrito ? ["📍", "Distrito " + a.distrito] : null,
      pagos.length ? ["🧾", `${pagos.length} pago${pagos.length === 1 ? "" : "s"}${pagos[0].fecha ? " · último " + fechaCorta(aFecha(pagos[0].fecha)) : ""}`] : null,
    ].filter(Boolean);
    const cabecera = el("div", { class: "asociado-cabecera" },
      el("span", { class: "asociado-avatar", "aria-hidden": "true", text: iniciales(a.nombre) }),
      el("div", { class: "asociado-nombre" },
        el("strong", { text: a.nombre || "Asociado" }),
        el("div", { class: "asociado-chips" }, ...datosClave.map(([icono, texto]) => el("span", { class: "chip-dato" }, icono + " " + texto)))),
      el("div", { class: "asociado-acciones" },
        el("button", { class: "boton boton-chico", type: "button", text: "📋 Copiar cédula",
          onclick: (ev) => copiar(a.cedula_limpia, "Cédula copiada, lista para pegar en Siasoft.", ev.currentTarget) }),
        el("button", { class: "boton boton-chico boton-llamar", type: "button", text: "📞 Modo llamada",
          title: "Nombre, celular y mora a la vista mientras llamas, y el resultado en un toque (tecla L)", onclick: () => abrirLlamada(a) }),
        a.whatsapp ? whatsappConPlantillas(a, todos) : null,
        el("button", { class: "boton boton-chico", type: "button", text: "🖨️ Imprimir ficha",
          title: "Imprime solo esta ficha. En la ventana de impresión se puede elegir «Guardar como PDF».",
          onclick: imprimirFicha })));

    const creditos = el("div", { class: "asociado-creditos" },
      ...todos.map((x) => pintarCredito(x.linea, x.e, true)));

    const enMora = todos.filter((x) => x.estado.mora).length;
    const alDia = todos.filter((x) => x.estado.mora === false).length;
    const titulo = a.total_creditos
      ? `💳 ${a.total_creditos} crédito${a.total_creditos === 1 ? "" : "s"} activo${a.total_creditos === 1 ? "" : "s"}`
      : "💳 Sin créditos activos en las líneas de crédito";
    // Barra de proporción: cuánto de lo que tiene la persona está en mora y cuánto al día.
    const barra = todos.length > 1 && (enMora || alDia)
      ? el("div", { class: "asociado-barra", role: "img", "aria-label": `${enMora} en mora y ${alDia} al día de ${todos.length}` },
          enMora ? el("span", { class: "barra-mora", style: `flex:${enMora}` }) : null,
          alDia ? el("span", { class: "barra-dia", style: `flex:${alDia}` }) : null,
          todos.length - enMora - alDia ? el("span", { class: "barra-otro", style: `flex:${todos.length - enMora - alDia}` }) : null)
      : null;
    // Solo se ven al imprimir la ficha (ver «ficha del asociado» en estilos.css).
    const ahora = new Date();
    const quien = (($(".usuario-nombre") || {}).textContent || "").trim();
    const membrete = el("div", { class: "ficha-impresion" },
      el("strong", { text: "Axio · Ficha del asociado" }),
      el("div", null,
        el("span", { text: `Consultada el ${ahora.toLocaleDateString("es-CO", { day: "2-digit", month: "long", year: "numeric" })} a las ${ahora.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}` }),
        quien ? el("span", { text: "Por " + quien }) : null));
    const pie = el("p", { class: "ficha-pie", text: "Documento de uso interno con datos personales protegidos por la Ley 1581 de 2012. No compartir fuera de la entidad." });
    // Pagos por mes y línea de tiempo, lado a lado (uno debajo del otro en el celular). No van
    // en la ficha: pintarResultados los pone debajo de la tabla de los Extractos.
    // Tocar un mes del gráfico deja en la línea de tiempo solo los movimientos de ese mes.
    let mesElegido = null;
    const elegirMes = (clave) => {
      mesElegido = mesElegido === clave ? null : clave;
      if (tiempo) tiempo.filtrarMes(mesElegido);
      grafico.marcarMes(mesElegido);
    };
    const grafico = graficoPagos(pagos, elegirMes);
    const tiempo = lineaDeTiempo(pagos, todos, () => { mesElegido = null; if (grafico) grafico.marcarMes(null); });
    historiaAsociado = grafico || tiempo ? el("div", { class: "ficha-historia" }, grafico, tiempo) : null;
    if (historiaAsociado) animarAlVer(historiaAsociado);
    return el("section", { class: "asociado" + (enMora ? " asociado-con-mora" : "") }, membrete, cabecera,
      el("div", { class: "asociado-resumen" },
        el("h3", { class: "asociado-titulo" }, titulo),
        enMora ? el("span", { class: "asociado-mora", text: `🔴 ${enMora} en mora` }) : null,
        alDia && enMora ? el("span", { class: "asociado-dia", text: `🟢 ${alDia} al día` }) : null,
        barra),
      a.total_creditos ? creditos : null, pie);
  }

  function imprimirFicha() {
    // Los gráficos que aún no se vieron siguen en pausa en su primer cuadro (invisibles):
    // al papel van completos, con todos los movimientos de la línea de tiempo.
    soltarPorVer();
    const tiempo = document.querySelector(".ficha-tiempo");
    if (tiempo && tiempo.mostrarTodo) tiempo.mostrarTodo();
    anotarAccion({ tipo: "ficha" });
    document.body.classList.add("imprimir-ficha");
    window.addEventListener("afterprint", () => document.body.classList.remove("imprimir-ficha"), { once: true });
    window.print();
  }

  // "$ 15,328,095" si es una cifra; "PAZ Y SALVO" tal cual (sin el signo de pesos delante).
  const conPesos = (v) => (v === null || v === undefined || v === "" ? null : /\d/.test(String(v)) ? "$ " + v : String(v));

  // Tarjeta de un crédito en el resumen de la persona: línea y estado arriba, el saldo en
  // grande, las demás cifras en casillas y los enlaces abajo. Todas iguales, también la del
  // Seguro de Vida (tarifa y saldo del mes en vez de saldo actual).
  function tarjetaCredito(nombreLinea, e) {
    const estado = estadoCredito(e);
    const etiquetas = etiquetasCredito(e);
    const descripcion = [e.congregacion, e.cco ? "CCO " + e.cco : null, e.distrito ? "Distrito " + e.distrito : null].filter(Boolean);
    const conDetalle = Boolean(e.campos && e.campos.length);
    const nodo = el("article", {
      class: "tarjeta-credito" + (estado.mora ? " credito-mora" : estado.mora === false ? " credito-dia" : "") + (conDetalle ? " credito-clic" : ""),
      role: conDetalle ? "button" : null, tabindex: conDetalle ? "0" : null,
      title: conDetalle ? "Ver la obligación completa" : null,
      onclick: conDetalle ? (ev) => abrirObligacion(nombreLinea, e, ev.currentTarget) : null,
      onkeydown: conDetalle ? (ev) => { if (ev.key === "Enter") abrirObligacion(nombreLinea, e, ev.currentTarget); } : null,
    });

    // filter(Boolean): append() de DOM escribiría «null» por cada parte que falta.
    nodo.append(...[
      el("div", { class: "tc-cabecera" },
        el("span", { class: "tc-linea", text: nombreLinea }),
        el("span", { class: "insignia" + (estado.mora ? " insignia-mora" : ""), text: (estado.mora ? "● " : "") + estado.texto.toUpperCase() })),
      el("strong", { class: "tc-titulo", text: e.tipo_credito && e.tipo_credito !== nombreLinea ? e.tipo_credito : (e.nombre || nombreLinea) }),
      descripcion.length ? el("span", { class: "tc-descripcion", text: descripcion.join("  ·  ") }) : null,
      etiquetas.length ? el("div", { class: "etiquetas-credito" }, ...etiquetas) : null,
    ].filter(Boolean));

    // La cifra principal: el saldo actual de la tabla, o el saldo del mes (Seguro de Vida).
    const saldo = e.saldo_actual ? ["Saldo actual", conPesos(e.saldo_actual)]
      : e.saldo ? [etiquetaColumna(e.columna_saldo, "Saldo"), conPesos(e.saldo)] : null;
    if (saldo) {
      const cifra = el("strong", { text: saldo[1] });
      nodo.append(el("div", { class: "tc-saldo" + (/\d/.test(saldo[1]) ? "" : " tc-saldo-texto") },
        el("span", { text: saldo[0] }), cifra));
      contarHasta(cifra, saldo[1]);
    }

    const datos = [
      ["Observación", e.observacion_estado],
      ["Último pago", e.fecha_ultimo_pago],
      [etiquetaColumna(e.columna_tarifa, "Tarifa"), conPesos(e.tarifa)],
      ["Meses en mora", e.meses_mora, e.en_mora ? "dato-mora" : null],
    ].filter(([, v]) => v);
    if (datos.length) {
      nodo.append(el("dl", { class: "credito-datos tc-datos" },
        ...datos.map(([etiqueta, valor, clase]) => el("div", { class: clase }, el("dt", { text: etiqueta }), el("dd", { text: valor })))));
    }
    // La hoja la titula «OBSERVACION DIRECTIVOS (NO REPORTAR)»: es de uso interno.
    if (e.observacion_directivos) nodo.append(el("p", { class: "tc-nota", text: "📝 Directivos (no reportar): " + e.observacion_directivos }));
    if (e.observacion_general) nodo.append(el("p", { class: "tc-nota", text: "📝 General: " + e.observacion_general }));

    // Los enlaces no abren el detalle: solo su propia pestaña.
    const sinBurbuja = (ev) => ev.stopPropagation();
    const pie = el("div", { class: "tc-pie" });
    if (e.link_obligacion) pie.append(enlaceHoja("🔗 Ver obligación", e.link_obligacion, { onclick: sinBurbuja }));
    if (e.link_registro && e.link_registro !== e.link_obligacion) pie.append(enlaceHoja("🔗 Último registro", e.link_registro, { onclick: sinBurbuja }));
    if (conDetalle) pie.append(el("span", { class: "credito-ver", text: "Ver completa ›" }));
    if (pie.childElementCount) nodo.append(pie);
    return nodo;
  }

  // 'SALDO A AGOSTO 2026' -> 'Saldo a agosto 2026': el título de la hoja dice de qué mes es.
  function etiquetaColumna(titulo, porDefecto) {
    const t = String(titulo || "").replace(/\s+/g, " ").trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : porDefecto;
  }

  function pintarCredito(nombreLinea, e, comoTarjeta) {
    if (comoTarjeta) return tarjetaCredito(nombreLinea, e);
    const descripcion = [];
    if (e.congregacion) descripcion.push(e.congregacion);
    if (e.cco) descripcion.push("CCO " + e.cco);
    if (e.distrito) descripcion.push("Distrito " + e.distrito);

    // Los enlaces no abren el detalle: solo su propia pestaña.
    const sinBurbuja = (ev) => ev.stopPropagation();
    const enlaces = el("div", { class: "credito-enlaces" });
    if (e.link_registro) {
      enlaces.append(enlaceHoja("🔗 Último registro", e.link_registro, { onclick: sinBurbuja }));
    }
    if (e.link_obligacion && e.link_obligacion !== e.link_registro) {
      enlaces.append(enlaceHoja("🔗 Ver obligación", e.link_obligacion, { onclick: sinBurbuja }));
    }

    const estado = estadoCredito(e);
    const etiquetas = etiquetasCredito(e);
    const fila = el("div", { class: "credito-cabecera" },
      el("span", { class: "insignia" + (estado.mora ? " insignia-mora" : ""), text: estado.texto.toUpperCase() }),
      el("div", { class: "credito-titulo" },
        el("strong", { text: nombreLinea + (e.tipo_credito && e.tipo_credito !== nombreLinea ? " · " + e.tipo_credito : "") }),
        descripcion.length ? el("span", { text: descripcion.join("  ·  ") }) : null,
        etiquetas.length ? el("div", { class: "etiquetas-credito" }, ...etiquetas) : null),
      enlaces.childElementCount ? enlaces : null);
    const conDetalle = Boolean(e.campos && e.campos.length);
    const nodo = el("div", {
      class: (comoTarjeta ? "credito credito-tarjeta" : "credito") + (estado.mora ? " credito-mora" : "") + (conDetalle ? " credito-clic" : ""),
      role: conDetalle ? "button" : null, tabindex: conDetalle ? "0" : null,
      title: conDetalle ? "Ver la obligación completa" : null,
      onclick: conDetalle ? (ev) => abrirObligacion(nombreLinea, e, ev.currentTarget) : null,
      onkeydown: conDetalle ? (ev) => { if (ev.key === "Enter") abrirObligacion(nombreLinea, e, ev.currentTarget); } : null,
    }, fila);

    // Resumen de la obligación: lo que se mira primero en la hoja de la línea.
    const datos = [
      ["Observación", e.observacion_estado],
      ["Último pago", e.fecha_ultimo_pago],
      ["Saldo actual", e.saldo_actual ? "$ " + e.saldo_actual : null],
    ].filter(([, v]) => v);
    if (datos.length) {
      nodo.append(el("dl", { class: "credito-datos" },
        ...datos.map(([etiqueta, valor]) => el("div", null, el("dt", { text: etiqueta }), el("dd", { text: valor })))));
    }

    if (e.tarifa || e.saldo || e.meses_mora || e.observacion_directivos || e.observacion_general) {
      const extra = el("div", { class: "extra" });
      const cifras = el("div", { class: "fila-flex" });
      if (e.tarifa) cifras.append(el("span", { text: `💵 ${etiquetaColumna(e.columna_tarifa, "Tarifa")}: ${e.tarifa}` }));
      if (e.saldo) cifras.append(el("span", { text: `💰 ${etiquetaColumna(e.columna_saldo, "Saldo")}: ${e.saldo}` }));
      if (e.meses_mora) cifras.append(el("span", { class: e.en_mora ? "mora-si" : "mora-no", text: "📅 Meses en mora: " + e.meses_mora }));
      extra.append(cifras);
      // La hoja la titula «OBSERVACION DIRECTIVOS (NO REPORTAR)»: es de uso interno.
      if (e.observacion_directivos) extra.append(el("em", { text: "📝 Directivos (no reportar): " + e.observacion_directivos }));
      if (e.observacion_general) extra.append(el("em", { text: "📝 General: " + e.observacion_general }));
      nodo.append(extra);
    }
    if (conDetalle) nodo.append(el("span", { class: "credito-ver", text: "Ver obligación completa ›" }));
    return nodo;
  }

  // ------------------------------------------------------------------ preferencias
  // Lo que se deja marcado (tablero, tabla, densidad) se recuerda en este navegador.
  function preferencia(clave) {
    try { return sessionStorage.getItem(clave) === "1"; } catch (_) { return false; }
  }
  function recordarPreferencia(clave, si) {
    try { si ? sessionStorage.setItem(clave, "1") : sessionStorage.removeItem(clave); } catch (_) { /* sin almacenamiento */ }
  }

  const unDecimal = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1 });
  const pesos = (n) => "$ " + formatoMiles.format(Math.round(n || 0));
  // Como se dice aquí: 2.939.700.000 -> "$ 2,9 mil M"; 489.600.000 -> "$ 489,6 M".
  const pesosCortos = (n) => {
    const a = Math.abs(n || 0);
    if (a >= 1e9) return `$ ${unDecimal.format(n / 1e9)} mil M`;
    if (a >= 1e6) return `$ ${unDecimal.format(n / 1e6)} M`;
    return pesos(n);
  };
  const porcentaje = (parte, total) => (total ? `${Math.round((parte / total) * 100)} %` : "0 %");
  const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const nombreMes = (yyyymm, largo) => {
    const [a, m] = yyyymm.split("-").map(Number);
    return largo ? `${MESES_LARGOS[m - 1]} de ${a}` : MESES_CORTOS[m - 1];
  };
  // Un tope "redondo" para el eje: 7 -> 10, 2.340 -> 2.500.
  function topeRedondo(n) {
    if (n <= 0) return 1;
    const base = Math.pow(10, Math.floor(Math.log10(n)));
    for (const m of [1, 2, 2.5, 5, 10]) if (n <= m * base) return m * base;
    return 10 * base;
  }

  // ------------------------------------------------------------------ globo de información
  // Un solo globo para todos los gráficos: lo que diga data-tip (una línea por renglón) del
  // elemento bajo el mouse o con el foco. Los gráficos no se leen solo por color: cada marca
  // trae aquí su nombre y su cifra.
  const globo = el("div", { class: "globo-grafico", role: "tooltip", hidden: true });
  document.body.append(globo);
  function mostrarGlobo(objetivo, x, y) {
    const lineas = objetivo.dataset.tip.split("\n");
    globo.replaceChildren(el("strong", { text: lineas[0] }), ...lineas.slice(1).map((l) => el("span", { text: l })));
    globo.hidden = false;
    const r = globo.getBoundingClientRect();
    const izq = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14));
    const arriba = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
    globo.style.left = izq + "px";
    globo.style.top = arriba + "px";
  }
  document.addEventListener("pointermove", (ev) => {
    const objetivo = ev.target.closest && ev.target.closest("[data-tip]");
    if (objetivo) mostrarGlobo(objetivo, ev.clientX, ev.clientY);
    else if (!globo.hidden) globo.hidden = true;
  }, { passive: true });
  document.addEventListener("focusin", (ev) => {
    const objetivo = ev.target.closest && ev.target.closest("[data-tip]");
    if (!objetivo) { globo.hidden = true; return; }
    const r = objetivo.getBoundingClientRect();
    mostrarGlobo(objetivo, r.left + r.width / 2, r.top);
  });
  document.addEventListener("scroll", () => { globo.hidden = true; }, { passive: true, capture: true });

  // ------------------------------------------------------------------ tablero de cartera
  // Cómo va Cartera de un vistazo: pagos por estado, por mes y por distrito, y los créditos
  // de cada línea al día o en mora. Opcional, como la tabla: aparece con la casilla
  // «Tablero». Tocar un estado, un mes o un distrito abre la tabla de pagos ya filtrada.
  const CLAVE_VER_TABLERO = "axio.verTablero";
  // El orden en que se apilan: con él los vecinos se distinguen también con daltonismo.
  const ORDEN_ESTADOS = ["pendiente_recaudo", "sin", "gestion_cartera", "referencia_erronea", "ingresado"];
  const NOMBRES_ESTADO = { ...ESTADOS, sin: "Sin gestionar" };
  const colorEstado = (e) => `var(--g-${{ pendiente_recaudo: "pendiente", gestion_cartera: "cartera", referencia_erronea: "referencia", ingresado: "ingresado" }[e] || "sin"})`;
  const ventanaTablero = el("section", { class: "tablero", "aria-labelledby": "tb-titulo", hidden: true });
  $(".panel-busqueda").after(ventanaTablero);
  let firmaTablero = "";

  function marcarCasillaTablero() {
    const casilla = $("#ver-tablero");
    if (casilla) casilla.checked = !ventanaTablero.hidden;
  }

  function cabeceraTablero(hora) {
    return el("div", { class: "tb-barra" },
      el("div", { class: "tc-titulos" },
        el("h2", { id: "tb-titulo", text: "Tablero de cartera" }),
        el("span", { class: "tc-conteo", text: hora ? "Datos de " + haceCuanto(hora) : "" })),
      el("button", { class: "boton boton-texto boton-cerrar", type: "button", "aria-label": "Ocultar el tablero", title: "Ocultar el tablero", text: "✕", onclick: cerrarTablero }));
  }

  async function abrirTablero() {
    if (!ventanaTablero.hidden) return;
    recordarPreferencia(CLAVE_VER_TABLERO, true);
    ventanaTablero.hidden = false;
    marcarCasillaTablero();
    ventanaTablero.replaceChildren(cabeceraTablero(null),
      el("div", { class: "tb-cifras" }, ...[0, 1, 2, 3].map(() => el("div", { class: "tb-cifra esqueleto-bloque" }))),
      el("div", { class: "tb-rejilla" }, el("div", { class: "tb-tarjeta esqueleto-bloque esqueleto-alto" }), el("div", { class: "tb-tarjeta esqueleto-bloque esqueleto-alto" })));
    await cargarTablero();
  }

  async function cargarTablero() {
    try {
      const { datos } = await apiJson("/api/tablero");
      if (ventanaTablero.hidden) return;
      firmaTablero = `${datos.hora}|${datos.hora_lineas}|${datos.parcial}`;
      pintarTablero(datos);
    } catch (e) {
      if (!ventanaTablero.hidden) ventanaTablero.replaceChildren(cabeceraTablero(null), el("p", { class: "aviso aviso-error tc-nota", text: "❌ " + e.message }));
    }
  }

  // Al terminar de cargar las líneas (o tras «Refrescar»), el tablero se pone al día solo.
  function refrescarTableroSiCambio(est) {
    const firma = `${est.matriz.hora}|${est.lineas.hora}|${est.parcial}`;
    if (firmaTablero && firma !== firmaTablero && !est.cargando) { firmaTablero = firma; cargarTablero(); }
  }

  function cerrarTablero() {
    if (ventanaTablero.hidden) return;
    ventanaTablero.hidden = true;
    ventanaTablero.replaceChildren();
    firmaTablero = "";
    recordarPreferencia(CLAVE_VER_TABLERO, false);
    marcarCasillaTablero();
  }

  // accion: la cifra es un botón que abre lo que cuenta (la tabla de pagos ya filtrada).
  function cifra(etiqueta, valor, detalle, clase, accion, titulo) {
    return el(accion ? "button" : "div", { class: "tb-cifra" + (clase ? " " + clase : "") + (accion ? " tb-cifra-boton" : ""),
      type: accion ? "button" : null, title: titulo, onclick: accion },
      el("span", { class: "tb-cifra-etiqueta", text: etiqueta }),
      el("strong", { class: "tb-cifra-valor", text: valor }),
      detalle ? el("span", { class: "tb-cifra-detalle", text: detalle }) : null);
  }

  // '2026-10-13' -> 'de hoy', 'de ayer' o 'del 18 sep'.
  function diaRelativo(iso) {
    const f = aFecha(iso);
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const dias = Math.round((hoy - f) / 86400000);
    return dias === 0 ? "de hoy" : dias === 1 ? "de ayer" : `del ${f.getDate()} ${MESES_CORTOS[f.getMonth()]}`;
  }

  function tarjetaTablero(titulo, nota, ...contenido) {
    return el("article", { class: "tb-tarjeta" },
      el("header", { class: "tb-tarjeta-cabecera" }, el("h3", { text: titulo }), nota ? el("span", { text: nota }) : null),
      ...contenido);
  }

  function leyenda(claves, nombres) {
    return el("ul", { class: "tb-leyenda" },
      ...claves.map((k) => el("li", null, el("span", { class: "tb-muestra", style: `background:${colorEstado(k)}` }), nombres[k])));
  }

  function pintarTablero(d) {
    const x = d.extractos;
    const L = d.lineas || { lineas: [], mora_por_distrito: [] };
    const porEstado = Object.fromEntries(x.estados.map((e) => [e.e || "sin", e]));
    const pendientes = x.estados.filter((e) => e.e !== "ingresado");
    const nPendientes = pendientes.reduce((s, e) => s + e.n, 0);
    const sumaPendientes = pendientes.reduce((s, e) => s + e.suma, 0);
    const creditos = L.lineas.reduce((s, l) => s + l.n, 0);
    const enMora = L.lineas.reduce((s, l) => s + l.mora, 0);

    const u = x.ultimo_dia;
    const conFecha = x.col_fecha !== null && x.col_fecha !== undefined;
    const cifras = el("div", { class: "tb-cifras" },
      cifra("Pagos en Extractos", formatoMiles.format(x.total), pesosCortos(x.suma) + " en total"),
      // El último día con pagos: tocarlo abre esos pagos en la tabla.
      u && conFecha ? cifra(`Pagos ${diaRelativo(u.fecha)}`, formatoMiles.format(u.n), pesosCortos(u.suma), null,
        () => verPagosFiltrados({ [x.col_fecha]: { rango: { desde: u.fecha, hasta: u.fecha } } }), "Ver esos pagos en la tabla") : null,
      cifra("Por gestionar", formatoMiles.format(nPendientes), `${porcentaje(nPendientes, x.total)} de los pagos · ${pesosCortos(sumaPendientes)}`, null,
        () => verPagosFiltrados({ estado: { excluir: ["ingresado"] } }), "Ver los pagos que faltan por gestionar"),
      L.lineas.length ? cifra("Créditos activos", formatoMiles.format(creditos), `en ${L.lineas.length} línea${L.lineas.length === 1 ? "" : "s"} de crédito`) : null,
      L.lineas.length ? cifra("Créditos en mora", formatoMiles.format(enMora), `${porcentaje(enMora, creditos)} de los activos`, enMora ? "tb-cifra-alerta" : null) : null);

    // Pagos por estado: una fila por estado con su barra; tocarla abre esos pagos en la tabla.
    const ordenLista = ["pendiente_recaudo", "gestion_cartera", "referencia_erronea", "sin", "ingresado"];
    const maxEstado = Math.max(1, ...x.estados.map((e) => e.n));
    const estados = tarjetaTablero("Pagos por estado", "Toca uno para verlos en la tabla",
      el("div", { class: "tb-lista" }, ...ordenLista.map((k) => {
        const e = porEstado[k] || { n: 0, suma: 0 };
        return el("button", { type: "button", class: "tb-fila", disabled: !e.n,
          "data-tip": `${NOMBRES_ESTADO[k]}\n${formatoMiles.format(e.n)} pagos (${porcentaje(e.n, x.total)})\n${pesos(e.suma)}`,
          onclick: () => verPagosFiltrados({ estado: { valores: [k === "sin" ? "" : k] } }) },
          el("span", { class: "tb-fila-nombre" }, el("span", { class: "tb-muestra", style: `background:${colorEstado(k)}` }), NOMBRES_ESTADO[k]),
          el("span", { class: "tb-fila-n", text: formatoMiles.format(e.n) }),
          el("span", { class: "tb-fila-suma", text: pesosCortos(e.suma) }),
          el("span", { class: "tb-pista" }, el("span", { class: "tb-barra-h", style: `width:${(e.n / maxEstado) * 100}%;background:${colorEstado(k)}` })));
      })));

    // Pagos por mes: columnas apiladas por estado, con eje de cantidades.
    const meses = x.meses || [];
    const maxMes = topeRedondo(Math.max(1, ...meses.map((m) => Object.values(m.n).reduce((s, v) => s + v, 0))));
    const graficoMeses = meses.length ? el("div", { class: "tb-columnas-marco" },
      el("div", { class: "tb-eje", "aria-hidden": "true" },
        ...[1, 0.5, 0].map((f) => el("span", { style: `bottom:${f * 100}%` }, el("em", { text: formatoMiles.format(maxMes * f) })))),
      el("div", { class: "tb-columnas", role: "list" }, ...meses.map((m, i) => {
        const total = Object.values(m.n).reduce((s, v) => s + v, 0);
        const ultimoDia = new Date(Number(m.mes.slice(0, 4)), Number(m.mes.slice(5, 7)), 0).getDate();
        const tip = [nombreMes(m.mes, true), `${formatoMiles.format(total)} pagos · ${pesos(m.suma)}`,
          ...ORDEN_ESTADOS.slice().reverse().filter((k) => m.n[k]).map((k) => `${NOMBRES_ESTADO[k]}: ${formatoMiles.format(m.n[k])}`)].join("\n");
        const anioCambia = i === 0 || meses[i - 1].mes.slice(0, 4) !== m.mes.slice(0, 4);
        return el("button", { type: "button", class: "tb-columna", role: "listitem", "data-tip": tip,
          "aria-label": tip.replace(/\n/g, ". "), style: `--i:${i}`,
          onclick: () => x.col_fecha !== null && x.col_fecha !== undefined && verPagosFiltrados({ [x.col_fecha]: { rango: { desde: `${m.mes}-01`, hasta: `${m.mes}-${ultimoDia}` } } }) },
          el("span", { class: "tb-pila", style: `height:${(total / maxMes) * 100}%` },
            ...ORDEN_ESTADOS.filter((k) => m.n[k]).map((k) => el("span", { style: `flex:${m.n[k]};background:${colorEstado(k)}` }))),
          el("span", { class: "tb-mes" + (meses.length > 6 && (meses.length - 1 - i) % 3 ? " tb-mes-menor" : ""), text: nombreMes(m.mes) + (anioCambia ? " " + m.mes.slice(2, 4) : "") }));
      }))) : el("p", { class: "gris", text: "Los Extractos no traen una columna de fecha que se pueda leer." });
    const porMes = tarjetaTablero("Pagos por mes", meses.length ? `Últimos ${meses.length} meses · toca uno para verlo` : null,
      leyenda(ORDEN_ESTADOS.slice().reverse(), NOMBRES_ESTADO), graficoMeses);

    // Distritos con más pagos por gestionar.
    const maxDistrito = Math.max(1, ...(x.distritos || []).map((r) => r.pendientes));
    const distritos = tarjetaTablero("Distritos con más pagos por gestionar", "Toca uno para verlos",
      (x.distritos || []).length ? el("div", { class: "tb-lista" }, ...x.distritos.map((r) => el("button", {
        type: "button", class: "tb-fila tb-fila-barra",
        "data-tip": `Distrito ${r.distrito}\n${formatoMiles.format(r.pendientes)} por gestionar de ${formatoMiles.format(r.n)} pagos\n${pesos(r.suma)} en total`,
        onclick: () => verPagosFiltrados({ [x.col_distrito]: { valores: [r.distrito] }, estado: { excluir: ["ingresado"] } }) },
        el("span", { class: "tb-fila-nombre", text: "Distrito " + r.distrito }),
        el("span", { class: "tb-pista" }, el("span", { class: "tb-barra-h", style: `width:${(r.pendientes / maxDistrito) * 100}%;background:var(--g-acento)` })),
        el("span", { class: "tb-fila-n", text: `${formatoMiles.format(r.pendientes)} de ${formatoMiles.format(r.n)}` }))))
        : el("p", { class: "gris", text: "Los Extractos no traen columna de distrito." }));

    const tarjetas = [estados, porMes, distritos];

    // Líneas de crédito: al día / en mora / sin dato, y el saldo que suman.
    if (L.lineas.length) {
      const nombresCredito = { pendiente_recaudo: "En mora", ingresado: "Al día", sin: "Sin dato de mora" };
      tarjetas.push(tarjetaTablero("Líneas de crédito", d.parcial ? "⏳ Todavía se están cargando" : "Créditos activos",
        leyenda(["pendiente_recaudo", "ingresado", "sin"], nombresCredito),
        el("div", { class: "tb-lista" }, ...L.lineas.map((l) => {
          const sinDato = l.n - l.mora - l.dia;
          return el("div", { class: "tb-linea", tabindex: "0",
            "data-tip": `${l.linea}\n${formatoMiles.format(l.n)} créditos activos\nEn mora: ${formatoMiles.format(l.mora)} · Al día: ${formatoMiles.format(l.dia)}${sinDato ? ` · Sin dato: ${formatoMiles.format(sinDato)}` : ""}\nSaldo: ${pesos(l.saldo)}` },
            el("div", { class: "tb-linea-cabecera" },
              el("strong", { text: l.linea }),
              el("span", { text: `${formatoMiles.format(l.n)} activos${l.saldo ? " · " + pesosCortos(l.saldo) : ""}` })),
            el("div", { class: "tb-apilada", "aria-hidden": "true" },
              l.mora ? el("span", { style: `flex:${l.mora};background:var(--g-pendiente)` }) : null,
              l.dia ? el("span", { style: `flex:${l.dia};background:var(--g-ingresado)` }) : null,
              sinDato ? el("span", { style: `flex:${sinDato};background:var(--g-sin)` }) : null),
            el("span", { class: "tb-linea-pie", text: `${formatoMiles.format(l.mora)} en mora (${porcentaje(l.mora, l.n)}) · ${formatoMiles.format(l.dia)} al día` }));
        }))));
      if (L.mora_por_distrito.length) {
        const maxMora = Math.max(1, ...L.mora_por_distrito.map((r) => r.n));
        tarjetas.push(tarjetaTablero("Distritos con más créditos en mora", "Sumando todas las líneas",
          el("div", { class: "tb-lista" }, ...L.mora_por_distrito.map((r) => el("div", { class: "tb-fila tb-fila-barra", tabindex: "0",
            "data-tip": `Distrito ${r.distrito}\n${formatoMiles.format(r.n)} créditos en mora` },
            el("span", { class: "tb-fila-nombre", text: "Distrito " + r.distrito }),
            el("span", { class: "tb-pista" }, el("span", { class: "tb-barra-h", style: `width:${(r.n / maxMora) * 100}%;background:var(--g-pendiente)` })),
            el("span", { class: "tb-fila-n", text: formatoMiles.format(r.n) }))))));
      }
    }

    ventanaTablero.replaceChildren(cabeceraTablero(d.hora), cifras, el("div", { class: "tb-rejilla" }, ...tarjetas));
    // Las cifras cuentan desde cero y los gráficos crecen al llegar a la pantalla.
    animarAlVer(cifras, () => {
      for (const v of cifras.querySelectorAll(".tb-cifra-valor")) {
        const n = Number(v.textContent.replace(/\D/g, ""));
        if (/^[\d.]+$/.test(v.textContent)) contarEntero(v, n);
      }
    });
    tarjetas.forEach((t) => animarAlVer(t));
  }

  // Abre la tabla de pagos con esos filtros (desde el tablero) y la trae a la vista.
  async function verPagosFiltrados(filtros) {
    if (ventanaTabla.hidden) await abrirTabla({ filtros });
    else { tc.filtros = filtros; tc.orden = null; await recargarTabla(); }
    ventanaTabla.scrollIntoView({ behavior: sinMovimiento() ? "auto" : "smooth", block: "start" });
  }

  // ------------------------------------------------------------------ tabla completa
  // Los Extractos enteros, tal cual la hoja, con un filtro en cada encabezado como en Google
  // Sheets o Excel: valores con casillas, buscar entre ellos y ordenar. Filtrar y ordenar lo
  // hace el servidor (/api/tabla); la página pide las filas por tramos a medida que se
  // desplaza y solo dibuja las que se ven, así que miles de pagos se recorren sin trabarse.
  // Es opcional: aparece debajo del buscador solo si se marca «Ver todos los pagos», y la
  // página recuerda (en este equipo) si se dejó marcada.
  const TRAMO_TABLA = 200;
  const SIN_ESTADO = "Sin gestionar";
  const CLAVE_VER_TABLA = "axio.verTabla";
  const CLAVE_COMPACTA = "axio.tablaCompacta";
  const CLAVE_VISTAS = "axio.vistasTabla";
  const ventanaTabla = el("section", { class: "tabla-completa", "aria-labelledby": "tc-titulo", hidden: true });
  ventanaTablero.after(ventanaTabla);
  const tc = {
    columnas: [], tipos: [], anchos: [], filtros: {}, orden: null, total: 0, filtradas: 0, hora: null,
    tramos: new Map(), pidiendo: new Set(), version: 0, altoFila: 34, pintada: "", menu: null,
  };

  const nombreColumna = (col) => (col === "estado" ? "Estado" : tc.columnas[col]);
  const textoValor = (col, v) => (col === "estado" ? (v ? ESTADOS[v] || v : SIN_ESTADO) : v === "" ? "(Vacías)" : v);

  function urlTabla(base, extra) {
    const p = new URLSearchParams(extra || {});
    if (Object.keys(tc.filtros).length) p.set("f", JSON.stringify(tc.filtros));
    if (tc.orden) p.set("orden", `${tc.orden.col}:${tc.orden.asc ? "asc" : "desc"}`);
    const q = p.toString();
    return q ? `${base}?${q}` : base;
  }

  function tablaPreferida() {
    try { return sessionStorage.getItem(CLAVE_VER_TABLA) === "1"; } catch (_) { return false; }
  }
  function recordarTabla(si) {
    try { si ? sessionStorage.setItem(CLAVE_VER_TABLA, "1") : sessionStorage.removeItem(CLAVE_VER_TABLA); } catch (_) { /* sin almacenamiento */ }
  }
  function marcarCasillaTabla() {
    const casilla = $("#ver-tabla");
    if (casilla) casilla.checked = !ventanaTabla.hidden;
  }

  function cerrarTabla() {
    if (ventanaTabla.hidden) return;
    cerrarMenuFiltro();
    tc.version++;
    tc.tramos.clear();
    ventanaTabla.hidden = true;
    ventanaTabla.replaceChildren();
    recordarTabla(false);
    marcarCasillaTabla();
  }

  // inicial: {filtros, orden} con que abre (desde el tablero o una vista guardada).
  async function abrirTabla(inicial) {
    if (!ventanaTabla.hidden) return;
    recordarTabla(true);
    tc.filtros = (inicial && inicial.filtros) || {};
    tc.orden = (inicial && inicial.orden) || null;
    tc.columnas = [];
    const compacta = preferencia(CLAVE_COMPACTA);
    ventanaTabla.classList.toggle("tc-compacta", compacta);
    ventanaTabla.replaceChildren(
      el("div", { class: "tc-barra" },
        el("div", { class: "tc-titulos" },
          el("h2", { id: "tc-titulo", text: "Extractos · todos los pagos" }),
          el("span", { class: "tc-conteo", "aria-live": "polite" })),
        el("button", { class: "boton boton-chico tc-quitar", type: "button", text: "Quitar filtros", hidden: true, onclick: quitarFiltros }),
        el("button", { class: "boton boton-chico tc-vistas", type: "button", text: "★ Vistas", "aria-haspopup": "true",
          title: "Guarda los filtros que usas seguido y vuelve a ellos con un clic", onclick: (ev) => { ev.stopPropagation(); abrirMenuVistas(ev.currentTarget); } }),
        el("button", { class: "boton boton-chico tc-densidad", type: "button", "aria-pressed": String(compacta),
          text: compacta ? "☰ Compacta" : "☰ Cómoda", title: "Cambia el alto de las filas: compacta muestra más pagos a la vez", onclick: cambiarDensidad }),
        el("button", { class: "boton boton-chico boton-exportar tc-exportar", type: "button", text: "Exportar a Excel",
          title: "Descarga lo que se ve: todas las filas filtradas, en este orden", onclick: exportarTabla }),
        el("button", { class: "boton boton-texto boton-cerrar", type: "button", "aria-label": "Ocultar la tabla", title: "Ocultar la tabla", text: "✕", onclick: cerrarTabla })),
      el("div", { class: "tc-chips", hidden: true }),
      el("div", { class: "tc-cuerpo", tabindex: "0" }, el("p", { class: "tc-nota", text: "Cargando los Extractos…" })));
    ventanaTabla.querySelector(".tc-cuerpo").addEventListener("scroll", programarPintado, { passive: true });
    ventanaTabla.hidden = false;
    marcarCasillaTabla();
    await recargarTabla(true);
  }

  // Escape cierra el menú del filtro abierto; un clic fuera de él, también.
  ventanaTabla.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && tc.menu) { ev.preventDefault(); cerrarMenuFiltro(); } });
  document.addEventListener("pointerdown", (ev) => {
    if (tc.menu && !tc.menu.contains(ev.target) && !(ev.target instanceof Element && ev.target.closest(".tc-th, .tc-vistas"))) cerrarMenuFiltro();
  });
  window.addEventListener("resize", () => { if (!ventanaTabla.hidden) { cerrarMenuFiltro(); programarPintado(); } });

  // Con filtros u orden nuevos: se vuelve a pedir desde la primera fila.
  async function recargarTabla(primeraVez) {
    const version = ++tc.version;
    tc.tramos.clear();
    tc.pidiendo.clear();
    tc.pintada = "";
    const cuerpo = ventanaTabla.querySelector(".tc-cuerpo");
    try {
      const { datos } = await apiJson(urlTabla("/api/tabla", { desde: 0, cuantas: TRAMO_TABLA }));
      if (version !== tc.version) return;
      if (primeraVez) {
        tc.columnas = datos.columnas;
        tc.tipos = datos.tipos || [];
        tc.anchos = calcularAnchos(datos);
      }
      tc.total = datos.total;
      tc.filtradas = datos.filtradas;
      tc.hora = datos.hora;
      tc.tramos.set(0, datos.filas);
      if (primeraVez || !cuerpo.querySelector("table")) armarTabla();
      cuerpo.scrollTop = 0;
      pintarBarraTabla();
      pintarFilasTabla();
    } catch (e) {
      if (version !== tc.version) return;
      cuerpo.replaceChildren(el("p", { class: "aviso aviso-error tc-nota", text: "❌ " + e.message }));
    }
  }

  // Ancho de cada columna según su encabezado y las primeras filas, entre un mínimo y un
  // máximo; el texto más largo se ve completo al pasar el mouse. Se fija una vez, para que
  // las columnas no salten al filtrar o desplazarse.
  function calcularAnchos(datos) {
    return datos.columnas.map((nombre, j) => {
      let largo = Math.max(6, String(nombre).length * 0.92 + 3);
      for (const f of datos.filas.slice(0, 120)) largo = Math.max(largo, String(f.v[j] || "").length);
      return Math.round(Math.min(340, Math.max(76, largo * 7.4 + 30)));
    });
  }

  function armarTabla() {
    const cols = el("colgroup", null, el("col", { style: "width:46px" }), ...tc.anchos.map((a) => el("col", { style: `width:${a}px` })));
    const fila = el("tr", null, cabeceraFiltro("estado", ""));
    tc.columnas.forEach((nombre, j) => fila.append(cabeceraFiltro(j, nombre)));
    const ancho = tc.anchos.reduce((s, a) => s + a, 46);
    const tabla = el("table", { class: "tc-tabla", style: `width:${ancho}px` }, cols, el("thead", null, fila), el("tbody"));
    tabla.addEventListener("click", (ev) => {
      const tr = ev.target.closest("tbody tr[data-p]");
      if (tr) abrirDetalleDe(`/api/tabla/detalle/${tr.dataset.p}`, tr);
    });
    tabla.addEventListener("keydown", (ev) => {
      const tr = ev.target.closest("tbody tr[data-p]");
      if (tr && ev.key === "Enter") abrirDetalleDe(`/api/tabla/detalle/${tr.dataset.p}`, tr);
    });
    ventanaTabla.querySelector(".tc-cuerpo").replaceChildren(tabla, el("p", { class: "tc-vacio", hidden: true }));
  }

  function cabeceraFiltro(col, nombre) {
    return el("th", { class: "tc-th", scope: "col", "data-col": String(col), title: col === "estado" ? "Filtrar por estado (color de la fila)" : `Filtrar u ordenar «${nombre}»`,
      onclick: (ev) => { ev.stopPropagation(); abrirMenuFiltro(col, ev.currentTarget); } },
      el("span", { class: "tc-th-nombre", text: col === "estado" ? "" : nombre }),
      el("span", { class: "tc-th-filtro", "aria-hidden": "true" }));
  }

  // Encabezados con filtro u orden marcados, conteo, chips de filtros y «Quitar filtros».
  function pintarBarraTabla() {
    const hay = Object.keys(tc.filtros).length;
    ventanaTabla.querySelector(".tc-conteo").textContent = hay
      ? `${formatoMiles.format(tc.filtradas)} de ${formatoMiles.format(tc.total)} pagos`
      : `${formatoMiles.format(tc.total)} pagos${tc.hora ? " · " + haceCuanto(tc.hora) : ""}`;
    ventanaTabla.querySelector(".tc-quitar").hidden = !hay;
    ventanaTabla.querySelectorAll(".tc-th").forEach((th) => {
      const col = th.dataset.col === "estado" ? "estado" : Number(th.dataset.col);
      th.classList.toggle("tc-filtrada", col in tc.filtros);
      const ordenada = tc.orden && tc.orden.col === col;
      if (ordenada) th.setAttribute("aria-sort", tc.orden.asc ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
    const chips = ventanaTabla.querySelector(".tc-chips");
    chips.replaceChildren(...Object.entries(tc.filtros).map(([clave, f]) => {
      const col = clave === "estado" ? "estado" : Number(clave);
      const lista = f.valores || f.excluir || [];
      const que = f.rango ? textoRango(col, f.rango)
        : f.texto !== undefined ? `contiene «${f.texto}»`
        : f.valores ? (lista.length === 1 ? textoValor(col, lista[0]) : `${lista.length} valores`)
        : `sin ${lista.length === 1 ? "«" + textoValor(col, lista[0]) + "»" : lista.length + " valores"}`;
      return el("span", { class: "tc-chip" },
        el("button", { type: "button", class: "tc-chip-texto", title: "Cambiar este filtro", onclick: () => {
          const th = ventanaTabla.querySelector(`.tc-th[data-col="${clave}"]`);
          if (th) { th.scrollIntoView({ block: "nearest", inline: "nearest" }); abrirMenuFiltro(col, th); }
        } }, el("strong", { text: nombreColumna(col) + ": " }), que),
        el("button", { type: "button", class: "tc-chip-quitar", "aria-label": "Quitar el filtro de " + nombreColumna(col), text: "✕",
          onclick: () => { delete tc.filtros[clave]; recargarTabla(); } }));
    }));
    chips.hidden = !hay;
    const vacio = ventanaTabla.querySelector(".tc-vacio");
    if (vacio) {
      vacio.hidden = tc.filtradas > 0;
      vacio.replaceChildren("Ningún pago coincide con estos filtros. ",
        el("button", { type: "button", class: "boton boton-chico", text: "Quitar filtros", onclick: quitarFiltros }));
    }
  }

  function quitarFiltros() {
    tc.filtros = {};
    recargarTabla();
  }

  // '2026-07-01' -> '01/07/2026'; '500000' -> '$ 500.000' (en las columnas de plata).
  function textoRango(col, r) {
    const ver = (v) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (m) return `${m[3]}/${m[2]}/${m[1]}`;
      const n = Number(String(v).replace(/[^\d-]/g, ""));
      return tc.tipos[col] === "numero" && String(v).trim() && isFinite(n) ? pesos(n) : v;
    };
    if (r.desde && r.hasta) return `de ${ver(r.desde)} a ${ver(r.hasta)}`;
    return r.desde ? `desde ${ver(r.desde)}` : `hasta ${ver(r.hasta)}`;
  }

  // ---- densidad: cómoda (34 px por fila) o compacta (26 px), recordada en este navegador
  function cambiarDensidad(ev) {
    const compacta = !ventanaTabla.classList.contains("tc-compacta");
    ventanaTabla.classList.toggle("tc-compacta", compacta);
    recordarPreferencia(CLAVE_COMPACTA, compacta);
    ev.currentTarget.textContent = compacta ? "☰ Compacta" : "☰ Cómoda";
    ev.currentTarget.setAttribute("aria-pressed", String(compacta));
    tc.pintada = "";
    programarPintado();
  }

  // ---- vistas guardadas: filtros y orden con un nombre, en este navegador (solo los
  // filtros, nunca datos de los pagos)
  function leerVistas() {
    try { const v = JSON.parse(sessionStorage.getItem(CLAVE_VISTAS)); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  function guardarVistas(lista) {
    try { sessionStorage.setItem(CLAVE_VISTAS, JSON.stringify(lista)); return true; } catch (_) { return false; }
  }

  function abrirMenuVistas(boton) {
    const yaAbierto = tc.menu && tc.menu.dataset.col === "vistas";
    cerrarMenuFiltro();
    if (yaAbierto) return;
    const vistas = leerVistas();
    const hayAlgo = Object.keys(tc.filtros).length || tc.orden;
    const nombre = el("input", { type: "text", class: "tc-busca", maxlength: "60", placeholder: "Nombre, p. ej. «Sin gestionar de julio»", "aria-label": "Nombre de la vista" });
    const guardar = el("button", { type: "button", class: "boton boton-principal boton-chico", text: "Guardar", disabled: !hayAlgo, onclick: () => {
      const n = nombre.value.trim() || `Vista ${vistas.length + 1}`;
      const lista = [{ nombre: n, filtros: tc.filtros, orden: tc.orden }, ...leerVistas().filter((v) => v.nombre !== n)].slice(0, 20);
      toast(guardarVistas(lista) ? `★ Vista «${n}» guardada.` : "Este navegador no deja guardar vistas.");
      cerrarMenuFiltro();
    } });
    nombre.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !guardar.disabled) { ev.preventDefault(); guardar.click(); } });
    const lista = el("div", { class: "tc-valores tc-vistas-lista" }, ...vistas.map((v) => el("div", { class: "tc-vista" },
      el("button", { type: "button", class: "tc-vista-abrir", title: "Aplicar esta vista", onclick: () => {
        tc.filtros = v.filtros || {}; tc.orden = v.orden || null; cerrarMenuFiltro(); recargarTabla();
      } }, el("strong", { text: v.nombre }), el("span", { text: `${Object.keys(v.filtros || {}).length} filtro${Object.keys(v.filtros || {}).length === 1 ? "" : "s"}${v.orden ? " · con orden" : ""}` })),
      el("button", { type: "button", class: "tc-chip-quitar", "aria-label": "Borrar la vista " + v.nombre, title: "Borrar", text: "✕", onclick: () => {
        guardarVistas(leerVistas().filter((x) => x.nombre !== v.nombre)); cerrarMenuFiltro(); abrirMenuVistas(boton);
      } }))));
    const menu = el("div", { class: "tc-menu tc-menu-vistas", "data-col": "vistas", role: "dialog", "aria-label": "Vistas guardadas" },
      el("strong", { class: "tc-menu-titulo", text: "Vistas guardadas" }),
      vistas.length ? lista : el("p", { class: "tc-menu-nota gris", text: "Todavía no hay vistas. Pon los filtros que usas seguido y guárdalos aquí para volver a ellos con un clic." }),
      el("div", { class: "tc-menu-pie tc-vistas-guardar" }, nombre, guardar),
      hayAlgo ? null : el("p", { class: "tc-menu-nota gris", text: "Para guardar, primero filtra u ordena la tabla." }));
    tc.menu = menu;
    ventanaTabla.append(menu);
    ubicarMenu(menu, boton);
    const foco = hayAlgo ? nombre : menu.querySelector(".tc-vista-abrir");
    if (foco) foco.focus({ preventScroll: true });
  }

  let cuadroTabla = 0;
  function programarPintado() {
    if (!cuadroTabla) cuadroTabla = requestAnimationFrame(() => { cuadroTabla = 0; pintarFilasTabla(); });
  }

  // Solo las filas que se ven (y unas pocas de margen); arriba y abajo, un relleno con el
  // alto de las demás para que la barra de desplazamiento sea la de la tabla entera.
  function pintarFilasTabla() {
    const cuerpo = ventanaTabla.querySelector(".tc-cuerpo");
    const tbody = cuerpo && cuerpo.querySelector(".tc-tabla tbody");
    if (!tbody) return;
    const alto = tc.altoFila;
    const desde = Math.max(0, Math.floor(cuerpo.scrollTop / alto) - 10);
    const hasta = Math.min(tc.filtradas, Math.ceil((cuerpo.scrollTop + cuerpo.clientHeight) / alto) + 10);
    for (let t = Math.floor(desde / TRAMO_TABLA); t <= Math.floor(Math.max(desde, hasta - 1) / TRAMO_TABLA); t++) pedirTramo(t);
    const clave = `${tc.version}:${desde}:${hasta}:${[...tc.tramos.keys()].join(",")}`;
    if (clave === tc.pintada) return;
    tc.pintada = clave;

    const filas = [];
    const columnas = tc.columnas.length + 1;
    for (let k = desde; k < hasta; k++) {
      const tramo = tc.tramos.get(Math.floor(k / TRAMO_TABLA));
      const f = tramo && tramo[k % TRAMO_TABLA];
      if (!f) { filas.push(el("tr", { class: "tc-cargando" }, el("td", { colspan: String(columnas) }))); continue; }
      const tr = el("tr", { class: f.e ? "fila-" + f.e : null, "data-p": String(f.p), tabindex: "0" },
        el("td", { class: "estado" }, f.e ? el("span", { class: "punto e-" + f.e, title: ESTADOS[f.e] || f.e }) : null));
      for (const v of f.v) {
        tr.append(el("td", { class: /^-?[\d,]+(\.\d+)?$/.test(v) ? "num" : null, title: v.length > 24 ? v : null, text: v }));
      }
      filas.push(tr);
    }
    const relleno = (n) => el("tr", { class: "tc-relleno", "aria-hidden": "true" }, el("td", { colspan: String(columnas), style: `height:${n * alto}px` }));
    tbody.replaceChildren(relleno(desde), ...filas, relleno(tc.filtradas - hasta));
    // El alto real de una fila (depende de la fuente del equipo): con él se calcula todo.
    const muestra = tbody.querySelector("tr[data-p]");
    if (muestra) {
      const real = muestra.getBoundingClientRect().height;
      if (real > 10 && Math.abs(real - tc.altoFila) > 0.5) { tc.altoFila = real; tc.pintada = ""; programarPintado(); }
    }
  }

  async function pedirTramo(n) {
    if (tc.tramos.has(n) || tc.pidiendo.has(n) || n * TRAMO_TABLA >= tc.filtradas) return;
    const version = tc.version;
    tc.pidiendo.add(n);
    try {
      const { datos } = await apiJson(urlTabla("/api/tabla", { desde: n * TRAMO_TABLA, cuantas: TRAMO_TABLA }));
      if (version !== tc.version) return;
      tc.tramos.set(n, datos.filas);
      programarPintado();
    } catch (e) {
      if (version === tc.version) toast("No se pudieron traer más filas: " + e.message);
    } finally {
      if (version === tc.version) tc.pidiendo.delete(n);
    }
  }

  // ---- el menú del filtro de un encabezado
  function cerrarMenuFiltro() {
    if (tc.menu) tc.menu.remove();
    tc.menu = null;
    ventanaTabla.querySelectorAll(".tc-th.tc-abierta").forEach((th) => th.classList.remove("tc-abierta"));
  }

  function abrirMenuFiltro(col, th) {
    const yaAbierto = tc.menu && tc.menu.dataset.col === String(col);
    cerrarMenuFiltro();
    if (yaAbierto) return;
    th.classList.add("tc-abierta");
    const actual = tc.filtros[col] || null;
    let lista = [];          // [{v, n}] que se están mostrando
    let recortado = false;
    let marcados = new Set();
    let tocado = false;      // si se marcó o desmarcó algo a mano

    // Columnas de fecha y de plata: además de los valores, un rango «desde / hasta».
    const tipo = col === "estado" ? "texto" : tc.tipos[col] || "texto";
    const conRango = tipo === "fecha" || tipo === "numero";
    const rangoActual = (actual && actual.rango) || {};
    const campoRango = (clave, etiqueta) => {
      const campo = el("input", { type: tipo === "fecha" ? "date" : "text", class: "tc-busca tc-rango-campo", "aria-label": etiqueta,
        inputmode: tipo === "numero" ? "numeric" : null, placeholder: tipo === "numero" ? etiqueta + " $" : null });
      campo.value = rangoActual[clave] || "";
      campo.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); aplicar(); } });
      return campo;
    };
    const desde = conRango ? campoRango("desde", "Desde") : null;
    const hasta = conRango ? campoRango("hasta", "Hasta") : null;
    const bloqueRango = conRango ? el("div", { class: "tc-rango" },
      el("span", { class: "tc-menu-subtitulo", text: tipo === "fecha" ? "Entre fechas" : "Entre valores" }),
      el("div", { class: "tc-rango-campos" }, desde, el("span", { class: "gris", text: "a" }), hasta)) : null;

    const busca = el("input", { type: "search", class: "tc-busca", placeholder: col === "estado" ? "" : "Buscar valores…",
      "aria-label": "Buscar valores", hidden: col === "estado" });
    if (actual && actual.texto !== undefined) busca.value = actual.texto;
    const todos = el("input", { type: "checkbox" });
    const listaNodo = el("div", { class: "tc-valores", role: "group", "aria-label": "Valores" });
    const nota = el("p", { class: "tc-menu-nota", hidden: true });
    const aceptar = el("button", { type: "button", class: "boton boton-principal boton-chico", text: "Aceptar", onclick: aplicar });

    const ordenar = (asc) => { tc.orden = { col, asc }; cerrarMenuFiltro(); recargarTabla(); };
    const esOrden = (asc) => tc.orden && tc.orden.col === col && tc.orden.asc === asc;
    const menu = el("div", { class: "tc-menu", "data-col": String(col), role: "dialog", "aria-label": "Filtro de " + nombreColumna(col) },
      el("strong", { class: "tc-menu-titulo", text: nombreColumna(col) }),
      el("div", { class: "tc-menu-orden" },
        el("button", { type: "button", class: "tc-orden" + (esOrden(true) ? " activa" : ""), text: col === "estado" ? "↑ Rojos primero" : "↑ Ordenar A → Z", onclick: () => ordenar(true) }),
        el("button", { type: "button", class: "tc-orden" + (esOrden(false) ? " activa" : ""), text: col === "estado" ? "↓ Sin gestionar primero" : "↓ Ordenar Z → A", onclick: () => ordenar(false) })),
      bloqueRango,
      busca,
      el("label", { class: "tc-valor tc-todos" }, todos, el("span", { text: "(Seleccionar todo)" })),
      listaNodo, nota,
      el("div", { class: "tc-menu-pie" },
        actual ? el("button", { type: "button", class: "boton boton-texto boton-chico", text: "Borrar filtro",
          onclick: () => { delete tc.filtros[col]; cerrarMenuFiltro(); recargarTabla(); } }) : null,
        el("span", { class: "tc-espacio" }),
        el("button", { type: "button", class: "boton boton-chico", text: "Cancelar", onclick: cerrarMenuFiltro }),
        aceptar));
    tc.menu = menu;
    ventanaTabla.append(menu);
    ubicarMenu(menu, th);

    function pintarLista() {
      listaNodo.replaceChildren(...lista.map((x) => {
        const caja = el("input", { type: "checkbox" });
        caja.checked = marcados.has(x.v);
        caja.addEventListener("change", () => { tocado = true; caja.checked ? marcados.add(x.v) : marcados.delete(x.v); estadoTodos(); });
        return el("label", { class: "tc-valor" + (x.v === "" ? " tc-vacias" : "") }, caja,
          col === "estado" && x.v ? el("span", { class: "punto e-" + x.v }) : null,
          el("span", { class: "tc-valor-texto", text: textoValor(col, x.v), title: x.v.length > 30 ? x.v : null }),
          el("span", { class: "tc-valor-n", text: formatoMiles.format(x.n) }));
      }));
      if (!lista.length) listaNodo.append(el("p", { class: "tc-menu-nota", text: "Ningún valor coincide." }));
      estadoTodos();
    }
    function estadoTodos() {
      const n = lista.filter((x) => marcados.has(x.v)).length;
      todos.checked = lista.length > 0 && n === lista.length;
      todos.indeterminate = n > 0 && n < lista.length;
      aceptar.disabled = n === 0;
    }
    todos.addEventListener("change", () => {
      tocado = true;
      for (const x of lista) todos.checked ? marcados.add(x.v) : marcados.delete(x.v);
      pintarLista();
    });

    let pedido = 0;
    async function cargarValores() {
      const n = ++pedido;
      listaNodo.classList.add("tc-cargando-valores");
      try {
        const extra = { col: String(col) };
        if (busca.value.trim()) extra.q = busca.value.trim();
        const { datos } = await apiJson(urlTabla("/api/tabla/valores", extra));
        if (n !== pedido || tc.menu !== menu) return;
        lista = datos.valores;
        recortado = datos.recortado;
        // Casillas como estaban en el filtro (si no se ha tocado nada en esta lista).
        if (!tocado || busca.value.trim()) {
          marcados = new Set(lista.filter((x) => !actual || actual.texto !== undefined || actual.rango
            || (actual.valores ? actual.valores.includes(x.v) : !actual.excluir.includes(x.v))).map((x) => x.v));
          tocado = false;
        }
        nota.hidden = !recortado;
        nota.textContent = recortado ? `Hay ${formatoMiles.format(datos.distintos)} valores distintos: se muestran ${formatoMiles.format(lista.length)}. Escribe arriba para encontrar el tuyo.` : "";
        pintarLista();
      } catch (e) {
        if (n === pedido) listaNodo.replaceChildren(el("p", { class: "tc-menu-nota error", text: "❌ " + e.message }));
      } finally {
        if (n === pedido) listaNodo.classList.remove("tc-cargando-valores");
      }
    }
    let espera = 0;
    busca.addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(cargarValores, 220); });
    busca.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(espera); aplicar(); } });

    function aplicar() {
      if (conRango && (desde.value.trim() || hasta.value.trim())) {
        const rango = {};
        if (desde.value.trim()) rango.desde = desde.value.trim();
        if (hasta.value.trim()) rango.hasta = hasta.value.trim();
        tc.filtros[col] = { rango };
        cerrarMenuFiltro();
        recargarTabla();
        return;
      }
      const q = busca.value.trim();
      const elegidos = lista.filter((x) => marcados.has(x.v)).map((x) => x.v);
      const quitados = lista.filter((x) => !marcados.has(x.v)).map((x) => x.v);
      let nuevo = null;
      if (q) nuevo = quitados.length ? { valores: elegidos } : { texto: q };
      else if (!quitados.length) nuevo = null;
      else if (!recortado && elegidos.length <= quitados.length) nuevo = { valores: elegidos };
      else nuevo = { excluir: quitados };
      if (nuevo) tc.filtros[col] = nuevo;
      else delete tc.filtros[col];
      cerrarMenuFiltro();
      recargarTabla();
    }

    cargarValores();
    (col === "estado" ? todos : busca).focus({ preventScroll: true });
  }

  function ubicarMenu(menu, th) {
    const caja = ventanaTabla.getBoundingClientRect();
    const r = th.getBoundingClientRect();
    const ancho = Math.min(300, caja.width - 16);
    menu.style.width = ancho + "px";
    menu.style.left = Math.max(8, Math.min(caja.width - ancho - 8, r.left - caja.left)) + "px";
    menu.style.top = (r.bottom - caja.top + 4) + "px";
    menu.style.maxHeight = Math.max(220, caja.height - (r.bottom - caja.top) - 16) + "px";
  }

  async function exportarTabla() {
    const boton = ventanaTabla.querySelector(".tc-exportar");
    boton.disabled = true;
    boton.textContent = "Exportando…";
    try {
      const resp = await api(urlTabla("/api/tabla/exportar"));
      if (!resp.ok) {
        let msg = `Error ${resp.status}`;
        try { msg = (await resp.json()).error || msg; } catch (_) { /* nada */ }
        throw new Error(msg);
      }
      const url = URL.createObjectURL(await resp.blob());
      const a = el("a", { href: url, download: Object.keys(tc.filtros).length ? "Extractos_filtrados.xlsx" : "Extractos.xlsx" });
      ventanaTabla.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      toast("No se pudo exportar: " + e.message);
    } finally {
      boton.disabled = false;
      boton.textContent = "Exportar a Excel";
    }
  }

  // ------------------------------------------------------------------ menú del usuario
  // Un clic en la foto o el nombre abre la cuenta y la lista de hojas: cuáles se
  // conectaron, cuáles no y por qué. Donde el estado trae la URL (la versión de navegador),
  // cada hoja se puede abrir en Google Sheets.
  let ultimoEstado = null;
  const menu = el("div", { class: "menu-usuario", id: "menu-usuario", hidden: true });
  zonaUsuario.parentElement.append(menu);
  zonaUsuario.classList.add("usuario-boton");
  zonaUsuario.setAttribute("role", "button");
  zonaUsuario.setAttribute("tabindex", "0");
  zonaUsuario.setAttribute("aria-haspopup", "true");
  zonaUsuario.setAttribute("aria-controls", "menu-usuario");
  zonaUsuario.setAttribute("aria-expanded", "false");
  zonaUsuario.title = "Tu cuenta y las hojas conectadas";

  const ICONOS_FUENTE = { ok: "✓", error: "✕", pendiente: "…" };
  const TEXTOS_FUENTE = { ok: "Conectada", error: "Sin conexión", pendiente: "Pendiente" };

  // "No se pudo descargar... Detalle: HTTP Error 401: tu cuenta no tiene permiso..." ->
  // "Tu cuenta no tiene permiso...". El texto completo queda en el title.
  function motivoCorto(texto) {
    const corto = String(texto || "").replace(/^[\s\S]*HTTP Error \d+:\s*/, "").trim();
    return corto ? corto.charAt(0).toUpperCase() + corto.slice(1) : "";
  }

  function pintarMenu() {
    const nombre = ($(".usuario-nombre") || {}).textContent || "";
    const correo = zonaUsuario.dataset.correo || "";
    const est = ultimoEstado || {};
    const fuentes = est.fuentes || [];
    const conectadas = fuentes.filter((f) => f.estado === "ok").length;

    const lista = el("ul", { class: "menu-fuentes" });
    if (est.cargando) lista.append(el("li", { class: "menu-nota", text: "⏳ " + (est.mensaje_carga || "Cargando datos…") }));
    for (const f of fuentes) {
      lista.append(el("li", { class: "fuente-" + f.estado },
        el("span", { class: "menu-icono", title: TEXTOS_FUENTE[f.estado], text: ICONOS_FUENTE[f.estado] || "?" }),
        el("div", { class: "menu-fuente" },
          el("strong", { text: f.nombre }),
          el("span", { text: (f.estado === "error" ? motivoCorto(f.detalle) : f.detalle) || TEXTOS_FUENTE[f.estado],
            title: f.detalle || null })),
        f.url ? el("a", { class: "boton boton-chico", href: f.url, target: "_blank", rel: "noopener noreferrer",
          title: "Abrir la hoja en Google Sheets", text: "Abrir ↗" }) : null));
    }
    if (!fuentes.length && !est.cargando) lista.append(el("li", { class: "menu-nota", text: "No hay hojas configuradas." }));

    const avatar = el("span", { class: "avatar", "aria-hidden": "true", text: (nombre || "?").trim().charAt(0).toUpperCase() });
    ponerFoto(avatar);
    menu.replaceChildren(
      el("div", { class: "menu-cabecera" },
        avatar,
        el("div", { class: "menu-quien" }, el("strong", { text: nombre }), correo ? el("span", { text: correo }) : null)),
      el("p", { class: "menu-titulo", text: fuentes.length
        ? `Hojas conectadas · ${conectadas} de ${fuentes.length}` : "Hojas conectadas" }),
      lista,
      selectorTema(),
      selectorLetra(),
      opcionPortapapeles(),
      el("div", { class: "menu-pie menu-atajos" },
        el("button", { class: "boton boton-chico", type: "button", text: "🗓 Tu día", onclick: () => { abrirMenu(false); mostrarTuDia(); } }),
        el("button", { class: "boton boton-chico", type: "button", text: "⌨ Atajos", onclick: () => { abrirMenu(false); mostrarAtajos(); } }),
        ES_ADMIN ? el("button", { class: "boton boton-chico", type: "button", text: "↻ Refrescar datos", disabled: Boolean(est.cargando),
          onclick: refrescar }) : null));
  }

  function selectorTema() {
    const actual = leerTema();
    const opciones = [["sistema", "◐ Sistema"], ["claro", "☀ Claro"], ["oscuro", "☾ Oscuro"]];
    return el("div", { class: "menu-tema" },
      el("span", { class: "menu-titulo", text: "Apariencia" }),
      el("div", { class: "segmentado", role: "radiogroup", "aria-label": "Apariencia" },
        ...opciones.map(([valor, texto]) => el("button", {
          type: "button", role: "radio", "aria-checked": String(valor === actual), class: valor === actual ? "activo" : null, text: texto,
          onclick: (ev) => { ev.stopPropagation(); elegirTema(valor); pintarMenu(); },
        }))));
  }

  function abrirMenu(abrir) {
    menu.hidden = !abrir;
    zonaUsuario.setAttribute("aria-expanded", String(abrir));
    if (abrir) {
      pintarMenu();
      cargarEstado();
    }
  }

  zonaUsuario.addEventListener("click", (ev) => { ev.stopPropagation(); abrirMenu(menu.hidden); });
  zonaUsuario.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); abrirMenu(menu.hidden); }
  });
  document.addEventListener("click", (ev) => {
    if (!menu.hidden && !menu.contains(ev.target)) abrirMenu(false);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !menu.hidden) { abrirMenu(false); zonaUsuario.focus(); }
  });

  // ------------------------------------------------------------------ quién usa la página
  // En la versión de navegador, puente.js deja en .usuario el nombre de pila y la foto de la
  // cuenta de Google (data-nombre, data-foto). En el servidor está el nombre de usuario:
  // 'brandon.lopez' -> 'Brandon'.
  function nombrePila() {
    if (zonaUsuario.dataset.nombre) return zonaUsuario.dataset.nombre;
    const usuario = (($(".usuario-nombre") || {}).textContent || "").trim();
    const primero = usuario.split(/[.\s_@-]/)[0] || usuario;
    return primero ? primero.charAt(0).toUpperCase() + primero.slice(1).toLowerCase() : "";
  }
  // La foto encima de la inicial; si no carga, queda la inicial.
  function ponerFoto(avatar) {
    const foto = zonaUsuario.dataset.foto;
    if (!foto || !avatar || avatar.querySelector("img")) return;
    const img = el("img", { src: foto, alt: "", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.remove());
    avatar.append(img);
  }
  ponerFoto(zonaUsuario.querySelector(".avatar"));

  // ------------------------------------------------------------------ saludo
  // Arriba del buscador, mientras no se ha buscado nada: «Buenos días, Brandon» y la fecha.
  // (Las cifras del día están en el tablero.)
  const portada = $(".portada");
  const saludo = el("div", { class: "saludo" });
  portada.prepend(saludo);

  function pintarSaludo() {
    const hora = new Date().getHours();
    const parte = hora < 12 ? "Buenos días" : hora < 19 ? "Buenas tardes" : "Buenas noches";
    const nombre = nombrePila();
    const avatar = el("span", { class: "avatar saludo-avatar", "aria-hidden": "true", text: (nombre || "?").charAt(0).toUpperCase() });
    ponerFoto(avatar);
    const hoy = new Date().toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" });
    saludo.replaceChildren(avatar, el("div", { class: "saludo-texto" },
      el("strong", { text: parte + (nombre ? ", " + nombre : "") }),
      el("span", { text: hoy.charAt(0).toUpperCase() + hoy.slice(1) })));
  }
  pintarSaludo();

  // ------------------------------------------------------------------ sugerencias
  // Mientras se escribe un nombre o una cédula, debajo salen las personas que coinciden
  // (/api/sugerencias). Flechas para moverse, Enter para abrir su ficha, Esc para cerrar.
  // Enter sin elegir ninguna busca lo escrito, como siempre.
  const listaSugerencias = el("div", { class: "sugerencias", id: "sugerencias", role: "listbox", "aria-label": "Personas que coinciden", hidden: true });
  form.append(listaSugerencias);   // justo debajo del campo, encima de los chips de fuentes
  campo.setAttribute("role", "combobox");
  campo.setAttribute("aria-autocomplete", "list");
  campo.setAttribute("aria-controls", "sugerencias");
  campo.setAttribute("aria-expanded", "false");
  let sugeridas = [];
  let indiceSugerencia = -1;
  let temporizadorSugerencias = null;
  let pedidoSugerencias = 0;

  // Lo que no es un nombre ni una cédula (rangos, montos con signo, recibos) no sugiere nada.
  const sinSugerencias = (texto) => texto.length < 2 || /[<>$=]|\d\s*-\s*\d/.test(texto);

  async function personasPara(texto) {
    const { datos } = await apiJson("/api/sugerencias?q=" + encodeURIComponent(texto));
    return datos.personas || [];
  }

  async function pedirSugerencias() {
    const texto = campo.value.trim();
    const n = ++pedidoSugerencias;
    if (sinSugerencias(texto)) { cerrarSugerencias(); return; }
    try {
      const personas = await personasPara(texto);
      if (n !== pedidoSugerencias || campo.value.trim() !== texto || document.activeElement !== campo) return;
      pintarSugerencias(personas, texto);
    } catch (_) {
      cerrarSugerencias();
    }
  }

  // El nombre con lo escrito resaltado: el comienzo de cada palabra que coincide.
  const sinMarcas = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  function resaltar(nombre, texto) {
    const buscadas = sinMarcas(texto).match(/[A-Z0-9Ñ]+/g) || [];
    const nodo = el("span", { class: "sug-nombre" });
    for (const trozo of String(nombre).split(/(\s+)/)) {
      const largo = Math.max(0, ...buscadas.filter((b) => sinMarcas(trozo).startsWith(b)).map((b) => b.length));
      if (largo) nodo.append(el("mark", { text: trozo.slice(0, largo) }), trozo.slice(largo));
      else nodo.append(trozo);
    }
    return nodo;
  }

  function detallePersona(p) {
    return [`CC ${p.cedula}`, p.distrito ? `Distrito ${p.distrito}` : null,
      p.creditos ? `${p.creditos} crédito${p.creditos === 1 ? "" : "s"}` : null,
      p.pagos ? `${p.pagos} pago${p.pagos === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
  }

  function pintarSugerencias(personas, texto) {
    sugeridas = personas;
    indiceSugerencia = -1;
    campo.removeAttribute("aria-activedescendant");
    if (!personas.length) { cerrarSugerencias(); return; }
    listaSugerencias.replaceChildren(...personas.map((p, i) => el("div", {
      class: "sug-item", role: "option", id: "sug-" + i, "aria-selected": "false", style: `--i:${i}`,
      // pointerdown sin quitarle el foco al buscador; el clic elige.
      onpointerdown: (ev) => ev.preventDefault(),
      onpointermove: () => marcarSugerencia(i),
      onclick: () => elegirSugerencia(p),
    },
    el("span", { class: "sug-avatar", "aria-hidden": "true", text: iniciales(nombrePropio(p.nombre)) }),
    el("span", { class: "sug-textos" }, resaltar(nombrePropio(p.nombre), texto), el("span", { class: "sug-detalle", text: detallePersona(p) })),
    el("kbd", { class: "sug-tecla", text: "Enter" }))),
    el("div", { class: "sug-pie", "aria-hidden": "true" }, "↑ ↓ para moverte · Enter para abrir la ficha · Esc para cerrar"));
    listaSugerencias.hidden = false;
    campo.setAttribute("aria-expanded", "true");
  }

  function marcarSugerencia(i) {
    indiceSugerencia = i;
    listaSugerencias.querySelectorAll(".sug-item").forEach((n, j) => {
      n.classList.toggle("activa", j === i);
      n.setAttribute("aria-selected", String(j === i));
    });
    if (i >= 0) campo.setAttribute("aria-activedescendant", "sug-" + i);
    else campo.removeAttribute("aria-activedescendant");
  }

  function cerrarSugerencias() {
    pedidoSugerencias++;
    clearTimeout(temporizadorSugerencias);
    sugeridas = [];
    indiceSugerencia = -1;
    listaSugerencias.hidden = true;
    listaSugerencias.replaceChildren();
    campo.setAttribute("aria-expanded", "false");
    campo.removeAttribute("aria-activedescendant");
  }

  function elegirSugerencia(p) {
    campo.value = p.cedula_limpia;
    buscar();
  }

  campo.addEventListener("input", () => {
    clearTimeout(temporizadorSugerencias);
    temporizadorSugerencias = setTimeout(pedirSugerencias, 130);
  });
  campo.addEventListener("keydown", (ev) => {
    if (listaSugerencias.hidden) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const n = sugeridas.length;
      marcarSugerencia(ev.key === "ArrowDown" ? (indiceSugerencia + 1) % n : (indiceSugerencia - 1 + n) % n);
    } else if (ev.key === "Enter" && indiceSugerencia >= 0) {
      ev.preventDefault();
      elegirSugerencia(sugeridas[indiceSugerencia]);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cerrarSugerencias();
    }
  });
  campo.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== campo) cerrarSugerencias(); }, 150));

  // ------------------------------------------------------------------ paleta de comandos
  // Ctrl+K (⌘K en Mac) abre una ventana flotante para hacer todo sin el mouse: buscar una
  // persona o una cédula, repetir una búsqueda reciente, abrir el tablero o la tabla de
  // pagos, cambiar el tema, imprimir la ficha… Flechas para moverse, Enter para elegir.
  const campoPaleta = el("input", { type: "search", class: "paleta-campo", autocomplete: "off", spellcheck: "false",
    placeholder: "Busca una persona, una cédula o una acción…", "aria-label": "Buscar en la paleta de comandos",
    role: "combobox", "aria-controls": "paleta-lista", "aria-expanded": "true", "aria-autocomplete": "list" });
  const listaPaleta = el("div", { class: "paleta-lista", id: "paleta-lista", role: "listbox" });
  const paleta = el("dialog", { class: "paleta", "aria-label": "Paleta de comandos" },
    el("div", { class: "paleta-cabecera" }, el("span", { class: "paleta-lupa", "aria-hidden": "true" }), campoPaleta, el("kbd", { text: "Esc" })),
    listaPaleta,
    el("div", { class: "paleta-pie", "aria-hidden": "true" },
      el("span", null, el("kbd", { text: "↑" }), el("kbd", { text: "↓" }), " moverse"),
      el("span", null, el("kbd", { text: "Enter" }), " elegir"),
      el("span", null, el("kbd", { text: "Ctrl" }), el("kbd", { text: "K" }), " abrir o cerrar")));
  document.body.append(paleta);
  let opcionesPaleta = [];
  let indicePaleta = 0;
  let personasPaleta = [];
  let pedidoPaleta = 0;
  let temporizadorPaleta = null;

  function accionesPaleta() {
    const conExtractos = Boolean(ultimoEstado && ultimoEstado.matriz && ultimoEstado.matriz.filas);
    const tema = leerTema();
    const a = busqueda && busqueda.asociado;
    return [
      { icono: "⌕", titulo: "Ir al buscador", accion: () => { campo.focus(); campo.select(); } },
      conExtractos ? (ventanaTablero.hidden
        ? { icono: "▦", titulo: "Abrir el tablero de cartera", detalle: "Pagos por estado, por mes y por distrito", accion: () => abrirTablero().then(() => ventanaTablero.scrollIntoView({ behavior: "smooth", block: "start" })) }
        : { icono: "▦", titulo: "Ocultar el tablero de cartera", accion: cerrarTablero }) : null,
      conExtractos ? (ventanaTabla.hidden
        ? { icono: "☰", titulo: "Ver todos los pagos", detalle: "Los Extractos completos, con filtros", accion: () => abrirTabla().then(() => ventanaTabla.scrollIntoView({ behavior: "smooth", block: "start" })) }
        : { icono: "☰", titulo: "Ocultar todos los pagos", accion: cerrarTabla }) : null,
      conExtractos ? { icono: "●", titulo: "Ver los pagos por gestionar", detalle: "La tabla, sin los ingresados", accion: () => verPagosFiltrados({ estado: { excluir: ["ingresado"] } }) } : null,
      // claves: con qué palabras se encuentra (el nombre de la persona no cuenta).
      a ? { icono: "🖨", titulo: `Imprimir la ficha de ${nombrePropio(a.nombre) || "la persona"}`, claves: "Imprimir ficha PDF", accion: imprimirFicha } : null,
      busqueda && busqueda.grupos && busqueda.grupos.length ? { icono: "⤓", titulo: `Exportar a Excel los resultados de «${busqueda.termino}»`, claves: "Exportar Excel resultados descargar", accion: exportar } : null,
      tema !== "claro" ? { icono: "☀", titulo: "Tema claro", accion: () => elegirTema("claro") } : null,
      tema !== "oscuro" ? { icono: "☾", titulo: "Tema oscuro", accion: () => elegirTema("oscuro") } : null,
      tema !== "sistema" ? { icono: "◐", titulo: "Tema del sistema", detalle: "Claro u oscuro, como el equipo", accion: () => elegirTema("sistema") } : null,
      ES_ADMIN ? { icono: "↻", titulo: "Refrescar datos", detalle: "Vuelve a descargar todas las hojas", accion: refrescar } : null,
      { icono: "🗓", titulo: "Tu día", detalle: "A quién buscaste hoy y qué hiciste", claves: "resumen dia hoy actividad", accion: () => mostrarTuDia() },
      a ? { icono: "📞", titulo: `Modo llamada con ${nombrePropio(a.nombre) || "la persona"}`, claves: "llamar llamada telefono", accion: () => abrirLlamada(a) } : null,
      { icono: "🔎", titulo: "Buscar varias cédulas", detalle: "Pega una lista y mira el estado de todas", claves: "lista masiva varias cedulas", accion: () => abrirBuscarVarias() },
      { icono: "⌨", titulo: "Atajos de teclado", detalle: "Tecla ?", claves: "teclas ayuda", accion: mostrarAtajos },
      { icono: "A", titulo: "Letra más grande", claves: "tamaño zoom aumentar", accion: () => toast(`Tamaño de la letra: ${cambiarLetra(1)} %`) },
      { icono: "a", titulo: "Letra más pequeña", claves: "tamaño zoom reducir", accion: () => toast(`Tamaño de la letra: ${cambiarLetra(-1)} %`) },
      { icono: "◌", titulo: "Ocultar la pantalla", detalle: "Ctrl+Shift+H · la sesión sigue abierta", claves: "privacidad tapar esconder bloquear", accion: mostrarVelo },
    ].filter(Boolean);
  }

  function armarOpcionesPaleta() {
    const texto = campoPaleta.value.trim();
    const normal = normalizar(texto);
    const grupos = [];
    if (texto) grupos.push(["", [{ icono: "⌕", titulo: `Buscar «${texto}»`, detalle: "En los Extractos y las líneas de crédito", accion: () => { campo.value = texto; buscar(); } }]]);
    if (personasPaleta.length) {
      grupos.push(["Personas", personasPaleta.map((p) => ({ persona: p, titulo: nombrePropio(p.nombre), detalle: detallePersona(p),
        accion: () => { campo.value = p.cedula_limpia; buscar(); } }))]);
    }
    const recientes = leerRecientes().filter((t) => !normal || normalizar(t).includes(normal) && t !== texto).slice(0, texto ? 3 : 5);
    if (recientes.length) grupos.push(["Recientes", recientes.map((t) => ({ icono: "↺", titulo: t, accion: () => { campo.value = t; buscar(); } }))]);
    const acciones = accionesPaleta().filter((x) => !normal || normalizar((x.claves || x.titulo) + (x.detalle || "")).includes(normal));
    // Si lo escrito es el comienzo de una palabra de una acción («tabl», «tema»), las
    // acciones van primero: Enter abre el tablero en vez de buscar la palabra.
    const palabra = sinMarcas(texto);
    const fuerte = palabra && acciones.some((x) => sinMarcas(x.claves || x.titulo).split(/\s+/).some((w) => w.startsWith(palabra)));
    if (acciones.length) fuerte ? grupos.unshift(["Acciones", acciones]) : grupos.push(["Acciones", acciones]);
    return grupos;
  }

  function pintarPaleta() {
    const grupos = armarOpcionesPaleta();
    opcionesPaleta = grupos.flatMap(([, lista]) => lista);
    indicePaleta = Math.min(indicePaleta, Math.max(0, opcionesPaleta.length - 1));
    let i = 0;
    const texto = campoPaleta.value.trim();
    listaPaleta.replaceChildren(...grupos.flatMap(([titulo, lista]) => [
      titulo ? el("div", { class: "paleta-grupo", role: "presentation", text: titulo }) : null,
      ...lista.map((o) => {
        const j = i++;
        return el("div", { class: "paleta-item" + (j === indicePaleta ? " activa" : ""), role: "option", id: "paleta-" + j,
          "aria-selected": String(j === indicePaleta),
          onpointermove: () => { if (indicePaleta !== j) { indicePaleta = j; marcarPaleta(); } },
          onclick: () => ejecutarPaleta(j) },
        o.persona ? el("span", { class: "sug-avatar", "aria-hidden": "true", text: iniciales(o.titulo) })
          : el("span", { class: "paleta-icono", "aria-hidden": "true", text: o.icono }),
        el("span", { class: "sug-textos" }, o.persona ? resaltar(o.titulo, texto) : el("span", { class: "sug-nombre", text: o.titulo }),
          o.detalle ? el("span", { class: "sug-detalle", text: o.detalle }) : null));
      })]).filter(Boolean));
    if (!opcionesPaleta.length) listaPaleta.append(el("p", { class: "paleta-vacia", text: "Nada coincide. Enter busca lo escrito." }));
    marcarPaleta();
  }

  function marcarPaleta() {
    listaPaleta.querySelectorAll(".paleta-item").forEach((n, j) => {
      n.classList.toggle("activa", j === indicePaleta);
      n.setAttribute("aria-selected", String(j === indicePaleta));
    });
    const activa = listaPaleta.querySelector(".paleta-item.activa");
    if (activa) { campoPaleta.setAttribute("aria-activedescendant", activa.id); activa.scrollIntoView({ block: "nearest" }); }
  }

  function ejecutarPaleta(j) {
    const opcion = opcionesPaleta[j];
    if (!opcion) return;
    paleta.close();
    opcion.accion();
  }

  async function buscarPersonasPaleta() {
    const texto = campoPaleta.value.trim();
    const n = ++pedidoPaleta;
    if (sinSugerencias(texto)) { personasPaleta = []; pintarPaleta(); return; }
    try {
      const personas = await personasPara(texto);
      if (n !== pedidoPaleta || !paleta.open) return;
      personasPaleta = personas;
      pintarPaleta();
    } catch (_) { /* los datos aún cargan: quedan las acciones */ }
  }

  function abrirPaleta() {
    if (paleta.open) return;
    cerrarSugerencias();
    campoPaleta.value = "";
    personasPaleta = [];
    indicePaleta = 0;
    pintarPaleta();
    paleta.showModal();
    campoPaleta.focus();
  }

  campoPaleta.addEventListener("input", () => {
    indicePaleta = 0;
    pintarPaleta();
    clearTimeout(temporizadorPaleta);
    temporizadorPaleta = setTimeout(buscarPersonasPaleta, 130);
  });
  paleta.addEventListener("keydown", (ev) => {
    const ctrlK = (ev.ctrlKey || ev.metaKey) && (ev.key === "k" || ev.key === "K");
    if (ctrlK || ev.key === "Escape") { ev.preventDefault(); cerrarPaleta(); return; }
    if (!opcionesPaleta.length && ev.key !== "Enter") return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      const n = opcionesPaleta.length;
      indicePaleta = ev.key === "ArrowDown" ? (indicePaleta + 1) % n : (indicePaleta - 1 + n) % n;
      marcarPaleta();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (opcionesPaleta.length) ejecutarPaleta(indicePaleta);
      else if (campoPaleta.value.trim()) { paleta.close(); campo.value = campoPaleta.value.trim(); buscar(); }
    }
  });
  // Un clic fuera de la ventana (en el fondo oscurecido) la cierra.
  paleta.addEventListener("click", (ev) => { if (ev.target === paleta) cerrarPaleta(); });
  paleta.addEventListener("cancel", (ev) => { ev.preventDefault(); cerrarPaleta(); });

  // Esc, un clic afuera o Ctrl+K: la paleta se desvanece en vez de desaparecer de golpe. (Al
  // elegir una opción se cierra al instante: la acción necesita la página libre.)
  function cerrarPaleta() {
    if (!paleta.open || paleta.classList.contains("cerrando")) return;
    if (sinMovimiento()) { paleta.close(); return; }
    paleta.classList.add("cerrando");
    setTimeout(() => { paleta.close(); paleta.classList.remove("cerrando"); }, 180);
  }

  // ------------------------------------------------------------------ atajos de teclado
  // «/»: al buscador, con el texto seleccionado para escribir encima. Ctrl+K (⌘K): la paleta
  // de comandos. No se activan mientras se escribe en otro campo ni con una ventana abierta
  // (detalle, visor de hojas), que tienen su propio teclado. Esc cierra las ventanas (lo
  // hace el navegador).
  const escribiendo = (n) => n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || document.querySelector("dialog[open]")) return;
    // «?»: los atajos; «D»: tu día; «L»: modo llamada con la persona en pantalla.
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !escribiendo(ev.target) && !ev.target.closest(".panel-llamada")) {
      const a = busqueda && busqueda.asociado;
      const accion = ev.key === "?" ? mostrarAtajos : ev.key === "d" ? () => mostrarTuDia() : ev.key === "l" && a ? () => abrirLlamada(a) : null;
      if (accion) { ev.preventDefault(); accion(); return; }
    }
    const ctrlK = (ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === "k" || ev.key === "K");
    const barra = ev.key === "/" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !escribiendo(ev.target);
    if (!ctrlK && !barra) return;
    ev.preventDefault();
    if (ctrlK) { abrirPaleta(); return; }
    campo.focus();
    campo.select();
  });
  campo.title = "Atajos: / para escribir aquí · Ctrl+K para la paleta de comandos · ? para ver todos";

  // ------------------------------------------------------------------ cierre por inactividad
  // Un equipo que queda abierto con una cédula en pantalla deja datos personales a la vista
  // (Ley 1581). Tras data-inactividad minutos sin tocar la página (0 = nunca), se avisa un
  // minuto antes y luego se cierra la sesión: en el servidor, el mismo «Salir»; en la
  // versión de navegador, window.axioCerrarSesion (devuelve el token y borra la memoria).
  // Dentro de la jornada (data-jornada, «08:00-16:30», hora del equipo) no se cierra por
  // inactividad: la sesión sigue abierta toda la jornada y se cierra sola al terminar.
  // Fuera de la jornada vale la regla de los minutos sin uso.
  // Se mide con la hora y no con un temporizador largo: con la pestaña en segundo plano el
  // navegador frena los temporizadores, y al volver se cierra en el acto si ya venció.
  const MINUTOS_INACTIVIDAD = Number(document.body.dataset.inactividad || 0);
  const JORNADA = (() => {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec((document.body.dataset.jornada || "").trim());
    if (!m) return null;
    const desde = Number(m[1]) * 60 + Number(m[2]);
    const hasta = Number(m[3]) * 60 + Number(m[4]);
    return desde < hasta && hasta <= 24 * 60 ? { desde, hasta, texto: horaLegible(hasta) } : null;
  })();
  function horaLegible(minutos) {
    const h = Math.floor(minutos / 60), mm = String(minutos % 60).padStart(2, "0");
    return `${h % 12 || 12}:${mm} ${h < 12 ? "a.m." : "p.m."}`;
  }
  // Milisegundos que faltan para que termine la jornada, o null si ahora no es jornada.
  function quedaJornada() {
    if (!JORNADA) return null;
    const ahora = new Date();
    const minutos = ahora.getHours() * 60 + ahora.getMinutes() + ahora.getSeconds() / 60 + ahora.getMilliseconds() / 60000;
    if (minutos < JORNADA.desde || minutos >= JORNADA.hasta) return null;
    return (JORNADA.hasta - minutos) * 60000;
  }

  if (MINUTOS_INACTIVIDAD > 0 || JORNADA) {
    const LIMITE = MINUTOS_INACTIVIDAD * 60000;
    let ultimaActividad = Date.now();
    let aviso = null;
    let enJornada = quedaJornada() !== null;

    const cerrarSesion = (motivo) => {
      olvidarDia();
      if (typeof window.axioCerrarSesion === "function") return window.axioCerrarSesion(motivo);
      const salir = document.querySelector('form[action$="logout"]');
      if (!salir) { window.location.href = "/login"; return; }
      salir.append(el("input", { type: "hidden", name: "motivo", value: motivo }));
      despedida().then(() => salir.submit());
    };
    const quitarAviso = () => { if (aviso) { aviso.remove(); aviso = null; } };
    const actividad = () => { ultimaActividad = Date.now(); if (quedaJornada() === null) quitarAviso(); };
    for (const evento of ["pointerdown", "keydown", "wheel", "touchstart"]) {
      document.addEventListener(evento, actividad, { capture: true, passive: true });
    }

    const avisar = (titulo, texto, conBoton) => {
      if (aviso && !aviso.isConnected) aviso = null;   // se fue con la ventana que lo tenía
      if (aviso && aviso.dataset.tipo !== titulo) quitarAviso();
      if (!aviso) {
        aviso = el("div", { class: "aviso-inactividad", role: "alertdialog", "aria-live": "assertive", "data-tipo": titulo },
          el("strong", { text: titulo }),
          el("span", { class: "aviso-inactividad-texto" }),
          conBoton
            ? el("button", { class: "boton boton-principal boton-chico", type: "button", text: "Seguir aquí", onclick: actividad })
            : el("button", { class: "boton boton-chico", type: "button", text: "Entendido", onclick: quitarAviso }));
        (document.querySelector("dialog[open]") || document.body).append(aviso);
      }
      aviso.querySelector(".aviso-inactividad-texto").textContent = texto;
    };

    let avisoJornadaVisto = false;
    let diaAlCierre = false;
    const revisar = () => {
      const jornada = quedaJornada();
      if (jornada !== null) {
        enJornada = true;
        ultimaActividad = Date.now();   // dentro de la jornada no cuenta la inactividad
        // Diez minutos antes del cierre, «Tu día»: para copiarlo antes de que se borre. Con la
        // pantalla oculta se espera (no se muestran nombres encima del velo).
        if (jornada <= 10 * 60000 && !diaAlCierre && !velo.open) {
          diaAlCierre = true;
          const d = leerDia();
          if (d.personas.length || d.otras.length) {
            mostrarTuDia(`La jornada termina a las ${JORNADA.texto} y la sesión se cerrará sola. Copia el resumen si lo necesitas: al cerrar se borra.`);
          }
        }
        if (jornada > 60000) { avisoJornadaVisto = false; if (aviso && aviso.dataset.tipo !== "Fin de la jornada") quitarAviso(); return; }
        if (!avisoJornadaVisto || aviso) {
          avisoJornadaVisto = true;
          avisar("Fin de la jornada",
            `La jornada termina a las ${JORNADA.texto}: la sesión se cerrará en ${Math.ceil(jornada / 1000)} s.`, false);
        }
        return;
      }
      if (enJornada) {   // la jornada acaba de terminar (o terminó con la pestaña dormida)
        clearInterval(reloj); quitarAviso(); cerrarSesion("jornada"); return;
      }
      if (MINUTOS_INACTIVIDAD <= 0) return;
      const quedan = LIMITE - (Date.now() - ultimaActividad);
      if (quedan <= 0) { clearInterval(reloj); quitarAviso(); cerrarSesion("inactividad"); return; }
      if (quedan > Math.min(60000, LIMITE / 2)) return;
      avisar("¿Sigues ahí?", `Por seguridad, la sesión se cerrará en ${Math.ceil(quedan / 1000)} s por inactividad.`, true);
    };
    const reloj = setInterval(revisar, 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) revisar(); });
  }

  // ------------------------------------------------------------------ tu día
  // Lo que esta persona hizo hoy en Axio: a quién buscó y qué hizo con cada una (llamadas y
  // su resultado, WhatsApp, cambios en las hojas, gestiones en la Matriz). Se guarda solo en
  // esta pestaña (sessionStorage): no sale del equipo, aguanta un F5 y se borra al cerrar la
  // pestaña o la sesión.
  const CLAVE_DIA = "axio_dia";
  const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const horaDe = (iso) => new Date(iso).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit" });
  const soloDigitos = (t) => String(t || "").replace(/\D/g, "");

  function leerDia() {
    try {
      const d = JSON.parse(sessionStorage.getItem(CLAVE_DIA));
      if (d && d.fecha === hoyISO() && Array.isArray(d.personas)) return d;
    } catch (_) { /* sin almacenamiento */ }
    return { fecha: hoyISO(), personas: [], otras: [] };
  }
  function guardarDia(d) {
    try { sessionStorage.setItem(CLAVE_DIA, JSON.stringify(d)); } catch (_) { /* sin almacenamiento */ }
  }
  function olvidarDia() {
    try { sessionStorage.removeItem(CLAVE_DIA); } catch (_) { /* sin almacenamiento */ }
  }

  function anotarPersona(a) {
    if (!a || !a.cedula_limpia) return;
    const d = leerDia();
    const ahora = new Date().toISOString();
    let p = d.personas.find((x) => x.cedula_limpia === a.cedula_limpia);
    if (!p) {
      p = { cedula_limpia: a.cedula_limpia, cedula: a.cedula, nombre: a.nombre || "", primera: ahora, veces: 0, acciones: [] };
      d.personas.push(p);
    }
    p.ultima = ahora;
    p.veces += 1;
    if (a.nombre) p.nombre = a.nombre;
    guardarDia(d);
  }

  // accion: { tipo: "llamada" | "whatsapp" | "hoja" | "matriz" | "ficha" | "lista", ... }. Sin
  // cédula, va a la persona que está en pantalla; con cédula null, a «otras acciones».
  function anotarAccion(accion, cedula) {
    const d = leerDia();
    const limpia = cedula === null ? "" : soloDigitos(cedula) || (busqueda && busqueda.asociado && busqueda.asociado.cedula_limpia) || "";
    const p = limpia && d.personas.find((x) => x.cedula_limpia === limpia);
    const registro = { ...accion, hora: new Date().toISOString() };
    delete registro.cedula;
    (p ? p.acciones : d.otras).push(registro);
    guardarDia(d);
    if (dialogoDia.open) mostrarTuDia();
  }
  // El visor de hojas y «Gestionar en la Matriz» (versión de navegador) avisan por aquí.
  window.addEventListener("axio-actividad", (ev) => { if (ev.detail && ev.detail.tipo) anotarAccion(ev.detail, ev.detail.cedula); });

  const RESULTADOS_LLAMADA = {
    contesto: { icono: "✅", texto: "Contestó", tecla: "1" },
    no_contesto: { icono: "📵", texto: "No contestó", tecla: "2" },
    promesa: { icono: "🤝", texto: "Promesa de pago", tecla: "3" },
    equivocado: { icono: "❌", texto: "Número equivocado", tecla: "4" },
  };
  const fechaPromesa = (iso) => { const f = aFecha(iso); return f ? `${f.getDate()} de ${MESES_LARGOS[f.getMonth()]}` : iso; };

  function textoAccion(x) {
    if (x.tipo === "llamada") {
      const r = RESULTADOS_LLAMADA[x.resultado] || { icono: "📞", texto: "Llamada" };
      const promesa = x.resultado === "promesa" ? [x.monto ? pesos(x.monto) : null, x.fecha ? "el " + fechaPromesa(x.fecha) : null].filter(Boolean).join(" ") : "";
      return `${r.icono} ${r.texto}${promesa ? ": " + promesa : ""}${x.nota ? " · «" + x.nota + "»" : ""}`;
    }
    if (x.tipo === "whatsapp") return "💬 WhatsApp" + (x.plantilla ? " · " + x.plantilla : "");
    if (x.tipo === "hoja") return "✏️ " + (x.texto || "Cambio en una hoja");
    if (x.tipo === "matriz") return "📝 " + (x.texto || "Gestión en la Matriz");
    if (x.tipo === "ficha") return "🖨️ Ficha impresa";
    if (x.tipo === "lista") return "🔎 " + (x.texto || "Búsqueda por lista");
    return x.texto || x.tipo;
  }

  function cuentasDia(d) {
    const acciones = d.personas.flatMap((p) => p.acciones).concat(d.otras);
    const llamadas = acciones.filter((x) => x.tipo === "llamada");
    const promesas = llamadas.filter((x) => x.resultado === "promesa");
    return {
      personas: d.personas.length,
      llamadas: llamadas.length,
      contestaron: llamadas.filter((x) => x.resultado === "contesto" || x.resultado === "promesa").length,
      promesas: promesas.length,
      sumaPromesas: promesas.reduce((s, x) => s + (Number(x.monto) || 0), 0),
      whatsapp: acciones.filter((x) => x.tipo === "whatsapp").length,
      cambios: acciones.filter((x) => x.tipo === "hoja" || x.tipo === "matriz").length,
    };
  }
  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
  const contestaron = (n) => plural(n, "contestó", "contestaron");

  function textoTuDia(d) {
    const c = cuentasDia(d);
    const lineas = [`Tu día en Axio · ${new Date().toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" })}`,
      [plural(c.personas, "persona consultada", "personas consultadas"),
        plural(c.llamadas, "llamada", "llamadas") + (c.llamadas ? ` (${contestaron(c.contestaron)})` : ""),
        plural(c.promesas, "promesa de pago", "promesas de pago") + (c.sumaPromesas ? ` (${pesos(c.sumaPromesas)})` : ""),
        plural(c.whatsapp, "WhatsApp", "WhatsApp"), plural(c.cambios, "cambio en hojas", "cambios en hojas")].join(" · "), ""];
    for (const p of [...d.personas].sort((x, y) => x.primera.localeCompare(y.primera))) {
      const hecho = p.acciones.length ? p.acciones.map((x) => `${textoAccion(x)} (${horaDe(x.hora)})`).join("; ") : "solo consulta";
      lineas.push(`• ${nombrePropio(p.nombre) || "Sin nombre"} (CC ${p.cedula}), ${horaDe(p.primera)}: ${hecho}`);
    }
    for (const x of d.otras) lineas.push(`• ${textoAccion(x)} (${horaDe(x.hora)})`);
    return lineas.join("\n");
  }

  const dialogoDia = el("dialog", { class: "dialogo-axio dialogo-dia", "aria-labelledby": "dia-titulo" });
  document.body.append(dialogoDia);
  dialogoDia.addEventListener("click", (ev) => { if (ev.target === dialogoDia || ev.target.closest("[data-cerrar]")) dialogoDia.close(); });

  // aviso: una línea arriba (p. ej. «la jornada termina a las 4:30»).
  function mostrarTuDia(aviso) {
    const d = leerDia();
    const c = cuentasDia(d);
    const personas = [...d.personas].sort((x, y) => (y.ultima || "").localeCompare(x.ultima || ""));
    const desde = d.personas.length ? d.personas.map((p) => p.primera).sort()[0] : null;
    const fecha = new Date().toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" });
    const cifraDia = (n, etiqueta, detalle) => el("div", { class: "dia-cifra" + (n ? "" : " cero") },
      el("strong", { text: String(n) }), el("span", { text: etiqueta }), detalle ? el("em", { text: detalle }) : null);
    const chip = (x) => el("span", { class: "dia-chip dia-" + (x.resultado || x.tipo) }, textoAccion(x), el("small", { text: horaDe(x.hora) }));
    const lista = personas.length
      ? el("ol", { class: "dia-lista" }, ...personas.map((p) => el("li", { class: "dia-fila" },
        el("button", { type: "button", class: "dia-persona", title: "Volver a buscar a esta persona",
          onclick: () => { dialogoDia.close(); campo.value = p.cedula_limpia; buscar(); } },
          el("span", { class: "dia-avatar", "aria-hidden": "true", text: iniciales(nombrePropio(p.nombre)) }),
          el("span", { class: "dia-quien" },
            el("strong", { text: nombrePropio(p.nombre) || "CC " + p.cedula }),
            el("span", { text: `CC ${p.cedula} · ${horaDe(p.primera)}${p.veces > 1 ? ` · ${p.veces} búsquedas` : ""}` }))),
        el("div", { class: "dia-acciones" }, ...(p.acciones.length ? p.acciones.map(chip) : [el("span", { class: "dia-chip dia-solo", text: "🔍 Solo consulta" })])))))
      : el("p", { class: "dia-vacio", text: "Todavía no has buscado a nadie hoy. Lo que hagas aparecerá aquí." });
    dialogoDia.replaceChildren(
      el("div", { class: "dialogo-axio-cabecera" },
        el("div", null,
          el("h2", { id: "dia-titulo", text: "Tu día" }),
          el("span", { class: "dialogo-axio-sub", text: fecha.charAt(0).toUpperCase() + fecha.slice(1) + (desde ? " · desde las " + horaDe(desde) : "") })),
        el("button", { class: "boton boton-texto boton-cerrar", type: "button", "aria-label": "Cerrar", "data-cerrar": "", text: "✕" })),
      el("div", { class: "dialogo-axio-cuerpo" },
        aviso ? el("p", { class: "dia-aviso", text: aviso }) : null,
        el("div", { class: "dia-cifras" },
          cifraDia(c.personas, c.personas === 1 ? "persona consultada" : "personas consultadas"),
          cifraDia(c.llamadas, c.llamadas === 1 ? "llamada" : "llamadas", c.llamadas ? contestaron(c.contestaron) : null),
          cifraDia(c.promesas, c.promesas === 1 ? "promesa de pago" : "promesas de pago", c.sumaPromesas ? pesos(c.sumaPromesas) : null),
          cifraDia(c.whatsapp, "WhatsApp"),
          cifraDia(c.cambios, c.cambios === 1 ? "cambio en hojas" : "cambios en hojas")),
        lista,
        d.otras.length ? el("div", { class: "dia-otras" }, el("strong", { text: "Otras acciones" }), el("div", { class: "dia-acciones" }, ...d.otras.map(chip))) : null),
      el("div", { class: "dialogo-axio-pie" },
        el("span", { text: "Solo en esta pestaña: se borra al cerrar la sesión." }),
        el("button", { class: "boton boton-chico", type: "button", text: "📋 Copiar resumen", disabled: !d.personas.length && !d.otras.length,
          onclick: (ev) => copiar(textoTuDia(leerDia()), "Resumen copiado: pégalo en un correo o un chat.", ev.currentTarget) })));
    if (!dialogoDia.open) dialogoDia.showModal();
  }

  // ------------------------------------------------------------------ plantillas de WhatsApp
  // Mensajes listos para revisar y enviar en WhatsApp (nada sale solo), con el nombre, los
  // créditos en mora, el último pago o la promesa ya escritos.
  const lineaDe = (x) => (x.e.tipo_credito && x.e.tipo_credito !== x.linea ? x.e.tipo_credito : x.linea);
  const enumerar = (lista) => (lista.length < 2 ? lista.join("") : lista.slice(0, -1).join(", ") + " y " + lista[lista.length - 1]);

  function plantillasWhatsapp(a, todos, promesa) {
    const nombre = nombrePropio(a.nombre);
    const saludo = `Hola${nombre ? ", " + nombre : ""}. Le saludamos del área de Cartera.`;
    const enMora = todos.filter((x) => x.estado.mora);
    const lineas = enumerar([...new Set(enMora.map(lineaDe))]);
    const ultimo = (a.pagos || []).find((p) => p.fecha);
    return [
      promesa ? { titulo: "Confirmar la promesa", detalle: "El acuerdo de esta llamada",
        texto: `${saludo}\nConfirmamos el acuerdo de la llamada de hoy: ${promesa.monto ? "un pago de " + pesos(promesa.monto) : "un pago"}${promesa.fecha ? " el " + fechaPromesa(promesa.fecha) : ""}. Le agradecemos enviarnos el comprobante cuando lo realice.\n¡Muchas gracias!` } : null,
      { titulo: "Estado de cuenta", detalle: enMora.length ? "Sus créditos en mora, con saldo" : "Saludo y quedamos atentos", texto: mensajeAsociado(a, todos) },
      enMora.length ? { titulo: "Recordatorio de cuota", detalle: "Si ya pagó, pide el comprobante",
        texto: `${saludo}\nLe recordamos que tiene pendiente el pago de ${enMora.length === 1 ? "su cuota de " : "sus cuotas de "}${lineas}. Si ya realizó el pago, por favor envíenos el comprobante para registrarlo.\n¡Muchas gracias!` } : null,
      enMora.length ? { titulo: "Propuesta de acuerdo", detalle: "Invita a acordar fecha y valor",
        texto: `${saludo}\nQueremos ayudarle a ponerse al día con ${lineas}. ¿Podemos acordar una fecha y un valor de pago que se ajusten a sus posibilidades?\nQuedamos atentos a su respuesta.` } : null,
      ultimo ? { titulo: "Confirmación de pago", detalle: `Su pago del ${fechaCorta(aFecha(ultimo.fecha))}`,
        texto: `${saludo}\nConfirmamos que recibimos su pago del ${fechaCorta(aFecha(ultimo.fecha))}${ultimo.valor ? " por " + pesos(ultimo.valor) : ""}. ¡Muchas gracias!` } : null,
      { titulo: "No logramos comunicarnos", detalle: "Después de una llamada sin respuesta",
        texto: `${saludo}\nIntentamos comunicarnos con usted por teléfono, sin éxito. Por favor escríbanos o llámenos cuando le sea posible.\n¡Muchas gracias!` },
    ].filter(Boolean);
  }

  const enlaceWhatsapp = (enlace, texto) => `${enlace}?text=${encodeURIComponent(texto)}`;

  // El botón de WhatsApp de la ficha con su ▾ para elegir el mensaje.
  function whatsappConPlantillas(a, todos) {
    const plantillas = plantillasWhatsapp(a, todos);
    const principal = botonWhatsapp(a.whatsapp, plantillas[0].texto);
    principal.addEventListener("click", () => anotarAccion({ tipo: "whatsapp", plantilla: plantillas[0].titulo }, a.cedula_limpia));
    const mas = el("button", { class: "boton boton-whatsapp boton-chico whatsapp-mas", type: "button", "aria-haspopup": "menu",
      "aria-label": "Elegir el mensaje de WhatsApp", title: "Elegir otro mensaje", text: "▾" });
    mas.addEventListener("click", (ev) => { ev.stopPropagation(); abrirMenuWhatsapp(mas, a, plantillasWhatsapp(a, todos)); });
    return el("span", { class: "whatsapp-grupo" }, principal, mas);
  }

  function abrirMenuWhatsapp(boton, a, plantillas) {
    document.querySelectorAll(".menu-whatsapp").forEach((m) => m.remove());
    const menuW = el("div", { class: "menu-whatsapp", popover: "auto", role: "menu", "aria-label": "Mensajes de WhatsApp" },
      el("p", { class: "menu-whatsapp-titulo", text: "Elige el mensaje" }),
      ...plantillas.map((p) => el("a", { class: "menu-whatsapp-item", role: "menuitem", href: enlaceWhatsapp(a.whatsapp, p.texto),
        target: "_blank", rel: "noopener noreferrer", title: p.texto,
        onclick: () => { anotarAccion({ tipo: "whatsapp", plantilla: p.titulo }, a.cedula_limpia); menuW.hidePopover(); } },
        el("strong", { text: p.titulo }), el("span", { text: p.detalle }))),
      el("p", { class: "menu-whatsapp-pie", text: "Se abre en WhatsApp para revisarlo antes de enviar." }));
    (boton.closest("dialog, .panel-llamada") || document.body).append(menuW);
    menuW.addEventListener("toggle", (e) => { if (e.newState === "closed") menuW.remove(); });
    menuW.addEventListener("keydown", (e) => {
      const items = [...menuW.querySelectorAll(".menu-whatsapp-item")];
      const k = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(k + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }
    });
    menuW.showPopover();
    const r = boton.getBoundingClientRect(), m = menuW.getBoundingClientRect();
    const izquierda = Math.max(8, Math.min(window.innerWidth - m.width - 8, r.right - m.width));
    const arriba = r.bottom + 6 + m.height > window.innerHeight - 8 ? Math.max(8, r.top - 6 - m.height) : r.bottom + 6;
    menuW.style.left = izquierda + "px";
    menuW.style.top = arriba + "px";
    menuW.querySelector(".menu-whatsapp-item").focus();
  }

  // ------------------------------------------------------------------ modo llamada
  // Un panel al costado con lo que hace falta mientras se habla con la persona: nombre,
  // celular, lo que está en mora y el último pago. Abajo, el resultado en un toque (o con 1,
  // 2, 3, 4). Solo se anota en «Tu día»: no escribe en la Matriz ni en ninguna hoja.
  let panelLlamada = null;
  const celularDe = (enlace) => { const m = /wa\.me\/(\d+)/.exec(enlace || ""); return m ? m[1] : ""; };
  function celularLegible(n) {
    const local = n.length === 12 && n.startsWith("57") ? n.slice(2) : n;
    return local.length === 10 ? `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}` : n;
  }
  const minutosSegundos = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // Los créditos de la persona, primero los que están en mora (como en su ficha).
  function creditosDe(a) {
    const todos = (a.lineas || []).flatMap((l) => l.entradas.map((e) => ({ linea: l.linea, e, estado: estadoCredito(e) })));
    const peso = (x) => (x.estado.mora ? 0 : x.estado.mora === null ? 1 : 2);
    return todos.sort((x, y) => peso(x) - peso(y));
  }

  function cerrarLlamada() {
    if (!panelLlamada) return;
    clearInterval(panelLlamada.reloj);
    const p = panelLlamada;
    panelLlamada = null;
    p.classList.add("saliendo");
    setTimeout(() => p.remove(), 200);
  }

  function abrirLlamada(a) {
    cerrarLlamada();
    const todos = creditosDe(a);
    const celular = celularDe(a.whatsapp);
    const enMora = todos.filter((x) => x.estado.mora);
    const ultimo = (a.pagos || []).find((p) => p.fecha);
    const inicio = Date.now();
    const reloj = el("span", { class: "ll-reloj", title: "Tiempo desde que abriste el modo llamada", text: "0:00" });
    const dato = (etiqueta, valor, copiable, mensaje) => el("div", { class: "ll-dato" },
      el("span", { class: "ll-etiqueta", text: etiqueta }),
      el("strong", { text: valor }),
      copiable ? el("button", { class: "boton boton-texto ll-copiar", type: "button", title: "Copiar", "aria-label": "Copiar " + etiqueta.toLowerCase(),
        text: "📋", onclick: (ev) => copiar(copiable, mensaje, ev.currentTarget) }) : null);
    const situacion = enMora.length
      ? el("ul", { class: "ll-mora" }, ...enMora.map((x) => {
        const saldo = x.e.saldo_actual || x.e.saldo;
        return el("li", null,
          el("strong", { text: lineaDe(x) }),
          el("span", { text: [saldo ? "Saldo " + conPesos(saldo) : null,
            x.e.meses_mora ? `${x.e.meses_mora} ${x.e.meses_mora === "1" ? "mes" : "meses"} en mora` : null,
            x.e.fecha_ultimo_pago ? "último pago " + x.e.fecha_ultimo_pago : null].filter(Boolean).join(" · ") }));
      }))
      : el("p", { class: "ll-al-dia", text: todos.length ? "🟢 Al día en todos sus créditos" : "Sin créditos activos en las líneas" });

    const nota = el("input", { class: "ll-nota", type: "text", maxlength: "140", placeholder: "Nota (opcional): «llamar después de las 3»…", "aria-label": "Nota de la llamada" });
    const zonaResultado = el("div", { class: "ll-resultado" });
    const botonesResultado = el("div", { class: "ll-botones", role: "group", "aria-label": "Resultado de la llamada" },
      ...Object.entries(RESULTADOS_LLAMADA).map(([clave, r]) => el("button", { class: "ll-boton ll-" + clave, type: "button", "data-resultado": clave,
        onclick: () => (clave === "promesa" ? pedirPromesa() : anotar(clave)) },
        el("span", { class: "ll-icono", "aria-hidden": "true", text: r.icono }), el("span", { text: r.texto }), el("kbd", { text: r.tecla }))));
    zonaResultado.append(botonesResultado, nota);

    function pedirPromesa() {
      const manana = new Date(Date.now() + 86400000);
      const fecha = el("input", { type: "date", class: "ll-fecha", "aria-label": "Fecha de la promesa",
        value: `${manana.getFullYear()}-${String(manana.getMonth() + 1).padStart(2, "0")}-${String(manana.getDate()).padStart(2, "0")}` });
      const monto = el("input", { type: "text", inputmode: "numeric", class: "ll-monto", placeholder: "Valor, p. ej. 500.000", "aria-label": "Valor prometido" });
      monto.addEventListener("input", () => {
        const n = soloDigitos(monto.value);
        monto.value = n ? formatoMiles.format(Number(n)) : "";
      });
      const guardar = () => anotar("promesa", { fecha: fecha.value, monto: Number(soloDigitos(monto.value)) || null });
      monto.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); guardar(); } });
      zonaResultado.replaceChildren(
        el("p", { class: "ll-pregunta", text: "🤝 ¿Cuánto y cuándo va a pagar?" }),
        el("div", { class: "ll-promesa" },
          el("label", null, el("span", { text: "Valor" }), monto),
          el("label", null, el("span", { text: "Fecha" }), fecha)),
        nota,
        el("div", { class: "ll-acciones" },
          el("button", { class: "boton boton-chico", type: "button", text: "← Volver", onclick: () => zonaResultado.replaceChildren(botonesResultado, nota) }),
          el("button", { class: "boton boton-principal boton-chico", type: "button", text: "Anotar la promesa", onclick: guardar })));
      monto.focus();
    }

    function anotar(clave, extra = {}) {
      clearInterval(panel.reloj);
      const segundos = Math.round((Date.now() - inicio) / 1000);
      anotarAccion({ tipo: "llamada", resultado: clave, nota: nota.value.trim() || null, duracion: segundos, ...extra }, a.cedula_limpia);
      const r = RESULTADOS_LLAMADA[clave];
      const plantillas = a.whatsapp ? plantillasWhatsapp(a, todos, clave === "promesa" ? extra : null) : [];
      const sugerida = clave === "no_contesto" ? plantillas.find((p) => p.titulo === "No logramos comunicarnos")
        : clave === "promesa" ? plantillas[0] : null;
      const enviar = sugerida ? el("a", { class: "boton boton-whatsapp boton-chico", href: enlaceWhatsapp(a.whatsapp, sugerida.texto), target: "_blank", rel: "noopener noreferrer",
        text: clave === "promesa" ? "💬 Confirmar por WhatsApp" : "💬 Avisar por WhatsApp",
        onclick: () => anotarAccion({ tipo: "whatsapp", plantilla: sugerida.titulo }, a.cedula_limpia) }) : null;
      zonaResultado.replaceChildren(
        el("div", { class: "ll-anotado" }, palomita("palomita ll-palomita"),
          el("div", null,
            el("strong", { text: `${r.icono} ${r.texto}` + (clave === "promesa" ? ": " + [extra.monto ? pesos(extra.monto) : null, extra.fecha ? "el " + fechaPromesa(extra.fecha) : null].filter(Boolean).join(" ") : "") }),
            el("span", { text: `Anotado en «Tu día» · ${minutosSegundos(segundos)} de llamada` }))),
        el("div", { class: "ll-acciones" },
          enviar,
          el("button", { class: "boton boton-chico", type: "button", text: "🗓 Ver tu día", onclick: () => mostrarTuDia() }),
          el("button", { class: "boton boton-chico", type: "button", text: "Cerrar", onclick: cerrarLlamada })));
      panel.focus({ preventScroll: true });
    }

    const nombre = nombrePropio(a.nombre) || "CC " + a.cedula;
    const panel = el("aside", { class: "panel-llamada", role: "dialog", "aria-label": "Modo llamada con " + nombre, tabindex: "-1" },
      el("div", { class: "ll-cabecera" },
        el("span", { class: "ll-pulso", "aria-hidden": "true" }),
        el("span", { class: "ll-titulo", text: "Modo llamada" }),
        reloj,
        el("button", { class: "boton boton-texto boton-cerrar", type: "button", "aria-label": "Cerrar el modo llamada", text: "✕", onclick: cerrarLlamada })),
      el("div", { class: "ll-cuerpo" },
        el("div", { class: "ll-persona" },
          el("span", { class: "asociado-avatar ll-avatar", "aria-hidden": "true", text: iniciales(nombrePropio(a.nombre)) }),
          el("div", null, el("strong", { class: "ll-nombre", text: nombre }), el("span", { class: "ll-cc", text: "CC " + a.cedula }))),
        el("div", { class: "ll-datos" },
          celular ? dato("Celular", celularLegible(celular), celularLegible(celular).replace(/\s/g, ""), "Celular copiado.")
            : el("div", { class: "ll-dato ll-falta" }, el("span", { class: "ll-etiqueta", text: "Celular" }), el("span", { text: "No está en el directorio de WhatsApp" })),
          el("div", { class: "ll-par" },
            dato("Cédula", a.cedula, a.cedula_limpia, "Cédula copiada."),
            dato("Último pago", ultimo ? `${fechaCorta(aFecha(ultimo.fecha))}${ultimo.valor ? " · " + pesos(ultimo.valor) : ""}` : "Sin pagos en Extractos"))),
        el("p", { class: "ll-subtitulo", text: enMora.length ? `🔴 ${plural(enMora.length, "crédito en mora", "créditos en mora")}` : "Créditos" }),
        situacion,
        el("p", { class: "ll-subtitulo", text: "¿Cómo terminó la llamada?" }),
        zonaResultado,
        el("p", { class: "ll-pie", text: "Solo se anota en «Tu día»: no cambia la Matriz ni ninguna hoja." })));
    panel.reloj = setInterval(() => { reloj.textContent = minutosSegundos(Math.round((Date.now() - inicio) / 1000)); }, 1000);
    panel.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); cerrarLlamada(); return; }
      if (escribiendo(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey || !botonesResultado.isConnected) return;
      const clave = Object.keys(RESULTADOS_LLAMADA).find((k) => RESULTADOS_LLAMADA[k].tecla === ev.key);
      if (clave) { ev.preventDefault(); botonesResultado.querySelector(`[data-resultado="${clave}"]`).click(); }
    });
    panelLlamada = panel;
    document.body.append(panel);
    panel.focus({ preventScroll: true });
  }

  // Esc cierra el panel aunque el foco ya no esté en él (si no hay una ventana encima).
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && panelLlamada && !ev.defaultPrevented && !document.querySelector("dialog[open], .menu-whatsapp:popover-open")) cerrarLlamada();
  });

  // ------------------------------------------------------------------ portapapeles inteligente
  // Al volver a Axio con una cédula copiada en otro programa (Siasoft, un correo, Excel), se
  // ofrece buscarla: Enter la busca. Se activa una vez (el navegador pide permiso para leer
  // lo copiado) y se apaga desde el menú. Solo mira cifras que parecen una cédula.
  const CLAVE_PORTAPAPELES = "axio.portapapeles";   // "si" | "no" | sin decidir
  let ultimaOfrecida = "";
  let temporizadorOferta = null;
  const oferta = el("div", { class: "oferta-portapapeles", role: "status", hidden: true });
  document.body.append(oferta);

  function preferenciaPortapapeles() {
    try { return sessionStorage.getItem(CLAVE_PORTAPAPELES) || ""; } catch (_) { return ""; }
  }
  function elegirPortapapeles(valor) {
    try { sessionStorage.setItem(CLAVE_PORTAPAPELES, valor); } catch (_) { /* sin almacenamiento */ }
  }
  function cedulaDe(texto) {
    const t = String(texto || "").trim();
    if (!t || t.length > 24 || !/^[\d.,\s-]+$/.test(t)) return "";
    const d = soloDigitos(t);
    return d.length >= 6 && d.length <= 10 ? d : "";
  }
  function quitarOferta() {
    clearTimeout(temporizadorOferta);
    oferta.hidden = true;
    oferta.replaceChildren();
  }
  function mostrarOferta(...hijos) {
    oferta.replaceChildren(...hijos, el("button", { class: "boton boton-texto oferta-cerrar", type: "button", "aria-label": "Cerrar", text: "✕", onclick: quitarOferta }));
    oferta.hidden = false;
    clearTimeout(temporizadorOferta);
    temporizadorOferta = setTimeout(quitarOferta, 14000);
  }
  async function permisoPortapapeles() {
    try { return (await navigator.permissions.query({ name: "clipboard-read" })).state; } catch (_) { return ""; }
  }
  async function mirarPortapapeles() {
    if (!navigator.clipboard || !navigator.clipboard.readText || document.hidden || velo.open || document.querySelector("dialog[open]")) return;
    let pref = preferenciaPortapapeles();
    if (pref === "no") return;
    if (pref !== "si") {
      // Si el navegador ya dio el permiso (otra sesión), se usa; si no, se invita una vez.
      if (await permisoPortapapeles() === "granted") { pref = "si"; elegirPortapapeles("si"); }
      else { invitarPortapapeles(); return; }
    }
    let texto;
    try { texto = await navigator.clipboard.readText(); } catch (_) { return; }
    const cedula = cedulaDe(texto);
    const enPantalla = busqueda && busqueda.asociado ? busqueda.asociado.cedula_limpia : "";
    if (!cedula || cedula === ultimaOfrecida || cedula === soloDigitos(campo.value) || cedula === enPantalla) return;
    ultimaOfrecida = cedula;
    mostrarOferta(
      el("span", { class: "oferta-icono", "aria-hidden": "true", text: "📋" }),
      el("span", { class: "oferta-texto" }, "Copiaste ", el("strong", { text: formatoMiles.format(Number(cedula)) })),
      el("button", { class: "boton boton-principal boton-chico", type: "button", onclick: () => buscarOfrecida(cedula) }, "Buscar ", el("kbd", { text: "Enter" })));
    oferta.dataset.cedula = cedula;
  }
  let invitado = false;
  function invitarPortapapeles() {
    if (invitado) return;
    invitado = true;
    mostrarOferta(
      el("span", { class: "oferta-icono", "aria-hidden": "true", text: "📋" }),
      el("span", { class: "oferta-texto", text: "¿Te ofrezco buscar las cédulas que copies en otros programas?" }),
      el("button", { class: "boton boton-principal boton-chico", type: "button", text: "Activar", onclick: async () => {
        quitarOferta();
        try {
          const texto = await navigator.clipboard.readText();   // aquí el navegador pide el permiso
          elegirPortapapeles("si");
          toast("Listo: cuando vuelvas con una cédula copiada, te ofrezco buscarla.");
          ultimaOfrecida = cedulaDe(texto);
        } catch (_) {
          toast("El navegador no dio el permiso. Puedes activarlo después desde tu menú.");
        }
      } }),
      el("button", { class: "boton boton-texto boton-chico", type: "button", text: "No, gracias", onclick: () => { elegirPortapapeles("no"); quitarOferta(); } }));
  }
  function buscarOfrecida(cedula) {
    quitarOferta();
    campo.value = cedula;
    buscar();
  }
  // Volver a la ventana de Axio (desde otro programa) es la señal para mirar lo copiado.
  let salioDeAxio = false;
  window.addEventListener("blur", () => { salioDeAxio = true; });
  window.addEventListener("focus", () => { if (salioDeAxio) { salioDeAxio = false; setTimeout(mirarPortapapeles, 120); } });
  document.addEventListener("keydown", (ev) => {
    if (oferta.hidden || !oferta.dataset.cedula) return;
    if (ev.key === "Escape") { quitarOferta(); return; }
    if (ev.key !== "Enter" || document.querySelector("dialog[open]") || (escribiendo(ev.target) && ev.target.value && ev.target !== campo)) return;
    if (ev.target === campo && campo.value.trim() && soloDigitos(campo.value) !== oferta.dataset.cedula) return;
    ev.preventDefault();
    buscarOfrecida(oferta.dataset.cedula);
  }, true);

  // ------------------------------------------------------------------ tamaño de la letra
  // A− / A+ en el menú de la persona: agranda el contenido (fichas, tablas, detalle), no la
  // ventana. Se recuerda en este navegador.
  const CLAVE_LETRA = "axio.letra";
  const NIVELES_LETRA = [90, 100, 110, 120, 135];
  function leerLetra() {
    try { const n = Number(sessionStorage.getItem(CLAVE_LETRA)); return NIVELES_LETRA.includes(n) ? n : 100; } catch (_) { return 100; }
  }
  function aplicarLetra(n) {
    if (n === 100) document.documentElement.style.removeProperty("--letra");
    else document.documentElement.style.setProperty("--letra", String(n / 100));
  }
  function cambiarLetra(paso) {
    const i = NIVELES_LETRA.indexOf(leerLetra());
    const n = paso === 0 ? 100 : NIVELES_LETRA[Math.max(0, Math.min(NIVELES_LETRA.length - 1, i + paso))];
    try { n === 100 ? sessionStorage.removeItem(CLAVE_LETRA) : sessionStorage.setItem(CLAVE_LETRA, String(n)); } catch (_) { /* sin almacenamiento */ }
    aplicarLetra(n);
    return n;
  }
  aplicarLetra(leerLetra());

  function selectorLetra() {
    const valor = el("button", { type: "button", class: "letra-valor", title: "Volver al tamaño normal", text: leerLetra() + " %" });
    const cambiar = (paso) => (ev) => { ev.stopPropagation(); valor.textContent = cambiarLetra(paso) + " %"; };
    valor.addEventListener("click", cambiar(0));
    return el("div", { class: "menu-tema menu-letra" },
      el("span", { class: "menu-titulo", text: "Tamaño de la letra" }),
      el("div", { class: "letra-control", role: "group", "aria-label": "Tamaño de la letra" },
        el("button", { type: "button", "aria-label": "Letra más pequeña", text: "A−", onclick: cambiar(-1) }),
        valor,
        el("button", { type: "button", class: "letra-grande", "aria-label": "Letra más grande", text: "A+", onclick: cambiar(1) })));
  }

  function opcionPortapapeles() {
    const activo = preferenciaPortapapeles() === "si";
    return el("label", { class: "menu-interruptor", title: "Al volver a Axio con una cédula copiada en otro programa, te ofrece buscarla" },
      el("input", { type: "checkbox", checked: activo, onchange: async (ev) => {
        if (!ev.target.checked) { elegirPortapapeles("no"); return; }
        try { await navigator.clipboard.readText(); elegirPortapapeles("si"); }
        catch (_) { ev.target.checked = false; toast("El navegador no dio el permiso para leer lo copiado."); }
      } }),
      el("span", { text: "Ofrecer buscar la cédula que copie" }));
  }

  // ------------------------------------------------------------------ atajos (tecla «?»)
  const dialogoAtajos = el("dialog", { class: "dialogo-axio dialogo-atajos", "aria-labelledby": "atajos-titulo" });
  document.body.append(dialogoAtajos);
  dialogoAtajos.addEventListener("click", (ev) => { if (ev.target === dialogoAtajos || ev.target.closest("[data-cerrar]")) dialogoAtajos.close(); });

  function mostrarAtajos() {
    const teclas = (lista) => el("span", { class: "atajo-teclas" },
      ...lista.flatMap((t, i) => [i ? el("span", { class: "atajo-mas", text: "+" }) : null, el("kbd", { text: t })]).filter(Boolean));
    const grupo = (titulo, filas) => el("section", { class: "atajos-grupo" }, el("h3", { text: titulo }),
      el("ul", null, ...filas.map(([t, que]) => el("li", null, teclas(t), el("span", { text: que })))));
    const conVisor = typeof window.axioMejorarEnlace === "function";
    dialogoAtajos.replaceChildren(
      el("div", { class: "dialogo-axio-cabecera" },
        el("div", null, el("h2", { id: "atajos-titulo", text: "Atajos de teclado" }), el("span", { class: "dialogo-axio-sub", text: "Para trabajar sin soltar el teclado" })),
        el("button", { class: "boton boton-texto boton-cerrar", type: "button", "aria-label": "Cerrar", "data-cerrar": "", text: "✕" })),
      el("div", { class: "dialogo-axio-cuerpo atajos-grupos" },
        grupo("En toda la página", [
          [["/"], "Ir al buscador"], [["Ctrl", "K"], "Paleta de comandos"], [["Ctrl", "Shift", "H"], "Ocultar la pantalla"],
          [["D"], "Tu día"], [["?"], "Ver estos atajos"], [["Esc"], "Cerrar ventanas y menús"]]),
        grupo("Con una persona en pantalla", [
          [["L"], "Modo llamada"], [["1", "2", "3", "4"], "Resultado de la llamada (en el modo llamada)"],
          [["Enter"], "Buscar la cédula que copiaste (cuando Axio lo ofrece)"]]),
        conVisor ? grupo("En el visor de hojas", [
          [["Ctrl", "C"], "Copiar"], [["Ctrl", "V"], "Pegar"], [["Ctrl", "Z"], "Deshacer"], [["Ctrl", "F"], "Buscar en la hoja"],
          [["Enter"], "Escribir en la celda"], [["Alt", "↑ ↓"], "Cambiar de pestaña"], [["Ctrl", "rueda"], "Acercar o alejar"]]) : null));
    if (!dialogoAtajos.open) dialogoAtajos.showModal();
  }

  // ------------------------------------------------------------------ buscar varias cédulas
  // Se pega una lista (de Excel, un correo, un chat) y se ve el estado de todas a la vez:
  // nombre, créditos en mora, saldo en mora y último pago. Tocar una fila la busca; la tabla
  // se copia para pegarla en Excel. Pegar varias cédulas en el buscador también abre esto.
  const MAXIMO_LISTA = 200;
  const dialogoLista = el("dialog", { class: "dialogo-axio dialogo-lista", "aria-labelledby": "lista-titulo" });
  document.body.append(dialogoLista);
  dialogoLista.addEventListener("click", (ev) => { if (ev.target === dialogoLista || ev.target.closest("[data-cerrar]")) dialogoLista.close(); });
  dialogoLista.addEventListener("close", () => { if (dialogoLista.tarea) dialogoLista.tarea.cancelada = true; });

  function cedulasDeTexto(texto) {
    const vistas = new Set();
    for (const trozo of String(texto || "").replace(/(\d)\.(?=\d{3}\b)/g, "$1").split(/\D+/)) {
      if (trozo.length >= 6 && trozo.length <= 10) vistas.add(trozo);
    }
    return [...vistas];
  }
  const numeroDe = (v) => { const n = Number(String(v || "").replace(/[^\d,-]/g, "").replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };

  function abrirBuscarVarias(texto) {
    const area = el("textarea", { class: "lista-entrada", rows: "5", spellcheck: "false", "aria-label": "Cédulas a buscar",
      placeholder: "Pega aquí las cédulas: una por línea, o separadas por comas o espacios.\nSirve copiar una columna de Excel." });
    area.value = texto || "";
    const contador = el("span", { class: "lista-contador" });
    const actualizarContador = () => {
      const n = cedulasDeTexto(area.value).length;
      contador.textContent = n ? `${plural(Math.min(n, MAXIMO_LISTA), "cédula", "cédulas")}${n > MAXIMO_LISTA ? ` (de ${n}: máximo ${MAXIMO_LISTA})` : ""}` : "";
      botonBuscar.disabled = !n;
    };
    const botonBuscar = el("button", { class: "boton boton-principal boton-chico", type: "button", text: "Buscar todas", onclick: () => correrLista(cedulasDeTexto(area.value).slice(0, MAXIMO_LISTA)) });
    area.addEventListener("input", actualizarContador);
    area.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); botonBuscar.click(); } });
    const zona = el("div", { class: "lista-zona" });
    dialogoLista.replaceChildren(
      el("div", { class: "dialogo-axio-cabecera" },
        el("div", null, el("h2", { id: "lista-titulo", text: "Buscar varias cédulas" }),
          el("span", { class: "dialogo-axio-sub", text: "El estado de muchas personas de una vez" })),
        el("button", { class: "boton boton-texto boton-cerrar", type: "button", "aria-label": "Cerrar", "data-cerrar": "", text: "✕" })),
      el("div", { class: "dialogo-axio-cuerpo" },
        area,
        el("div", { class: "lista-barra" }, contador, botonBuscar),
        zona));
    actualizarContador();
    if (!dialogoLista.open) dialogoLista.showModal();
    if (texto && cedulasDeTexto(texto).length) botonBuscar.click(); else area.focus();

    async function correrLista(cedulas) {
      if (dialogoLista.tarea) dialogoLista.tarea.cancelada = true;
      const tarea = { cancelada: false };
      dialogoLista.tarea = tarea;
      const filas = cedulas.map((c) => ({ cedula: c, estado: "pendiente" }));
      const avance = el("div", { class: "lista-avance", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(filas.length) }, el("span"));
      const resumen = el("p", { class: "lista-resumen", "aria-live": "polite" });
      const cuerpoTabla = el("tbody");
      const soloMora = el("input", { type: "checkbox" });
      const copiarTabla = el("button", { class: "boton boton-chico", type: "button", text: "📋 Copiar tabla", disabled: true,
        title: "Para pegar en Excel o en Google Sheets",
        onclick: (ev) => copiar(tsvLista(filas), "Tabla copiada: pégala en Excel o en Google Sheets.", ev.currentTarget) });
      soloMora.addEventListener("change", pintar);
      zona.replaceChildren(avance, resumen,
        el("div", { class: "lista-tabla-envoltura" },
          el("table", { class: "lista-tabla" },
            el("thead", null, el("tr", null, ...["Cédula", "Nombre", "Estado", "Saldo en mora", "Último pago"].map((t) => el("th", { text: t })))),
            cuerpoTabla)),
        el("div", { class: "lista-barra" }, el("label", { class: "lista-filtro" }, soloMora, " Solo las que tienen mora"), copiarTabla));

      function pintar() {
        cuerpoTabla.replaceChildren(...filas.filter((f) => !soloMora.checked || f.mora > 0).map((f) => {
          const clase = f.estado === "pendiente" ? "cargando" : f.estado === "error" ? "error" : f.mora > 0 ? "mora" : f.creditos ? "dia" : f.nombre ? "neutro" : "nada";
          const tr = el("tr", { class: "lista-" + clase, tabindex: f.nombre ? "0" : null, title: f.nombre ? "Buscar a esta persona" : null },
            el("td", { class: "num", text: formatoMiles.format(Number(f.cedula)) }),
            el("td", { text: f.estado === "pendiente" ? "…" : f.nombre ? nombrePropio(f.nombre) : f.estado === "error" ? "No se pudo buscar" : "—" }),
            el("td", null, el("span", { class: "lista-estado", text: f.textoEstado || (f.estado === "pendiente" ? "Buscando…" : "") })),
            el("td", { class: "num", text: f.saldoMora ? pesos(f.saldoMora) : "" }),
            el("td", { text: f.ultimoPago || "" }));
          if (f.nombre) {
            const ir = () => { dialogoLista.close(); campo.value = f.cedula; buscar(); };
            tr.addEventListener("click", ir);
            tr.addEventListener("keydown", (ev) => { if (ev.key === "Enter") ir(); });
          }
          return tr;
        }));
      }

      pintar();
      let hechas = 0;
      const siguiente = async () => {
        for (let f = filas.find((x) => x.estado === "pendiente" && !x.tomada); f && !tarea.cancelada; f = filas.find((x) => x.estado === "pendiente" && !x.tomada)) {
          f.tomada = true;
          try {
            let r = await apiJson("/api/buscar?q=" + encodeURIComponent(f.cedula));
            for (let intento = 0; r.status === 202 && intento < 30 && !tarea.cancelada; intento++) {   // las hojas aún cargan
              await new Promise((ok) => setTimeout(ok, 2000));
              r = await apiJson("/api/buscar?q=" + encodeURIComponent(f.cedula));
            }
            const a = r.datos && r.datos.asociado;
            if (a) {
              const todos = creditosDe(a);
              const enMora = todos.filter((x) => x.estado.mora);
              const ultimo = (a.pagos || []).find((p) => p.fecha);
              Object.assign(f, {
                estado: "ok", nombre: a.nombre || "(sin nombre)", mora: enMora.length, creditos: todos.length,
                saldoMora: enMora.reduce((s, x) => s + numeroDe(x.e.saldo_actual || x.e.saldo), 0),
                textoEstado: enMora.length ? `🔴 ${plural(enMora.length, "en mora", "en mora")}` : todos.length ? "🟢 Al día" : "⚪ Sin créditos",
                ultimoPago: ultimo ? `${fechaCorta(aFecha(ultimo.fecha))}${ultimo.valor ? " · " + pesos(ultimo.valor) : ""}` : "",
              });
            } else {
              const enExtractos = r.datos && (r.datos.grupos || []).some((g) => (g.filas || []).length);
              Object.assign(f, { estado: "ok", nombre: "", mora: 0, textoEstado: enExtractos ? "Solo en Extractos" : "No encontrada" });
            }
          } catch (_) {
            Object.assign(f, { estado: "error", textoEstado: "⚠️ Error" });
          }
          hechas += 1;
          avance.firstChild.style.width = `${(hechas / filas.length) * 100}%`;
          avance.setAttribute("aria-valuenow", String(hechas));
          resumen.textContent = hechas < filas.length ? `Buscando… ${hechas} de ${filas.length}` : "";
          pintar();
        }
      };
      await Promise.all([siguiente(), siguiente(), siguiente()]);
      if (tarea.cancelada) return;
      const conMora = filas.filter((f) => f.mora > 0);
      const sinFicha = filas.filter((f) => f.estado === "ok" && !f.nombre).length;
      resumen.textContent = `${plural(filas.length, "cédula", "cédulas")} · ${plural(conMora.length, "con mora", "con mora")}`
        + (conMora.length ? ` (${pesos(conMora.reduce((s, f) => s + f.saldoMora, 0))})` : "") + (sinFicha ? ` · ${sinFicha} sin ficha` : "");
      avance.classList.add("listo");
      copiarTabla.disabled = false;
      anotarAccion({ tipo: "lista", texto: `Búsqueda por lista: ${plural(filas.length, "cédula", "cédulas")}` }, null);
    }
  }

  function tsvLista(filas) {
    const lineas = [["Cédula", "Nombre", "Estado", "Créditos en mora", "Saldo en mora", "Último pago"].join("\t")];
    for (const f of filas) {
      lineas.push([f.cedula, nombrePropio(f.nombre) || "", (f.textoEstado || "").replace(/^\S+\s/, ""), f.mora || 0, f.saldoMora ? Math.round(f.saldoMora) : "", f.ultimoPago || ""].join("\t"));
    }
    return lineas.join("\n");
  }

  // Pegar varias cédulas en el buscador abre la búsqueda por lista con ellas.
  campo.addEventListener("paste", (ev) => {
    const texto = (ev.clipboardData || window.clipboardData).getData("text");
    if (cedulasDeTexto(texto).length < 2) return;
    ev.preventDefault();
    abrirBuscarVarias(texto);
  });

  const formSalir = document.querySelector('form[action$="logout"]');
  if (formSalir) formSalir.addEventListener("submit", olvidarDia);

  // ------------------------------------------------------------------ ocultar la pantalla
  // La sesión puede quedar abierta toda la jornada: si alguien se acerca al puesto, los saldos
  // y las cédulas no deberían quedar a la vista (Ley 1581). Ctrl+Shift+H, el botón del ojo o
  // la paleta los tapan con un velo desenfocado, sin cerrar la sesión ni perder nada. También
  // sale solo tras data-velo minutos sin tocar la página (5 por defecto; 0 = nunca). Cualquier
  // tecla o clic lo quita. Es un <dialog> modal: queda encima de todo, también de las ventanas
  // ya abiertas (el detalle, el visor de hojas), y bloquea la página mientras está puesto.
  const MINUTOS_VELO = Number(document.body.dataset.velo ?? 5);
  const logoVelo = document.querySelector(".logo-barra svg");
  const velo = el("dialog", { class: "velo-privacidad", "aria-label": "Pantalla oculta" },
    el("div", { class: "velo-tarjeta" },
      logoVelo ? el("span", { class: "velo-logo", "aria-hidden": "true" }, logoVelo.cloneNode(true)) : null,
      el("strong", { class: "velo-titulo", text: "Pantalla oculta" }),
      el("span", { class: "velo-texto", text: "Tu sesión sigue abierta y nada se perdió. Toca cualquier tecla o haz clic para volver." }),
      el("span", { class: "velo-atajo" }, "Para ocultarla otra vez: ", el("kbd", { text: "Ctrl" }), " + ", el("kbd", { text: "Shift" }), " + ", el("kbd", { text: "H" }))));
  document.body.append(velo);
  let ultimoMovimiento = Date.now();

  function mostrarVelo() {
    if (velo.open) return;
    // Lo que flota en la capa superior (sugerencias, tarjeta de una hoja) se cierra antes.
    document.querySelectorAll(":popover-open").forEach((p) => { try { p.hidePopover(); } catch (_) { /* ya cerrado */ } });
    velo.showModal();
  }
  function quitarVelo() {
    if (!velo.open) return;
    velo.classList.add("saliendo");
    setTimeout(() => { velo.classList.remove("saliendo"); velo.close(); }, 220);
    ultimoMovimiento = Date.now();
  }
  // Con el velo puesto, la primera tecla o el primer clic solo lo quitan: no llegan a la
  // página (una letra no se escribe en el buscador, un clic no abre una fila).
  window.addEventListener("keydown", (ev) => {
    if (velo.open) {
      if (["Shift", "Control", "Alt", "Meta"].includes(ev.key)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      quitarVelo();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.code === "KeyH") {
      ev.preventDefault();
      mostrarVelo();
    }
  }, true);
  velo.addEventListener("click", quitarVelo);
  velo.addEventListener("cancel", (ev) => { ev.preventDefault(); quitarVelo(); });

  for (const evento of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
    document.addEventListener(evento, () => { if (!velo.open) ultimoMovimiento = Date.now(); }, { capture: true, passive: true });
  }
  if (MINUTOS_VELO > 0) {
    const revisarVelo = () => { if (Date.now() - ultimoMovimiento >= MINUTOS_VELO * 60000) mostrarVelo(); };
    setInterval(revisarVelo, 5000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) revisarVelo(); });
  }

  // El botón del ojo, en la barra de arriba, junto al nombre de la persona.
  const ojoTachado = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ojoTachado.setAttribute("viewBox", "0 0 24 24");
  ojoTachado.setAttribute("aria-hidden", "true");
  for (const d of ["M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94", "M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19",
    "M14.12 14.12a3 3 0 1 1-4.24-4.24", "M1 1l22 22"]) {
    const trazo = document.createElementNS("http://www.w3.org/2000/svg", "path");
    trazo.setAttribute("d", d);
    ojoTachado.append(trazo);
  }
  if (zonaUsuario) {
    zonaUsuario.before(el("button", { class: "boton boton-texto boton-velo", type: "button", title: "Ocultar la pantalla (Ctrl+Shift+H)",
      "aria-label": "Ocultar la pantalla", onclick: mostrarVelo }, ojoTachado, el("span", { class: "boton-velo-texto", text: "Ocultar" })));
  }

  // ------------------------------------------------------------------ eventos
  form.addEventListener("submit", (ev) => { ev.preventDefault(); buscar(); });
  let temporizadorFiltro = null;
  filtro.addEventListener("input", () => { clearTimeout(temporizadorFiltro); temporizadorFiltro = setTimeout(pintarResultados, 150); });
  ocultarVacias.addEventListener("change", pintarResultados);
  $("#btn-exportar").addEventListener("click", exportar);
  dialogo.addEventListener("click", (ev) => {
    if (ev.target === dialogo || ev.target.closest("[data-cerrar]")) cerrarDetalle();
  });
  // Esc también vuelve a la fila de donde salió. Se atrapa la tecla antes que el navegador:
  // si no, a veces cierra la ventana por su cuenta, sin la transición.
  dialogo.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || ev.target.closest("dialog") !== dialogo) return;
    ev.preventDefault();
    cerrarDetalle();
  });
  dialogo.addEventListener("cancel", (ev) => { ev.preventDefault(); cerrarDetalle(); });

  pintarRecientes();
  cargarEstado();
})();
