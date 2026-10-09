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
  async function copiar(texto, mensaje) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(texto);
      } else {
        const area = el("textarea", { readonly: true, style: "position:fixed;opacity:0" });
        area.value = texto;
        (dialogo.open ? dialogo : document.body).append(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      toast(mensaje || "Copiado.");
    } catch (_) {
      toast("No se pudo copiar.");
    }
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

    if (est.cargando) {
      zona.append(el("span", { text: "⏳ " + (est.mensaje_carga || "Cargando datos...") }));
    }
    if (!m.configurada) {
      zona.append(el("span", { class: "ambar", text: "⚠️ No hay URL de los Extractos (Matriz_Nube) en config_axio.json del servidor." }));
    } else if (m.error) {
      zona.append(el("span", { class: "error", text: "❌ Los Extractos no se pudieron cargar" }));
    } else if (m.filas) {
      const casilla = el("input", { type: "checkbox", id: "ver-tabla" });
      casilla.checked = !ventanaTabla.hidden;
      casilla.addEventListener("change", () => (casilla.checked ? abrirTabla() : cerrarTabla()));
      zona.append(el("span", { text: `☁️ Extractos: ${formatoMiles.format(m.filas)} filas · ${haceCuanto(m.hora)}` }),
        el("label", { class: "interruptor interruptor-tabla", title: "Muestra debajo los Extractos completos, tal cual la hoja, con filtros en los encabezados" },
          casilla, " Ver todos los pagos"));
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
    zona.hidden = !lista.length;
    if (!lista.length) return;
    zona.append(el("span", { text: "Recientes:" }));
    for (const t of lista) {
      zona.append(el("button", { type: "button", text: t, onclick: () => { campo.value = t; buscar(); } }));
    }
  }

  // ------------------------------------------------------------------ búsqueda
  async function buscar() {
    const termino = campo.value.trim();
    if (!termino) { campo.focus(); return; }
    btnBuscar.disabled = true;
    btnBuscar.textContent = "Buscando…";
    estadoBusqueda.className = "estado-busqueda";
    estadoBusqueda.textContent = "Buscando…";
    try {
      const { status, datos } = await apiJson("/api/buscar?q=" + encodeURIComponent(termino));
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
    if (busqueda.asociado) zonaAsociado.append(pintarAsociado(busqueda.asociado));

    if (!busqueda.grupos.length) {
      barraResultados.hidden = true;
      estadoBusqueda.className = "estado-busqueda";
      estadoBusqueda.replaceChildren(`Sin resultados para «${busqueda.termino}».`);
      if (busqueda.sugerencia) {
        estadoBusqueda.append(" ", el("span", { class: "sugerencia" }, "¿Quisiste decir ",
          el("button", { type: "button", text: busqueda.sugerencia, onclick: () => { campo.value = busqueda.sugerencia; buscar(); } }), "?"));
      }
      return;
    }

    barraResultados.hidden = false;
    estadoBusqueda.textContent = "";
    const n = busqueda.total;
    $("#resumen").textContent = `${formatoMiles.format(n)} resultado${n === 1 ? "" : "s"} para «${busqueda.termino}» en ${busqueda.grupos.length} fuente${busqueda.grupos.length === 1 ? "" : "s"}`;

    const textoFiltro = normalizar(filtro.value.trim());
    let visibles = 0;
    for (const g of busqueda.grupos) {
      const nodo = pintarGrupo(g, textoFiltro);
      if (nodo) { contenedor.append(nodo); visibles++; }
    }
    if (!visibles) estadoBusqueda.textContent = "Ningún resultado coincide con el filtro.";
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
      const tr = el("tr", { class: f.e ? "fila-" + f.e : null, tabindex: "0", style: n < 40 ? `--i:${n++}` : null, onclick: () => abrirDetalle(f.i), onkeydown: (ev) => { if (ev.key === "Enter") abrirDetalle(f.i); } });
      if (conEstado) {
        tr.append(el("td", { class: "estado" }, f.e ? el("span", { class: "punto e-" + f.e, title: ESTADOS[f.e] || f.e }) : null));
      }
      for (const j of indicesCols) {
        const v = f.v[j];
        const clases = [coinciden.has(j) ? "coincide" : "", /^-?[\d,]+(\.\d+)?$/.test(v) ? "num" : ""].join(" ").trim();
        tr.append(el("td", { class: clases || null, title: v.length > 30 ? v : null, text: v }));
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
  function abrirDetalle(i) {
    return abrirDetalleDe(`/api/detalle/${encodeURIComponent(busqueda.id)}/${i}`);
  }

  async function abrirDetalleDe(url) {
    cuerpoDetalle.replaceChildren(el("p", { class: "gris", text: "Cargando…" }));
    if (!dialogo.open) dialogo.showModal();
    try {
      const { datos } = await apiJson(url);
      pintarDetalle(datos);
    } catch (e) {
      cuerpoDetalle.replaceChildren(el("p", { class: "aviso aviso-error", text: e.message }));
    }
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
          el("button", { class: "boton boton-chico", type: "button", title: "Copiar", text: "📋", onclick: () => copiar(c.valor, "Copiado.") }))));
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
    const mostrarEstado = (e) => {
      estado.style.display = e ? "" : "none";
      if (e) { estado.style.background = e.color; estado.textContent = `${e.icono} ${e.etiqueta}`; }
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
          el("button", { class: "boton boton-chico", type: "button", text: "Copiar", onclick: () => copiar(d.encargado.extension, "Extensión copiada.") })));
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
          onclick: () => copiar(d.cedula_limpia || d.cedula, "Cédula copiada, lista para pegar en Siasoft.") }),
        d.whatsapp ? botonWhatsapp(d.whatsapp) : null));
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
      el("button", { class: "boton", type: "button", text: "📋 Copiar todo el detalle", onclick: () => copiar(textoCompleto, "Detalle copiado.") }),
      el("button", { class: "boton boton-principal", type: "button", text: "Cerrar", onclick: () => dialogo.close() })));

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

  function abrirObligacion(nombreLinea, e) {
    const desdePago = dialogo.open && ultimoDetalle ? ultimoDetalle : null;
    if (!dialogo.open) dialogo.showModal();
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
      el("button", { class: "boton", type: "button", text: "📋 Copiar todo", onclick: () => copiar(textoCompleto, "Obligación copiada.") }),
      el("button", { class: "boton boton-principal", type: "button", text: "Cerrar", onclick: () => dialogo.close() })));

    cuerpoDetalle.replaceChildren(...partes);
    dialogo.scrollTop = 0;
  }

  function botonWhatsapp(enlace) {
    return el("a", { class: "boton boton-whatsapp boton-chico", href: enlace, target: "_blank", rel: "noopener noreferrer",
      title: "Abrir el chat de WhatsApp de esta persona", text: "💬 WhatsApp" });
  }

  function pintarAsociado(a) {
    const inicial = (a.nombre || "?").trim().charAt(0).toUpperCase();
    const cabecera = el("div", { class: "asociado-cabecera" },
      el("span", { class: "asociado-avatar", "aria-hidden": "true", text: inicial }),
      el("div", { class: "asociado-nombre" },
        el("strong", { text: a.nombre || "Asociado" }),
        el("span", { text: "🪪 CC " + a.cedula })),
      el("div", { class: "asociado-acciones" },
        el("button", { class: "boton boton-chico", type: "button", text: "📋 Copiar cédula",
          onclick: () => copiar(a.cedula_limpia, "Cédula copiada, lista para pegar en Siasoft.") }),
        a.whatsapp ? botonWhatsapp(a.whatsapp) : null,
        el("button", { class: "boton boton-chico", type: "button", text: "🖨️ Imprimir ficha",
          title: "Imprime solo esta ficha. En la ventana de impresión se puede elegir «Guardar como PDF».",
          onclick: imprimirFicha })));

    // Primero los créditos en mora (lo que hay que gestionar), después los demás; dentro de
    // cada grupo, en el orden de las líneas.
    const todos = a.lineas.flatMap((l) => l.entradas.map((e) => ({ linea: l.linea, e, estado: estadoCredito(e) })));
    const peso = (x) => (x.estado.mora ? 0 : x.estado.mora === null ? 1 : 2);
    todos.sort((x, y) => peso(x) - peso(y));
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
    return el("section", { class: "asociado" + (enMora ? " asociado-con-mora" : "") }, membrete, cabecera,
      el("div", { class: "asociado-resumen" },
        el("h3", { class: "asociado-titulo" }, titulo),
        enMora ? el("span", { class: "asociado-mora", text: `🔴 ${enMora} en mora` }) : null,
        alDia && enMora ? el("span", { class: "asociado-dia", text: `🟢 ${alDia} al día` }) : null,
        barra),
      a.total_creditos ? creditos : null, pie);
  }

  function imprimirFicha() {
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
      onclick: conDetalle ? () => abrirObligacion(nombreLinea, e) : null,
      onkeydown: conDetalle ? (ev) => { if (ev.key === "Enter") abrirObligacion(nombreLinea, e); } : null,
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
      onclick: conDetalle ? () => abrirObligacion(nombreLinea, e) : null,
      onkeydown: conDetalle ? (ev) => { if (ev.key === "Enter") abrirObligacion(nombreLinea, e); } : null,
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
  const ventanaTabla = el("section", { class: "tabla-completa", "aria-labelledby": "tc-titulo", hidden: true });
  $(".panel-busqueda").after(ventanaTabla);
  const tc = {
    columnas: [], anchos: [], filtros: {}, orden: null, total: 0, filtradas: 0, hora: null,
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

  async function abrirTabla() {
    if (!ventanaTabla.hidden) return;
    recordarTabla(true);
    tc.filtros = {};
    tc.orden = null;
    tc.columnas = [];
    ventanaTabla.replaceChildren(
      el("div", { class: "tc-barra" },
        el("div", { class: "tc-titulos" },
          el("h2", { id: "tc-titulo", text: "Extractos · todos los pagos" }),
          el("span", { class: "tc-conteo", "aria-live": "polite" })),
        el("button", { class: "boton boton-chico tc-quitar", type: "button", text: "Quitar filtros", hidden: true, onclick: quitarFiltros }),
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
    if (tc.menu && !tc.menu.contains(ev.target) && !(ev.target instanceof Element && ev.target.closest(".tc-th"))) cerrarMenuFiltro();
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
      if (tr) abrirDetalleDe(`/api/tabla/detalle/${tr.dataset.p}`);
    });
    tabla.addEventListener("keydown", (ev) => {
      const tr = ev.target.closest("tbody tr[data-p]");
      if (tr && ev.key === "Enter") abrirDetalleDe(`/api/tabla/detalle/${tr.dataset.p}`);
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
      const que = f.texto !== undefined ? `contiene «${f.texto}»`
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
          marcados = new Set(lista.filter((x) => !actual || actual.texto !== undefined || (actual.valores ? actual.valores.includes(x.v) : !actual.excluir.includes(x.v))).map((x) => x.v));
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

    menu.replaceChildren(
      el("div", { class: "menu-cabecera" },
        el("span", { class: "avatar", "aria-hidden": "true", text: (nombre || "?").trim().charAt(0).toUpperCase() }),
        el("div", { class: "menu-quien" }, el("strong", { text: nombre }), correo ? el("span", { text: correo }) : null)),
      el("p", { class: "menu-titulo", text: fuentes.length
        ? `Hojas conectadas · ${conectadas} de ${fuentes.length}` : "Hojas conectadas" }),
      lista,
      ES_ADMIN ? el("div", { class: "menu-pie" },
        el("button", { class: "boton boton-chico", type: "button", text: "↻ Refrescar datos", disabled: Boolean(est.cargando),
          onclick: refrescar })) : null);
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

  // ------------------------------------------------------------------ atajos de teclado
  // «/» o Ctrl+K: al buscador, con el texto seleccionado para escribir encima. No se activan
  // mientras se escribe en otro campo ni con una ventana abierta (detalle, visor de hojas),
  // que tienen su propio teclado. Esc ya cierra las ventanas (lo hace el navegador).
  const escribiendo = (n) => n && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || document.querySelector("dialog[open]")) return;
    const ctrlK = (ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === "k" || ev.key === "K");
    const barra = ev.key === "/" && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !escribiendo(ev.target);
    if (!ctrlK && !barra) return;
    ev.preventDefault();
    campo.focus();
    campo.select();
  });
  campo.title = "Atajo: / o Ctrl+K";

  // ------------------------------------------------------------------ cierre por inactividad
  // Un equipo que queda abierto con una cédula en pantalla deja datos personales a la vista
  // (Ley 1581). Tras data-inactividad minutos sin tocar la página (0 = nunca), se avisa un
  // minuto antes y luego se cierra la sesión: en el servidor, el mismo «Salir»; en la
  // versión de navegador, window.axioCerrarSesion (devuelve el token y borra la memoria).
  // Se mide con la hora y no con un temporizador largo: con la pestaña en segundo plano el
  // navegador frena los temporizadores, y al volver se cierra en el acto si ya venció.
  const MINUTOS_INACTIVIDAD = Number(document.body.dataset.inactividad || 0);
  if (MINUTOS_INACTIVIDAD > 0) {
    const LIMITE = MINUTOS_INACTIVIDAD * 60000;
    const AVISO = Math.min(60000, LIMITE / 2);
    let ultimaActividad = Date.now();
    let aviso = null;

    const cerrarSesion = () => {
      if (typeof window.axioCerrarSesion === "function") return window.axioCerrarSesion("inactividad");
      const salir = document.querySelector('form[action$="logout"]');
      if (!salir) { window.location.href = "/login"; return; }
      salir.append(el("input", { type: "hidden", name: "motivo", value: "inactividad" }));
      salir.submit();
    };
    const quitarAviso = () => { if (aviso) { aviso.remove(); aviso = null; } };
    const actividad = () => { ultimaActividad = Date.now(); quitarAviso(); };
    for (const evento of ["pointerdown", "keydown", "wheel", "touchstart"]) {
      document.addEventListener(evento, actividad, { capture: true, passive: true });
    }

    const revisar = () => {
      const quedan = LIMITE - (Date.now() - ultimaActividad);
      if (quedan <= 0) { clearInterval(reloj); quitarAviso(); cerrarSesion(); return; }
      if (quedan > AVISO) return;
      const segundos = Math.ceil(quedan / 1000);
      if (aviso && !aviso.isConnected) aviso = null;   // se fue con la ventana que lo tenía
      if (!aviso) {
        aviso = el("div", { class: "aviso-inactividad", role: "alertdialog", "aria-live": "assertive" },
          el("strong", { text: "¿Sigues ahí?" }),
          el("span", { class: "aviso-inactividad-texto" }),
          el("button", { class: "boton boton-principal boton-chico", type: "button", text: "Seguir aquí", onclick: actividad }));
        (document.querySelector("dialog[open]") || document.body).append(aviso);
      }
      aviso.querySelector(".aviso-inactividad-texto").textContent =
        `Por seguridad, la sesión se cerrará en ${segundos} s por inactividad.`;
    };
    const reloj = setInterval(revisar, 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) revisar(); });
  }

  // ------------------------------------------------------------------ eventos
  form.addEventListener("submit", (ev) => { ev.preventDefault(); buscar(); });
  let temporizadorFiltro = null;
  filtro.addEventListener("input", () => { clearTimeout(temporizadorFiltro); temporizadorFiltro = setTimeout(pintarResultados, 150); });
  ocultarVacias.addEventListener("change", pintarResultados);
  $("#btn-exportar").addEventListener("click", exportar);
  dialogo.addEventListener("click", (ev) => {
    if (ev.target === dialogo || ev.target.closest("[data-cerrar]")) dialogo.close();
  });

  pintarRecientes();
  cargarEstado();
})();
