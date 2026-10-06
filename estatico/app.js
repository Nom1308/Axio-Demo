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
  let alTerminarCarga = null;   // búsqueda a repetir cuando terminen de cargar los datos

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
      zona.append(el("span", { text: `☁️ Extractos: ${formatoMiles.format(m.filas)} filas · ${haceCuanto(m.hora)}` }));
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

    if (est.cargando) {
      programarSondeo();
    } else if (alTerminarCarga) {
      // Una búsqueda quedó esperando a que cargaran los datos: se lanza ahora.
      const pendiente = alTerminarCarga;
      alTerminarCarga = null;
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
      busqueda = datos;
      filtro.value = "";
      guardarReciente(termino);
      pintarResultados();
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
    for (const f of filas) {
      const coinciden = new Set(f.m);
      // La fila entera va del color de su estado de pago, igual que en la Matriz_Nube.
      const tr = el("tr", { class: f.e ? "fila-" + f.e : null, tabindex: "0", onclick: () => abrirDetalle(f.i), onkeydown: (ev) => { if (ev.key === "Enter") abrirDetalle(f.i); } });
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
  async function abrirDetalle(i) {
    cuerpoDetalle.replaceChildren(el("p", { class: "gris", text: "Cargando…" }));
    if (!dialogo.open) dialogo.showModal();
    try {
      const { datos } = await apiJson(`/api/detalle/${encodeURIComponent(busqueda.id)}/${i}`);
      pintarDetalle(datos);
    } catch (e) {
      cuerpoDetalle.replaceChildren(el("p", { class: "aviso aviso-error", text: e.message }));
    }
  }

  function pintarDetalle(d) {
    const partes = [el("p", { class: "fuente-detalle", text: "📂 " + d.fuente })];

    if (d.estado_pago) {
      partes.push(el("div", { class: "estado-pago", style: `background:${d.estado_pago.color}` },
        `${d.estado_pago.icono} ${d.estado_pago.etiqueta}`));
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

    const campos = el("div", { class: "campos" });
    for (const c of d.campos) {
      const entrada = el("input", { readonly: true, "aria-label": c.columna });
      entrada.value = c.valor || "—";
      campos.append(el("div", { class: "campo" },
        el("span", { class: "nombre", text: c.columna }),
        entrada,
        el("button", { class: "boton boton-chico", type: "button", title: "Copiar", text: "📋", onclick: () => copiar(c.valor, "Copiado.") })));
    }
    partes.push(el("div", null, el("h3", { class: "gris", style: "margin:4px 0 8px;font-size:13px", text: "Todos los campos" }), campos));

    const textoCompleto = d.campos.map((c) => `${c.columna}: ${c.valor}`).join("\n");
    partes.push(el("div", { class: "pie-detalle" },
      el("button", { class: "boton", type: "button", text: "📋 Copiar todo el detalle", onclick: () => copiar(textoCompleto, "Detalle copiado.") }),
      el("button", { class: "boton boton-principal", type: "button", text: "Cerrar", onclick: () => dialogo.close() })));

    cuerpoDetalle.replaceChildren(...partes);
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
        a.whatsapp ? botonWhatsapp(a.whatsapp) : null));

    const creditos = el("div", { class: "asociado-creditos" });
    for (const linea of a.lineas) {
      for (const e of linea.entradas) creditos.append(pintarCredito(linea.linea, e, true));
    }
    const titulo = a.total_creditos
      ? `💳 ${a.total_creditos} crédito${a.total_creditos === 1 ? "" : "s"} activo${a.total_creditos === 1 ? "" : "s"}`
      : "💳 Sin créditos activos en las líneas de crédito";
    return el("section", { class: "asociado" }, cabecera,
      el("h3", { class: "asociado-titulo", text: titulo }),
      a.total_creditos ? creditos : null);
  }

  function pintarCredito(nombreLinea, e, comoTarjeta) {
    const descripcion = [];
    if (e.congregacion) descripcion.push(e.congregacion);
    if (e.cco) descripcion.push("CCO " + e.cco);
    if (e.distrito) descripcion.push("Distrito " + e.distrito);

    const enlaces = el("div", { class: "credito-enlaces" });
    if (e.link_registro) {
      enlaces.append(el("a", { class: "boton boton-chico", href: e.link_registro, target: "_blank", rel: "noopener noreferrer", text: "🔗 Último registro" }));
    }
    if (e.link_obligacion && e.link_obligacion !== e.link_registro) {
      enlaces.append(el("a", { class: "boton boton-chico", href: e.link_obligacion, target: "_blank", rel: "noopener noreferrer", text: "🔗 Ver obligación" }));
    }

    const fila = el("div", { class: "credito-cabecera" },
      el("span", { class: "insignia", text: "ACTIVO" }),
      el("div", { class: "credito-titulo" },
        el("strong", { text: nombreLinea + (e.tipo_credito && e.tipo_credito !== nombreLinea ? " · " + e.tipo_credito : "") }),
        descripcion.length ? el("span", { text: descripcion.join("  ·  ") }) : null),
      enlaces.childElementCount ? enlaces : null);
    const nodo = el("div", { class: comoTarjeta ? "credito credito-tarjeta" : "credito" }, fila);

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
      if (e.tarifa) cifras.append(el("span", { text: "💵 Tarifa: " + e.tarifa }));
      if (e.saldo) cifras.append(el("span", { text: "💰 Saldo: " + e.saldo }));
      if (e.meses_mora) cifras.append(el("span", { class: e.en_mora ? "mora-si" : "mora-no", text: "📅 Meses en mora: " + e.meses_mora }));
      extra.append(cifras);
      if (e.observacion_directivos) extra.append(el("em", { text: "📝 Directivos: " + e.observacion_directivos }));
      if (e.observacion_general) extra.append(el("em", { text: "📝 General: " + e.observacion_general }));
      nodo.append(extra);
    }
    return nodo;
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
