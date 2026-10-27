/* Axio demo: las hojas de Google de cada obligación, sin salir de Axio.
 *
 * - Al pasar el mouse por un enlace a una hoja (🔗 Ver obligación, ↗ de un campo), una
 *   tarjeta con su miniatura, nombre, propietario y si se puede editar.
 * - Al hacer clic, la tabla se abre en una ventana dentro de Axio tal como se ve en Google
 *   Sheets: colores, bordes, celdas combinadas, filas/columnas ocultas e inmovilizadas y
 *   pestañas. Se navega con el teclado, con el cuadro de nombre (B13 + Enter) y con zoom.
 *   Doble clic, Enter o empezar a escribir edita una celda; Enter guarda en la hoja real.
 *
 * Todo pasa con la cuenta de quien inició sesión (window.axioGoogle, de puente.js): Google
 * aplica sus permisos. Quien solo puede ver la hoja, la ve en solo lectura. Sin sesión, los
 * enlaces se quedan como enlaces normales.
 */
(function () {
  "use strict";

  const MAX_FILAS = 300;
  const MAX_COLUMNAS = 40;
  const google = () => window.axioGoogle;

  // ------------------------------------------------------------------ utilidades
  function nodo(etiqueta, props, ...hijos) {
    const n = document.createElement(etiqueta);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "style") n.style.cssText = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const h of hijos) if (h !== null && h !== undefined && h !== false) n.append(h instanceof Node ? h : String(h));
    return n;
  }

  function idDeArchivo(url) {
    const m = /\/(?:spreadsheets|file|document|presentation)\/d\/([\w-]{20,})/.exec(url) || /[?&]id=([\w-]{20,})/.exec(url);
    return m ? m[1] : null;
  }
  const gidDe = (url) => { const m = /[#&?]gid=(\d+)/.exec(url); return m ? Number(m[1]) : null; };
  // «…#gid=1&range=A1520:AF1520» -> { fila: 1519, col: 0, colFin: 31 } (desde 0). Así llega
  // «Ver obligación» de Seguro de Vida: a la fila de la persona en la hoja maestra.
  function destinoDe(url) {
    const r = /[#&?]range=([^&]+)/.exec(url || "");
    const m = r && /^\$?([a-z]{1,3})\$?(\d{1,7})(?::\$?([a-z]{1,3})\$?(\d{1,7}))?$/i.exec(decodeURIComponent(r[1]));
    if (!m) return null;
    const col = columnaDeLetras(m[1]);
    return { fila: Number(m[2]) - 1, col, colFin: m[3] ? columnaDeLetras(m[3]) : col };
  }
  const letra = (i) => { let s = ""; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  const rango = (hoja, fila, col) => `'${hoja.replace(/'/g, "''")}'!${letra(col)}${fila + 1}`;
  const color = (c) => c ? `rgb(${Math.round((c.red || 0) * 255)},${Math.round((c.green || 0) * 255)},${Math.round((c.blue || 0) * 255)})` : null;

  async function apiGoogle(url, opciones = {}) {
    const token = await google().token();
    const resp = await fetch(url, { ...opciones, headers: { Authorization: "Bearer " + token, ...(opciones.headers || {}) } });
    if (resp.ok) return resp.json();
    let detalle = "";
    try { detalle = ((await resp.json()).error || {}).message || ""; } catch (_) { /* sin cuerpo */ }
    if (/has not been used|is disabled/i.test(detalle)) {
      throw new Error("la API de Google Sheets no está habilitada en el proyecto de Axio en Google Cloud. Pídele a sistemas que la habilite");
    }
    if (resp.status === 403 && /insufficient.*scope/i.test(detalle)) {
      throw new Error("no aceptaste el permiso para editar hojas. Cierra sesión y vuelve a entrar marcando ese permiso");
    }
    if (resp.status === 403 || resp.status === 404) throw new Error("tu cuenta de Google no tiene acceso a esta hoja");
    throw new Error(`Google respondió ${resp.status}${detalle ? ": " + detalle : ""}`);
  }

  // Datos del archivo en Drive: nombre, propietario, miniatura y si esta persona lo puede editar.
  const cacheArchivos = new Map();
  function datosArchivo(id) {
    if (!cacheArchivos.has(id)) {
      const campos = "name,mimeType,modifiedTime,thumbnailLink,webViewLink,owners(displayName),capabilities(canEdit)";
      const promesa = apiGoogle(`https://www.googleapis.com/drive/v3/files/${id}?fields=${encodeURIComponent(campos)}&supportsAllDrives=true`);
      promesa.catch(() => cacheArchivos.delete(id));
      cacheArchivos.set(id, promesa);
    }
    return cacheArchivos.get(id);
  }
  const esHojaDeCalculo = (a) => a.mimeType === "application/vnd.google-apps.spreadsheet";
  // Un .xlsx guardado en Drive: Google lo abre en su editor, pero la API de Sheets no lo lee.
  const esExcel = (a) => /spreadsheetml|ms-excel/.test(a.mimeType || "");

  // ------------------------------------------------------------------ vista previa
  // popover="manual": se dibuja en la capa superior, encima del detalle (que es un <dialog>).
  const tarjeta = nodo("div", { class: "hoja-previa", popover: "manual" });
  document.body.append(tarjeta);
  let temporizador = null;
  let enlaceActual = null;

  function ocultarPrevia() {
    clearTimeout(temporizador);
    enlaceActual = null;
    try { tarjeta.hidePopover(); } catch (_) { /* ya oculta */ }
  }

  function ubicar(a) {
    const r = a.getBoundingClientRect();
    const ancho = 320;
    const izquierda = Math.max(8, Math.min(window.innerWidth - ancho - 8, r.left + r.width / 2 - ancho / 2));
    const abajo = r.bottom + 260 < window.innerHeight;
    tarjeta.style.left = izquierda + "px";
    tarjeta.style.top = (abajo ? r.bottom + 8 : Math.max(8, r.top - 8 - tarjeta.offsetHeight)) + "px";
  }

  async function mostrarPrevia(a, id) {
    enlaceActual = a;
    tarjeta.replaceChildren(nodo("p", { class: "hoja-previa-nota", text: "Cargando vista previa…" }));
    try { tarjeta.showPopover(); } catch (_) { /* ya visible */ }
    ubicar(a);
    try {
      const archivo = await datosArchivo(id);
      if (enlaceActual !== a) return;
      const fecha = archivo.modifiedTime ? new Date(archivo.modifiedTime).toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" }) : "";
      const editable = esHojaDeCalculo(archivo) && archivo.capabilities && archivo.capabilities.canEdit && google().puedeEscribir();
      const miniatura = archivo.thumbnailLink
        ? nodo("img", { class: "hoja-previa-img", src: archivo.thumbnailLink, alt: "", referrerpolicy: "no-referrer",
            onerror: (ev) => ev.target.replaceWith(nodo("div", { class: "hoja-previa-sin", text: "Sin miniatura" })) })
        : nodo("div", { class: "hoja-previa-sin", text: "Sin miniatura" });
      tarjeta.replaceChildren(
        nodo("div", { class: "hoja-previa-titulo" },
          nodo("span", { class: esHojaDeCalculo(archivo) || esExcel(archivo) ? "icono-sheets" : "icono-archivo", "aria-hidden": "true" }),
          nodo("strong", { text: archivo.name, title: archivo.name })),
        miniatura,
        nodo("div", { class: "hoja-previa-pie" },
          archivo.owners && archivo.owners[0] ? nodo("span", { text: "👤 Propiedad de " + archivo.owners[0].displayName }) : null,
          fecha ? nodo("span", { text: "🕑 Modificada el " + fecha }) : null,
          esHojaDeCalculo(archivo)
            ? nodo("span", { class: editable ? "hoja-previa-editable" : "hoja-previa-lectura",
                text: editable ? "✏️ Puedes editarla · clic para abrir" : "👁️ Solo lectura · clic para abrir" })
            : esExcel(archivo)
              ? nodo("span", { class: "hoja-previa-lectura", text: "📄 Archivo de Excel · solo lectura · clic para abrir" })
              : nodo("span", { text: "Clic para abrir" })));
      ubicar(a);
    } catch (e) {
      if (enlaceActual !== a) return;
      tarjeta.replaceChildren(nodo("p", { class: "hoja-previa-nota error", text: "No se pudo ver: " + e.message + "." }));
    }
  }

  // ------------------------------------------------------------------ ventana con la tabla
  // La hoja se dibuja como en Google Sheets: mismos anchos y altos, filas y columnas ocultas
  // fuera, filas/columnas inmovilizadas fijas al desplazarse. Se navega con el teclado
  // (flechas, Tab, Inicio/Fin, Ctrl+flecha), se salta a una celda escribiéndola en el cuadro
  // de nombre y se acerca o aleja con los botones de zoom o Ctrl + rueda del mouse.
  const ventana = nodo("dialog", { class: "visor-hoja", "aria-label": "Hoja de Google" });
  document.body.append(ventana);
  // Esc cierra primero lo que esté abierto encima (menú, mis cambios, confirmación, búsqueda)
  // y solo después la ventana.
  ventana.addEventListener("cancel", (ev) => {
    if (ventana.querySelector(".celda-editando") || cerrarFlotantes() || cerrarBuscador(true)) ev.preventDefault();
  });
  ventana.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || (ev.key !== "f" && ev.key !== "F") || !visor || !visor.mapa) return;
    ev.preventDefault();
    abrirBuscador(visor);
  });
  // Un clic fuera del menú o de «Mis cambios» los cierra.
  ventana.addEventListener("mousedown", (ev) => {
    for (const e of ventana.querySelectorAll(".visor-menu, .visor-panel-cambios")) {
      if (!e.contains(ev.target) && !ev.target.closest(".visor-cambios-boton")) e.remove();
    }
  }, true);

  const ALTO_CABECERA = 22;   // fila de letras A, B, C...
  const ANCHO_NUMEROS = 46;   // columna de números de fila
  const NIVELES_ZOOM = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
  let zoom = 100;
  try { zoom = NIVELES_ZOOM.includes(Number(localStorage.getItem("axio-visor-zoom"))) ? Number(localStorage.getItem("axio-visor-zoom")) : 100; } catch (_) { /* sin almacenamiento */ }

  let visor = null;   // { id, archivo, hojas, hoja, editable, datos, merges, visF, visC, mapa, sel }

  async function abrirVisor(id, gid, url) {
    ocultarPrevia();
    ventana.replaceChildren(cabeceraVisor(null), nodo("div", { class: "visor-cuerpo" }, nodo("p", { class: "visor-nota", text: "⏳ Abriendo la hoja…" })));
    if (!ventana.open) ventana.showModal();
    const destino = destinoDe(url);
    try {
      const archivo = await datosArchivo(id);
      if (esExcel(archivo)) {
        visor = { id, archivo, excel: true, hojas: [], hoja: null, editable: false, destino };
        await cargarHoja();
        return;
      }
      const libro = await apiGoogle(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=${encodeURIComponent(
        "sheets.properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))")}`);
      const hojas = libro.sheets.map((h) => h.properties).filter((h) => !h.hidden || h.sheetId === gid);
      const hoja = hojas.find((h) => h.sheetId === gid) || hojas[0];
      visor = { id, archivo, hojas, hoja, editable: Boolean(archivo.capabilities && archivo.capabilities.canEdit && google().puedeEscribir()),
        destino, url: destino && hoja.sheetId === gid ? url : null };
      await cargarHoja();
    } catch (e) {
      ventana.querySelector(".visor-cuerpo").replaceChildren(nodo("p", { class: "visor-nota error", text: "No se pudo abrir la hoja: " + e.message + "." }));
    }
  }

  // «10937 - 71712176 - ALVEIRO ROJO ARENAS-Acuerdo Hipotecario - v2»: el nombre arriba y,
  // debajo y más pequeño, lo demás (código, cédula, tipo de acuerdo). Sin guiones, una línea.
  function partesTitulo(nombre) {
    const partes = String(nombre || "").split(/\s*-\s*/).map((t) => t.trim()).filter(Boolean);
    const k = partes.findIndex((t) => /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3}/.test(t));
    if (partes.length < 2 || k < 0) return { principal: String(nombre || ""), detalle: "" };
    return { principal: partes[k], detalle: partes.filter((_, n) => n !== k).join(" · ") };
  }
  function tituloVisor(v) {
    if (!v) return nodo("div", { class: "visor-titulo" }, nodo("strong", { class: "vt-principal", text: "Hoja de Google" }));
    const t = partesTitulo(v.archivo.name);
    return nodo("div", { class: "visor-titulo", title: v.archivo.name },
      nodo("strong", { class: "vt-principal", text: t.principal }),
      t.detalle ? nodo("span", { class: "vt-detalle", text: t.detalle }) : null);
  }

  function cabeceraVisor(v) {
    const estado = nodo("span", { class: "visor-estado", id: "visor-estado" });
    const cabecera = nodo("div", { class: "visor-cabecera" },
      nodo("span", { class: "icono-sheets", "aria-hidden": "true" }),
      tituloVisor(v),
      // El nombre del archivo trae código, cédula y nombre: Cartera lo copia seguido.
      v ? nodo("button", { class: "boton boton-texto visor-copiar-titulo", type: "button", title: "Copiar el nombre completo de la hoja",
        "aria-label": "Copiar el nombre de la hoja", text: "📋", onclick: () => copiarTexto(v.archivo.name, "📋 Nombre de la hoja copiado") }) : null,
      v ? nodo("span", { class: v.editable ? "visor-insignia editable" : "visor-insignia", text: v.editable ? "Puedes editar" : v.excel ? "Excel · solo lectura" : "Solo lectura" }) : null,
      estado,
      v ? nodo("a", { class: "boton boton-chico", href: (v.url && v.hoja && v.url.includes("gid=" + v.hoja.sheetId) ? v.url : null)
          || v.archivo.webViewLink || `https://docs.google.com/spreadsheets/d/${v.id}/edit${v.hoja && !v.excel ? "#gid=" + v.hoja.sheetId : ""}`,
        target: "_blank", rel: "noopener noreferrer", text: "Abrir en Google Sheets ↗" }) : null,
      nodo("button", { class: "boton boton-texto boton-icono", type: "button", title: "Maximizar / restaurar (doble clic en esta barra)",
        "aria-label": "Maximizar o restaurar", text: "⤢", onclick: maximizar }),
      nodo("button", { class: "boton boton-texto boton-cerrar", type: "button", "aria-label": "Cerrar", text: "✕", onclick: () => ventana.close() }));
    arrastrable(cabecera);
    cabecera.addEventListener("dblclick", (ev) => { if (!ev.target.closest("button, a, .visor-titulo")) maximizar(); });
    return cabecera;
  }

  function maximizar() {
    const max = ventana.classList.toggle("maximizada");
    if (max) { ventana.style.margin = ""; ventana.style.left = ""; ventana.style.top = ""; }
  }

  function avisar(texto, clase) {
    const e = ventana.querySelector("#visor-estado");
    if (e) { e.textContent = texto; e.className = "visor-estado " + (clase || ""); }
  }

  // Cuadro de nombre (A1), barra de fórmulas y zoom, como la barra de Google Sheets.
  function barraVisor(v) {
    const nombre = nodo("input", { class: "visor-nombre", type: "text", spellcheck: "false", "aria-label": "Celda seleccionada. Escribe una (por ejemplo B13) y Enter para ir",
      title: "Escribe una celda (por ejemplo B13) y Enter para ir" });
    nombre.addEventListener("focus", () => nombre.select());
    nombre.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); enfocarCuerpo(); return; }
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const m = /^\s*\$?([a-z]{1,3})\$?(\d{1,6})\s*$/i.exec(nombre.value);
      if (!m || !irA(v, Number(m[2]) - 1, columnaDeLetras(m[1]))) { nombre.classList.add("invalido"); setTimeout(() => nombre.classList.remove("invalido"), 600); return; }
      enfocarCuerpo();
    });
    const formula = nodo("div", { class: "visor-formula", "aria-live": "polite" });
    const valorZoom = nodo("button", { class: "visor-zoom-valor", type: "button", title: "Volver a 100 %", text: zoom + " %", onclick: () => ponerZoom(100) });
    return nodo("div", { class: "visor-barra" },
      nombre,
      nodo("span", { class: "visor-fx", "aria-hidden": "true", text: "fx" }),
      formula,
      nodo("button", { class: "visor-copiar", type: "button", title: "Copia la selección (Ctrl+C). Arrastra o usa Shift para elegir varias celdas",
        text: "📋 Copiar", onclick: () => { copiarRango(v, rangoSeleccionado(v)); enfocarCuerpo(); } }),
      nodo("button", { class: "visor-copiar visor-copiar-encabezado", type: "button", hidden: true,
        title: "Copia las filas de arriba de la hoja (las inmovilizadas): cédula, nombre, PR, celular...",
        text: "📋 Encabezado", onclick: () => copiarEncabezado(v) }),
      nodo("button", { class: "visor-copiar visor-icono", type: "button", title: "Buscar en esta hoja (Ctrl+F)", "aria-label": "Buscar en esta hoja",
        text: "🔍", onclick: () => abrirBuscador(v) }),
      v.editable ? nodo("button", { class: "visor-copiar visor-icono visor-deshacer", type: "button", disabled: true,
        title: "Deshacer tu último cambio en esta hoja (Ctrl+Z)", "aria-label": "Deshacer", text: "↶", onclick: () => deshacer(v) }) : null,
      nodo("button", { class: "visor-copiar visor-cambios-boton", type: "button", hidden: true, "aria-expanded": "false",
        title: "Lo que has cambiado desde el visor en esta sesión", onclick: (ev) => alternarCambios(v, ev.currentTarget) },
        "🕘 Mis cambios ", nodo("span", { class: "visor-cambios-n" })),
      nodo("div", { class: "visor-zoom", role: "group", "aria-label": "Zoom" },
        nodo("button", { type: "button", title: "Alejar (Ctrl + rueda)", "aria-label": "Alejar", text: "−", onclick: () => pasoZoom(-1) }),
        valorZoom,
        nodo("button", { type: "button", title: "Acercar (Ctrl + rueda)", "aria-label": "Acercar", text: "+", onclick: () => pasoZoom(1) })));
  }

  function ponerZoom(nuevo) {
    zoom = nuevo;
    try { localStorage.setItem("axio-visor-zoom", String(zoom)); } catch (_) { /* sin almacenamiento */ }
    const t = ventana.querySelector(".visor-tabla");
    if (t) t.style.zoom = zoom / 100;
    const e = ventana.querySelector(".visor-zoom-valor");
    if (e) e.textContent = zoom + " %";
  }
  function pasoZoom(dir) {
    const i = NIVELES_ZOOM.indexOf(zoom);
    ponerZoom(NIVELES_ZOOM[Math.max(0, Math.min(NIVELES_ZOOM.length - 1, (i < 0 ? 5 : i) + dir))]);
  }

  async function cargarHoja() {
    const v = visor;
    ventana.replaceChildren(cabeceraVisor(v), barraVisor(v), nodo("div", { class: "visor-cuerpo" },
      nodo("p", { class: "visor-nota", text: "⏳ Cargando " + (v.hoja ? v.hoja.title : v.archivo.name) + "…" })), pestanas(v));
    let libro, filas, cols;
    if (v.excel) {
      const r = await google().leerExcel(v.id, v.hoja ? v.hoja.title : "", MAX_FILAS, MAX_COLUMNAS);
      v.hojas = r.hojas.map((titulo, i) => ({ sheetId: i, title: titulo }));
      v.hoja = v.hojas.find((h) => h.title === r.hoja) || v.hojas[0];
      v.recortada = r.recortada;
      v.congeladas = r.congeladas || { filas: 0, cols: 0 };
      v.filasCargadas = null;
      v.tramoFilas = null;
      libro = r.libro;
      const rowData = libro.sheets[0].data[0].rowData;
      filas = rowData.length;
      cols = Math.max(1, ...rowData.map((f) => f.values.length));
      ventana.querySelector(".visor-pestanas").replaceWith(pestanas(v));
    } else {
      const g = v.hoja.gridProperties || {};
      const totalFilas = g.rowCount || MAX_FILAS;
      cols = Math.min(g.columnCount || 26, MAX_COLUMNAS);
      v.congeladas = { filas: g.frozenRowCount || 0, cols: g.frozenColumnCount || 0 };
      // Se traen MAX_FILAS filas: las primeras o, si se pidió una fila más abajo (Seguro de
      // Vida), las de alrededor de esa fila, más las inmovilizadas de arriba (el encabezado).
      const fijas = Math.min(v.congeladas.filas, totalFilas);
      let desde = 0;
      if (v.destino && v.destino.fila >= MAX_FILAS - 60) {
        desde = Math.max(fijas, Math.min(v.destino.fila - 100, totalFilas - (MAX_FILAS - fijas)));
      }
      const hasta = Math.min(totalFilas, desde ? desde + MAX_FILAS - fijas : MAX_FILAS);
      filas = hasta;
      v.tramoFilas = desde ? { desde, hasta } : null;
      v.filasCargadas = [];
      for (let f = 0; f < (desde ? fijas : 0); f++) v.filasCargadas.push(f);
      for (let f = desde; f < hasta; f++) v.filasCargadas.push(f);
      const hoja = `'${v.hoja.title.replace(/'/g, "''")}'!`;
      const rangos = [hoja + `A${desde + 1}:${letra(cols - 1)}${hasta}`];
      if (desde && fijas) rangos.unshift(hoja + `A1:${letra(cols - 1)}${fijas}`);
      const campos = "sheets(merges,data(startRow,columnMetadata(pixelSize,hiddenByUser),rowMetadata(pixelSize,hiddenByUser,hiddenByFilter),rowData(values(" +
        "formattedValue,hyperlink,userEnteredValue,effectiveValue(numberValue)," +
        "effectiveFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,borders," +
        "textFormat(bold,italic,underline,strikethrough,foregroundColor,fontSize,fontFamily))))))";
      libro = await apiGoogle(`https://sheets.googleapis.com/v4/spreadsheets/${v.id}?${rangos.map((r) => "ranges=" + encodeURIComponent(r)).join("&")}` +
        `&includeGridData=true&fields=${encodeURIComponent(campos)}`);
      v.recortada = totalFilas > MAX_FILAS || (g.columnCount || 0) > MAX_COLUMNAS;
      // Cada rango llega por separado (con su fila de inicio): se juntan por número de fila.
      const juntos = { rowData: [], rowMetadata: [], columnMetadata: [] };
      for (const d of libro.sheets[0].data || []) {
        const inicio = d.startRow || 0;
        (d.rowData || []).forEach((x, k) => { juntos.rowData[inicio + k] = x; });
        (d.rowMetadata || []).forEach((x, k) => { juntos.rowMetadata[inicio + k] = x; });
        if (!juntos.columnMetadata.length && d.columnMetadata) juntos.columnMetadata = d.columnMetadata;
      }
      libro.sheets[0].data = [juntos];
    }
    v.datos = (libro.sheets[0].data || [])[0] || {};
    v.merges = libro.sheets[0].merges || [];
    const cuerpo = ventana.querySelector(".visor-cuerpo");
    cuerpo.replaceChildren(tabla(v, filas, cols));
    prepararCuerpo(v, cuerpo);
    const botonEncabezado = ventana.querySelector(".visor-copiar-encabezado");
    if (botonEncabezado) botonEncabezado.hidden = !v.fijasF;
    seleccionar(v, 0, 0, false);
    enfocarCuerpo();
    avisar(v.editable ? "Doble clic para escribir · Ctrl+C / Ctrl+V · Ctrl+F para buscar · clic derecho para más"
      : v.excel ? "Es un archivo de Excel guardado en Drive: para editarlo, ábrelo en Google Sheets" : "Ctrl+F para buscar · clic derecho para más", "gris");
    if (v.destino) irADestino(v, v.destino);
    v.destino = null;
    if (celdaPendiente && celdaPendiente.id === v.id) irACelda(v, celdaPendiente.f, celdaPendiente.c);
    celdaPendiente = null;
    actualizarHistorial(v);
  }

  // La fila pedida queda seleccionada entera, al centro de la vista y resaltada un momento.
  function irADestino(v, d) {
    const i = v.visF.indexOf(d.fila);
    if (i < 0) { avisar(`La fila ${d.fila + 1} no está a la vista en esta hoja (puede estar oculta o filtrada)`, "ambar"); return; }
    let j0 = v.visC.findIndex((c) => c >= d.col);
    let j1 = v.visC.length - 1 - [...v.visC].reverse().findIndex((c) => c <= d.colFin);
    if (j0 < 0) j0 = 0;
    if (j1 < j0 || j1 >= v.visC.length) j1 = v.visC.length - 1;
    v.ancla = { i, j: j1 };
    seleccionar(v, i, j0, false, true);
    const td = v.mapa.get(i + ":" + j0);
    if (td) {
      // Al centro, pero sin quedar debajo de las filas inmovilizadas.
      const cuerpo = ventana.querySelector(".visor-cuerpo");
      const caja = cuerpo.getBoundingClientRect(), r = td.getBoundingClientRect();
      cuerpo.scrollTop += r.top - caja.top - Math.max(caja.height / 2 - r.height, 0);
      cuerpo.scrollLeft = 0;
      const fila = td.parentElement;
      fila.classList.add("visor-fila-destino");
      setTimeout(() => fila.classList.remove("visor-fila-destino"), 2600);
    }
    avisar(`📍 Fila ${d.fila + 1}: la de esta persona`, "ok");
  }

  // Pestañas abajo, como en Google Sheets. Alt + ↑/↓ cambia de pestaña.
  function pestanas(v) {
    if (v.hojas.length < 2) return nodo("div", { class: "visor-pestanas vacio" });
    const barra = nodo("div", { class: "visor-pestanas", role: "tablist" });
    for (const h of v.hojas) {
      barra.append(nodo("button", { type: "button", role: "tab", class: "visor-pestana" + (h.sheetId === v.hoja.sheetId ? " activa" : ""),
        "aria-selected": String(h.sheetId === v.hoja.sheetId), text: h.title, onclick: () => cambiarPestana(v, h) }));
    }
    return barra;
  }
  function cambiarPestana(v, h) {
    if (!h || h.sheetId === v.hoja.sheetId) return;
    v.hoja = h;
    v.destino = null;
    cargarHoja().catch((e) => avisar("❌ " + e.message, "error"));
  }

  // ------------------------------------------------------------------ dibujar la hoja
  const ANCHO_BORDE = { SOLID: 1, SOLID_MEDIUM: 2, SOLID_THICK: 3, DASHED: 1, DOTTED: 1, DOUBLE: 3 };

  function tabla(v, filas, cols) {
    const datos = v.datos;
    const filasDatos = datos.rowData || [];
    const metaF = datos.rowMetadata || [], metaC = datos.columnMetadata || [];
    const alto = (f) => Math.max(8, (metaF[f] || {}).pixelSize || 21);
    const ancho = (c) => Math.max(8, (metaC[c] || {}).pixelSize || 100);
    // Lo que está oculto en la hoja (a mano, por filtro o con un grupo contraído) no se dibuja.
    const visF = [], visC = [];
    const cargadas = v.filasCargadas || Array.from({ length: filas }, (_, f) => f);
    for (const f of cargadas) if (!((metaF[f] || {}).hiddenByUser || (metaF[f] || {}).hiddenByFilter)) visF.push(f);
    for (let c = 0; c < cols; c++) if (!(metaC[c] || {}).hiddenByUser) visC.push(c);
    if (!visF.length) visF.push(0);
    if (!visC.length) visC.push(0);
    const posF = new Map(visF.map((f, i) => [f, i])), posC = new Map(visC.map((c, j) => [c, j]));

    // Celdas combinadas, contadas solo sobre lo visible. El contenido sale de la celda de
    // arriba a la izquierda aunque esa quede oculta.
    const ancla = new Map();      // "i:j" de cada celda visible cubierta -> "i:j" de su ancla
    const combinadas = new Map(); // "i:j" del ancla -> { filas, cols, f, c, alto }
    for (const m of v.merges) {
      const fs = visF.filter((f) => f >= m.startRowIndex && f < m.endRowIndex);
      const cs = visC.filter((c) => c >= m.startColumnIndex && c < m.endColumnIndex);
      if (!fs.length || !cs.length) continue;
      const clave = posF.get(fs[0]) + ":" + posC.get(cs[0]);
      for (const f of fs) for (const c of cs) ancla.set(posF.get(f) + ":" + posC.get(c), clave);
      combinadas.set(clave, { filas: fs.length, cols: cs.length, f: m.startRowIndex, c: m.startColumnIndex, alto: fs.reduce((s, f) => s + alto(f), 0) });
    }
    const celdaEn = (f, c) => (((filasDatos[f] || {}).values || [])[c]) || {};
    const vacia = (i, j) => {
      if (j >= visC.length) return false;
      const a = ancla.get(i + ":" + j);
      if (a && a !== i + ":" + j) return false;
      return !celdaEn(visF[i], visC[j]).formattedValue;
    };

    // Filas y columnas inmovilizadas: fijas arriba / a la izquierda al desplazarse.
    const fijasF = visF.filter((f) => f < (v.congeladas || {}).filas).length;
    const fijasC = visC.filter((c) => c < (v.congeladas || {}).cols).length;
    const arriba = [], izquierda = [];
    for (let i = 0, y = ALTO_CABECERA; i < fijasF; i++) { arriba.push(y); y += alto(visF[i]); }
    for (let j = 0, x = ANCHO_NUMEROS; j < fijasC; j++) { izquierda.push(x); x += ancho(visC[j]); }
    const fondoFijas = (fijasF ? arriba[fijasF - 1] + alto(visF[fijasF - 1]) : ALTO_CABECERA);
    const bordeFijas = (fijasC ? izquierda[fijasC - 1] + ancho(visC[fijasC - 1]) : ANCHO_NUMEROS);

    const grupoCols = nodo("colgroup", null, nodo("col", { style: `width:${ANCHO_NUMEROS}px` }));
    for (const c of visC) grupoCols.append(nodo("col", { style: `width:${ancho(c)}px` }));

    const cabeza = nodo("tr", null, nodo("th", { class: "visor-esquina" }));
    visC.forEach((c, j) => cabeza.append(nodo("th", {
      text: letra(c), "data-j": j, class: j < fijasC ? "fija" + (j === fijasC - 1 ? " fin-fijas-c" : "") : null,
      style: j < fijasC ? `left:${izquierda[j]}px` : null })));

    v.visF = visF; v.visC = visC; v.mapa = new Map(); v.fijasF = fijasF; v.ancla = null;
    const cuerpo = nodo("tbody");
    visF.forEach((f, i) => {
      const fija = i < fijasF;
      const clasesFila = fija ? "fija" + (i === fijasF - 1 ? " fin-fijas-f" : "") : "";
      const tr = nodo("tr", { class: clasesFila || null },
        nodo("th", { text: String(f + 1), "data-i": i, style: `height:${alto(f)}px` + (fija ? `;top:${arriba[i]}px` : "") }));
      visC.forEach((c, j) => {
        const clave = i + ":" + j;
        const a = ancla.get(clave);
        if (a && a !== clave) { v.mapa.set(clave, v.mapa.get(a)); return; }
        const comb = combinadas.get(clave);
        const fOrigen = comb ? comb.f : f, cOrigen = comb ? comb.c : c;
        const td = pintarCelda(v, celdaEn(fOrigen, cOrigen), fOrigen, cOrigen, comb, {
          alto: comb ? comb.alto : alto(f), derramar: vacia(i, j + (comb ? comb.cols : 1)) });
        td.dataset.i = i; td.dataset.j = j;
        const fijaC = j < fijasC;
        if (fija || fijaC) {
          td.classList.add(fija && fijaC ? "fija-ambas" : fija ? "fija-f" : "fija-c");
          if (fija) td.style.top = arriba[i] + "px";
          if (fijaC) td.style.left = izquierda[j] + "px";
          if (j + (comb ? comb.cols : 1) === fijasC) td.classList.add("fin-fijas-c");
        }
        v.mapa.set(clave, td);
        tr.append(td);
      });
      cuerpo.append(tr);
    });
    // Ancho exacto: con "max-content", el texto que se derrama ensancharía su columna.
    const anchoTotal = visC.reduce((s, c) => s + ancho(c), ANCHO_NUMEROS);
    const t = nodo("table", { class: "visor-tabla", style: `width:${anchoTotal}px;zoom:${zoom / 100};--margen-arriba:${fondoFijas}px;--margen-izq:${bordeFijas}px` },
      grupoCols, nodo("thead", null, cabeza), cuerpo);
    const envoltura = nodo("div", { class: "visor-tabla-envoltura" }, t);
    if (v.tramoFilas) {
      envoltura.append(nodo("p", { class: "visor-nota", text: `Se muestran las filas ${v.tramoFilas.desde + 1} a ${v.tramoFilas.hasta} (alrededor de la buscada) y el encabezado. El resto, en «Abrir en Google Sheets».` }));
    } else if (v.recortada) {
      envoltura.append(nodo("p", { class: "visor-nota", text: `Se muestran las primeras ${filas} filas y ${cols} columnas. El resto, en «Abrir en Google Sheets».` }));
    }
    return envoltura;
  }

  function borde(b) {
    if (!b || !b.style || b.style === "NONE") return null;
    const c = color((b.colorStyle && b.colorStyle.rgbColor) || b.color) || "rgb(0,0,0)";
    const w = b.style === "DOUBLE" ? 3 : (ANCHO_BORDE[b.style] || b.width || 1);
    const tipo = b.style === "DASHED" ? "dashed" : b.style === "DOTTED" ? "dotted" : b.style === "DOUBLE" ? "double" : "solid";
    return { c, w, tipo };
  }

  function pintarCelda(v, celda, f, c, comb, info) {
    const formato = celda.effectiveFormat || {};
    const texto = formato.textFormat || {};
    const estilos = [];
    const fondo = color(formato.backgroundColor);
    if (fondo && fondo !== "rgb(255,255,255)") estilos.push("background:" + fondo);
    const letraColor = color(texto.foregroundColor);
    if (letraColor && letraColor !== "rgb(0,0,0)") estilos.push("color:" + letraColor);
    if (texto.bold) estilos.push("font-weight:700");
    if (texto.italic) estilos.push("font-style:italic");
    const lineas = [texto.underline && "underline", texto.strikethrough && "line-through"].filter(Boolean);
    if (lineas.length) estilos.push("text-decoration:" + lineas.join(" "));
    if (texto.fontSize && texto.fontSize !== 10) estilos.push(`font-size:${texto.fontSize}pt`);
    if (texto.fontFamily && !/^arial$/i.test(texto.fontFamily)) estilos.push(`font-family:"${texto.fontFamily.replace(/"/g, "")}",Arial,sans-serif`);
    const esNumero = Boolean(celda.effectiveValue && "numberValue" in celda.effectiveValue);
    const alineacion = formato.horizontalAlignment || (esNumero ? "RIGHT" : "LEFT");
    estilos.push("text-align:" + alineacion.toLowerCase());
    const vertical = { TOP: "top", MIDDLE: "middle", BOTTOM: "bottom" }[formato.verticalAlignment] || "bottom";
    if (vertical !== "bottom") estilos.push("vertical-align:" + vertical);
    // Bordes de la hoja: derecho e inferior como borde; superior e izquierdo como sombra
    // interior (así no se descuadran los anchos).
    const b = formato.borders || {};
    const der = borde(b.right), aba = borde(b.bottom), arr = borde(b.top), izq = borde(b.left);
    if (der) estilos.push(`border-right:${der.w}px ${der.tipo} ${der.c}`);
    if (aba) estilos.push(`border-bottom:${aba.w}px ${aba.tipo} ${aba.c}`);
    const sombras = [arr && `inset 0 ${arr.w}px 0 ${arr.c}`, izq && `inset ${izq.w}px 0 0 ${izq.c}`].filter(Boolean);
    if (sombras.length) estilos.push("box-shadow:" + sombras.join(","));

    // Como en Sheets: el texto que no cabe sigue sobre la celda vecina si está vacía; si no,
    // se corta. Con "ajustar texto", baja de línea.
    const ajuste = formato.wrapStrategy === "WRAP" || formato.wrapStrategy === "LEGACY_WRAP" ? "ajustar"
      : formato.wrapStrategy !== "CLIP" && !esNumero && alineacion === "LEFT" && info.derramar && celda.formattedValue ? "derramar" : "cortar";
    const td = nodo("td", {
      class: "c-" + ajuste,
      style: estilos.join(";"), colspan: comb && comb.cols > 1 ? comb.cols : null, rowspan: comb && comb.filas > 1 ? comb.filas : null,
      "data-f": f, "data-c": c,
      title: celda.userEnteredValue && celda.userEnteredValue.formulaValue ? "Fórmula: " + celda.userEnteredValue.formulaValue : null,
    });
    td._celda = celda;
    td._alto = info.alto;
    escribirContenido(td, celda);
    return td;
  }

  function escribirContenido(td, celda) {
    const valor = celda.formattedValue || "";
    const contenido = celda.hyperlink && /^https?:\/\//i.test(celda.hyperlink)
      ? nodo("a", { href: celda.hyperlink, target: "_blank", rel: "noopener noreferrer", text: valor || celda.hyperlink })
      : valor;
    // El div mantiene la celda del alto que tiene en la hoja aunque el texto no quepa.
    td.replaceChildren(nodo("div", { class: "visor-c", style: `max-height:${Math.max(8, td._alto - 1)}px` }, contenido));
  }

  // ------------------------------------------------------------------ selección y teclado
  const enfocarCuerpo = () => { const c = ventana.querySelector(".visor-cuerpo"); if (c) c.focus({ preventScroll: true }); };
  const columnaDeLetras = (s) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

  // extender: la selección va desde el ancla (donde empezó) hasta (i, j), como Shift en Sheets.
  function seleccionar(v, i, j, desplazar = true, extender = false) {
    i = Math.max(0, Math.min(v.visF.length - 1, i));
    j = Math.max(0, Math.min(v.visC.length - 1, j));
    const td = v.mapa.get(i + ":" + j);
    if (!td) return;
    v.sel = { i, j };
    if (!extender || !v.ancla) v.ancla = { i, j };
    ventana.querySelectorAll(".visor-tabla .sel, .visor-tabla .activa, .visor-tabla .rango").forEach((e) => e.classList.remove("sel", "activa", "rango"));
    td.classList.add("sel");
    // Resalta el rango y sus letras y números (las celdas combinadas entran completas).
    const r = rangoSeleccionado(v);
    const celdasRango = new Set();
    for (let a = r.i0; a <= r.i1; a++) {
      for (let b = r.j0; b <= r.j1; b++) celdasRango.add(v.mapa.get(a + ":" + b));
    }
    if (celdasRango.size > 1) celdasRango.forEach((celda) => celda && celda.classList.add("rango"));
    for (let b = r.j0; b <= r.j1; b++) { const th = ventana.querySelector(`.visor-tabla thead th[data-j="${b}"]`); if (th) th.classList.add("activa"); }
    for (let a = r.i0; a <= r.i1; a++) { const th = ventana.querySelector(`.visor-tabla tbody th[data-i="${a}"]`); if (th) th.classList.add("activa"); }
    const nombre = ventana.querySelector(".visor-nombre");
    if (nombre && document.activeElement !== nombre) nombre.value = refRango(v, r);
    const formula = ventana.querySelector(".visor-formula");
    if (formula) { formula.textContent = textoEditable(td._celda); formula.title = formula.textContent; }
    if (desplazar) td.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // Mueve la selección; si cae dentro de la misma celda combinada, sigue hasta salir de ella.
  function mover(v, di, dj, extender = false) {
    const actual = v.mapa.get(v.sel.i + ":" + v.sel.j);
    let { i, j } = v.sel;
    do { i += di; j += dj; } while (v.mapa.get(i + ":" + j) === actual && i >= 0 && j >= 0 && i < v.visF.length && j < v.visC.length);
    seleccionar(v, i, j, true, extender);
  }

  // El rectángulo entre el ancla y la celda activa (en posiciones visibles), agrandado hasta
  // que ninguna celda combinada quede partida.
  function rangoSeleccionado(v) {
    const a = v.ancla || v.sel;
    const r = { i0: Math.min(a.i, v.sel.i), i1: Math.max(a.i, v.sel.i), j0: Math.min(a.j, v.sel.j), j1: Math.max(a.j, v.sel.j) };
    for (let cambio = true; cambio;) {
      cambio = false;
      for (let i = r.i0; i <= r.i1; i++) {
        for (let j = r.j0; j <= r.j1; j++) {
          const td = v.mapa.get(i + ":" + j);
          if (!td) continue;
          const ti = Number(td.dataset.i), tj = Number(td.dataset.j);
          const fi = ti + Number(td.getAttribute("rowspan") || 1) - 1, fj = tj + Number(td.getAttribute("colspan") || 1) - 1;
          if (ti < r.i0) { r.i0 = ti; cambio = true; }
          if (tj < r.j0) { r.j0 = tj; cambio = true; }
          if (fi > r.i1) { r.i1 = fi; cambio = true; }
          if (fj > r.j1) { r.j1 = fj; cambio = true; }
        }
      }
    }
    return r;
  }

  const refRango = (v, r) => {
    const desde = letra(v.visC[r.j0]) + (v.visF[r.i0] + 1), hasta = letra(v.visC[r.j1]) + (v.visF[r.i1] + 1);
    return desde === hasta ? desde : desde + ":" + hasta;
  };

  function seleccionarRango(v, i0, j0, i1, j1) {
    v.ancla = { i: i0, j: j0 };
    seleccionar(v, i1, j1, false, true);
  }

  function irA(v, fila, col) {
    const i = v.visF.findIndex((f) => f >= fila), j = v.visC.findIndex((c) => c >= col);
    if (fila < 0 || col < 0 || i < 0 || j < 0) return false;
    seleccionar(v, i, j);
    return true;
  }

  function prepararCuerpo(v, cuerpo) {
    cuerpo.tabIndex = 0;
    cuerpo.setAttribute("aria-label", "Hoja. Flechas para moverte" + (v.editable ? ", Enter para escribir" : ""));
    // Clic: una celda. Arrastrar o Shift + clic: un rango. Clic en un número de fila o en
    // una letra de columna: la fila o la columna entera (la esquina: toda la hoja).
    let arrastrando = false;
    cuerpo.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      const th = ev.target.closest(".visor-tabla th");
      if (th) {
        ev.preventDefault(); enfocarCuerpo();
        const ultimaF = v.visF.length - 1, ultimaC = v.visC.length - 1;
        if (th.classList.contains("visor-esquina")) seleccionarRango(v, 0, 0, ultimaF, ultimaC);
        else if (th.dataset.j !== undefined) {
          const j = Number(th.dataset.j);
          if (ev.shiftKey && v.ancla) { v.ancla = { i: 0, j: v.ancla.j }; seleccionar(v, ultimaF, j, false, true); }
          else seleccionarRango(v, 0, j, ultimaF, j);
        } else if (th.dataset.i !== undefined) {
          const i = Number(th.dataset.i);
          if (ev.shiftKey && v.ancla) { v.ancla = { i: v.ancla.i, j: 0 }; seleccionar(v, i, ultimaC, false, true); }
          else seleccionarRango(v, i, 0, i, ultimaC);
        }
        return;
      }
      const td = ev.target.closest(".visor-tabla td");
      if (!td || td.classList.contains("celda-editando")) return;
      if (!ev.target.closest("a")) { ev.preventDefault(); enfocarCuerpo(); }
      seleccionar(v, Number(td.dataset.i), Number(td.dataset.j), false, ev.shiftKey);
      arrastrando = true;
      window.addEventListener("mouseup", () => { arrastrando = false; }, { once: true });
    });
    cuerpo.addEventListener("mouseover", (ev) => {
      if (!arrastrando) return;
      const td = ev.target.closest(".visor-tabla td");
      if (td && !(v.sel.i === Number(td.dataset.i) && v.sel.j === Number(td.dataset.j))) {
        seleccionar(v, Number(td.dataset.i), Number(td.dataset.j), false, true);
      }
    });
    cuerpo.addEventListener("dblclick", (ev) => {
      const td = ev.target.closest(".visor-tabla td");
      if (td && v.editable && !ev.target.closest("a")) editar(v, td);
    });
    cuerpo.addEventListener("contextmenu", (ev) => menuCelda(v, ev));
    cuerpo.addEventListener("scroll", () => { const m = ventana.querySelector(".visor-menu"); if (m) m.remove(); }, { passive: true });
    // Texto que no cabe en la celda: al pasar el mouse se ve completo (y la fórmula, si tiene).
    cuerpo.addEventListener("mouseover", (ev) => {
      const td = ev.target.closest(".visor-tabla td");
      if (!td || !td._celda || td.classList.contains("celda-editando")) return;
      const div = td.querySelector(".visor-c");
      const valor = td._celda.formattedValue || "";
      const formula = (td._celda.userEnteredValue || {}).formulaValue;
      const cortado = div && valor && !td.classList.contains("c-derramar")
        && (div.scrollWidth > div.clientWidth + 1 || div.scrollHeight > div.clientHeight + 1);
      const titulo = [cortado ? valor : "", formula ? "Fórmula: " + formula : ""].filter(Boolean).join("\n");
      if (titulo) td.title = titulo; else td.removeAttribute("title");
    });
    cuerpo.addEventListener("wheel", (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      pasoZoom(ev.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    cuerpo.addEventListener("keydown", (ev) => {
      if (ev.target !== cuerpo || !v.sel) return;
      const ctrl = ev.ctrlKey || ev.metaKey, shift = ev.shiftKey;
      const td = v.mapa.get(v.sel.i + ":" + v.sel.j);
      const paginas = Math.max(1, Math.floor(cuerpo.clientHeight / (24 * zoom / 100)) - 2);
      let hecho = true;
      switch (ev.key) {
        case "ArrowUp": if (ev.altKey) cambiarPestana(v, v.hojas[v.hojas.indexOf(v.hoja) - 1]); else if (ctrl) seleccionar(v, 0, v.sel.j, true, shift); else mover(v, -1, 0, shift); break;
        case "ArrowDown": if (ev.altKey) cambiarPestana(v, v.hojas[v.hojas.indexOf(v.hoja) + 1]); else if (ctrl) seleccionar(v, v.visF.length - 1, v.sel.j, true, shift); else mover(v, 1, 0, shift); break;
        case "ArrowLeft": if (ctrl) seleccionar(v, v.sel.i, 0, true, shift); else mover(v, 0, -1, shift); break;
        case "ArrowRight": if (ctrl) seleccionar(v, v.sel.i, v.visC.length - 1, true, shift); else mover(v, 0, 1, shift); break;
        case "Tab": mover(v, 0, ev.shiftKey ? -1 : 1); break;
        case "Home": seleccionar(v, ctrl ? 0 : v.sel.i, 0); break;
        case "End": seleccionar(v, ctrl ? v.visF.length - 1 : v.sel.i, v.visC.length - 1); break;
        case "PageDown": seleccionar(v, v.sel.i + paginas, v.sel.j); break;
        case "PageUp": seleccionar(v, v.sel.i - paginas, v.sel.j); break;
        case "Enter": case "F2": if (v.editable && !ev.shiftKey) editar(v, td); else mover(v, ev.shiftKey ? -1 : 1, 0); break;
        default:
          if (ctrl && (ev.key === "+" || ev.key === "=")) pasoZoom(1);
          else if (ctrl && ev.key === "-") pasoZoom(-1);
          else if (ctrl && ev.key === "0") ponerZoom(100);
          // Ctrl+C y Ctrl+V: se dejan pasar para que el navegador lance copy y paste (abajo).
          else if (ctrl && (ev.key === "c" || ev.key === "C" || ev.key === "v" || ev.key === "V")) hecho = false;
          else if (ctrl && !shift && (ev.key === "z" || ev.key === "Z")) { if (v.editable) deshacer(v); }
          else if (ctrl && (ev.key === "a" || ev.key === "A")) seleccionarRango(v, 0, 0, v.visF.length - 1, v.visC.length - 1);
          else if (ctrl && (ev.key === "g" || ev.key === "G" || ev.key === "j" || ev.key === "J")) ventana.querySelector(".visor-nombre").focus();
          // Escribir sobre una celda empieza a editarla, como en Sheets.
          else if (v.editable && !ctrl && !ev.altKey && ev.key.length === 1) editar(v, td, ev.key);
          else hecho = false;
      }
      if (hecho) ev.preventDefault();
    });
  }

  // Copia el rango de dos formas a la vez: texto separado por tabulaciones (Excel y Sheets
  // lo pegan en celdas) y una tabla HTML con los colores y combinadas (un correo, Word o
  // Sheets la pegan con formato). Como en Sheets, lo que va es el valor que se ve.
  const ESTILOS_QUE_SE_COPIAN = ["background-color", "color", "font-weight", "font-style", "font-size", "font-family",
    "text-align", "vertical-align", "text-decoration", "border-right", "border-bottom"];
  const escaparHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const celdaTsv = (s) => (/[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

  function contenidoRango(v, r) {
    const lineas = [], filasHtml = [];
    for (let i = r.i0; i <= r.i1; i++) {
      const valores = [], celdasHtml = [];
      for (let j = r.j0; j <= r.j1; j++) {
        const td = v.mapa.get(i + ":" + j);
        const esAncla = td && Number(td.dataset.i) === i && Number(td.dataset.j) === j;
        const texto = esAncla ? (td._celda.formattedValue || "") : "";
        valores.push(celdaTsv(texto));
        if (!esAncla) continue;   // la cubre una combinada que ya se escribió
        const filas = Math.min(Number(td.getAttribute("rowspan") || 1), r.i1 - i + 1);
        const cols = Math.min(Number(td.getAttribute("colspan") || 1), r.j1 - j + 1);
        const estilo = ESTILOS_QUE_SE_COPIAN.map((p) => (td.style.getPropertyValue(p) ? `${p}:${td.style.getPropertyValue(p)}` : null)).filter(Boolean);
        estilo.push("padding:2px 4px", "white-space:" + (td.classList.contains("c-ajustar") ? "normal" : "nowrap"));
        const contenido = td._celda.hyperlink && /^https?:\/\//i.test(td._celda.hyperlink)
          ? `<a href="${escaparHtml(td._celda.hyperlink)}">${escaparHtml(texto || td._celda.hyperlink)}</a>` : escaparHtml(texto);
        celdasHtml.push(`<td${filas > 1 ? ` rowspan="${filas}"` : ""}${cols > 1 ? ` colspan="${cols}"` : ""} style="${estilo.join(";")}">${contenido}</td>`);
      }
      lineas.push(valores.join("\t"));
      filasHtml.push("<tr>" + celdasHtml.join("") + "</tr>");
    }
    const tsv = lineas.join("\n");
    const html = `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:10pt">${filasHtml.join("")}</table>`;
    const filas = r.i1 - r.i0 + 1, cols = r.j1 - r.j0 + 1;
    const que = filas * cols === 1 ? refRango(v, r) : `${refRango(v, r)} (${filas} fila${filas === 1 ? "" : "s"} × ${cols} columna${cols === 1 ? "" : "s"})`;
    return { tsv, html, que };
  }

  async function copiarRango(v, r) {
    const { tsv, html, que } = contenidoRango(v, r);
    try {
      if (window.ClipboardItem && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          "text/plain": new Blob([tsv], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        })]);
      } else {
        await navigator.clipboard.writeText(tsv);
      }
      v.ultimaCopia = { tsv, html };
      avisar("📋 Copiado " + que + " · pégalo en Excel, Sheets, un correo o WhatsApp", "ok");
    } catch (_) {
      avisar("❌ El navegador no dejó copiar. Prueba otra vez con Ctrl+C", "error");
    }
  }

  async function copiarTexto(texto, aviso) {
    try {
      await navigator.clipboard.writeText(texto);
      avisar(aviso, "ok");
    } catch (_) {
      avisar("❌ El navegador no dejó copiar. Selecciona el nombre con el mouse y usa Ctrl+C", "error");
    }
  }

  // Las filas inmovilizadas de arriba (cédula, nombre, PR, celular...): lo que más se copia.
  function copiarEncabezado(v) {
    if (!v.fijasF) return;
    seleccionarRango(v, 0, 0, v.fijasF - 1, v.visC.length - 1);
    copiarRango(v, rangoSeleccionado(v));
    enfocarCuerpo();
  }

  // Ctrl+C y Ctrl+V con la celda solo seleccionada (sin doble clic), como en Sheets. Van por
  // los eventos copy y paste del navegador: no piden permiso del portapapeles. Se atienden
  // solo con el foco en la hoja; escribiendo en una celda, copiar y pegar son los de siempre.
  const cuerpoConFoco = () => visor && visor.sel && ventana.open && document.activeElement === ventana.querySelector(".visor-cuerpo");
  document.addEventListener("copy", (ev) => {
    if (!cuerpoConFoco()) return;
    const { tsv, html, que } = contenidoRango(visor, rangoSeleccionado(visor));
    ev.clipboardData.setData("text/plain", tsv);
    ev.clipboardData.setData("text/html", html);
    ev.preventDefault();
    visor.ultimaCopia = { tsv, html };
    avisar("📋 Copiado " + que + " · pégalo con Ctrl+V aquí, en Excel, Sheets, un correo o WhatsApp", "ok");
  });
  document.addEventListener("paste", (ev) => {
    if (!cuerpoConFoco()) return;
    ev.preventDefault();
    pegar(visor, ev.clipboardData.getData("text/plain"));
  });

  // Texto separado por tabulaciones (lo que copian Sheets, Excel y este visor) → filas de valores.
  function leerTsv(texto) {
    const filas = [[]];
    let celda = "", i = 0;
    texto = texto.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    while (i < texto.length) {
      const ch = texto[i];
      if (ch === '"' && celda === "") {   // celda entre comillas: puede traer saltos o tabulaciones
        let fin = i + 1;
        for (; fin < texto.length; fin++) {
          if (texto[fin] === '"') { if (texto[fin + 1] === '"') fin++; else break; }
        }
        const sigue = texto[fin + 1];
        if (fin < texto.length && (sigue === undefined || sigue === "\t" || sigue === "\n")) {
          celda = texto.slice(i + 1, fin).replace(/""/g, '"');
          i = fin + 1;
          continue;
        }
      }
      if (ch === "\t") { filas[filas.length - 1].push(celda); celda = ""; }
      else if (ch === "\n") { filas[filas.length - 1].push(celda); celda = ""; filas.push([]); }
      else celda += ch;
      i++;
    }
    filas[filas.length - 1].push(celda);
    return filas;
  }

  const MAXIMO_PEGADO = 2000;   // celdas: más que eso es un error de selección, no una gestión

  // Pega desde la esquina de arriba a la izquierda de la selección hacia la derecha y abajo
  // (solo filas y columnas visibles), como Sheets. Un solo valor con un rango seleccionado
  // llena todo el rango.
  async function pegar(v, texto) {
    if (!v.editable) {
      avisar(v.excel ? "Es un archivo de Excel guardado en Drive: para pegar, ábrelo en Google Sheets" : "👁️ Esta hoja es de solo lectura: no se puede pegar", "ambar");
      return;
    }
    if (!texto) { avisar("El portapapeles no tiene texto para pegar", "ambar"); return; }
    const valores = leerTsv(texto);
    const r = rangoSeleccionado(v);
    const uno = valores.length === 1 && valores[0].length === 1;
    const alto = uno ? r.i1 - r.i0 + 1 : valores.length;
    const ancho = uno ? r.j1 - r.j0 + 1 : Math.max(...valores.map((f) => f.length));
    const cambios = [];
    for (let a = 0; a < alto; a++) {
      for (let b = 0; b < ancho; b++) {
        const i = r.i0 + a, j = r.j0 + b;
        const td = v.mapa.get(i + ":" + j);
        // Fuera de la hoja, o tapada por una combinada que empieza en otra celda: se salta.
        if (!td || Number(td.dataset.i) !== i || Number(td.dataset.j) !== j) continue;
        const nuevo = uno ? valores[0][0] : (valores[a][b] === undefined ? "" : valores[a][b]);
        if (nuevo === textoEditable(td._celda)) continue;
        cambios.push(cambioDe(v, td, nuevo));
      }
    }
    if (cambios.length > MAXIMO_PEGADO) {
      avisar(`❌ Son ${cambios.length} celdas: pega a lo sumo ${MAXIMO_PEGADO} de una vez`, "error");
      return;
    }
    // Queda seleccionado lo que se pegó, como en Sheets.
    seleccionarRango(v, Math.min(v.visF.length - 1, r.i0 + alto - 1), Math.min(v.visC.length - 1, r.j0 + ancho - 1), r.i0, r.j0);
    if (!cambios.length) { avisar("Ya tenía esos mismos valores: no hubo nada que cambiar", "gris"); return; }
    const conDatos = cambios.filter((k) => k.antes !== "" || k.antesVisto !== "");
    if (conDatos.length && !(await confirmarPegado(conDatos, cambios.length))) { avisar("Pegado cancelado: no se cambió nada", "gris"); return; }
    await escribirCeldas(v, cambios, "pegar");
  }

  // Antes de pisar celdas que ya tienen algo, una barrita pregunta. Enter pega, Esc cancela.
  // Sobre celdas vacías se pega directo.
  function confirmarPegado(conDatos, total) {
    cerrarFlotantes();
    return new Promise((resolver) => {
      const recortar = (t) => (t.length > 22 ? t.slice(0, 21) + "…" : t);
      const muestra = conDatos.slice(0, 3).map((k) => `${refCelda(k)} «${recortar(k.antesVisto || k.antes)}»`).join(", ") + (conDatos.length > 3 ? "…" : "");
      let barra = null;
      const terminar = (si) => { barra.remove(); enfocarCuerpo(); resolver(si); };
      const botonPegar = nodo("button", { class: "boton boton-principal boton-chico", type: "button", text: "Pegar", onclick: () => terminar(true) });
      barra = nodo("div", { class: "visor-confirmar", role: "alertdialog", "aria-live": "assertive" },
        nodo("span", { class: "vcf-icono", "aria-hidden": "true", text: "⚠️" }),
        nodo("span", { class: "vcf-texto" },
          nodo("strong", { text: conDatos.length === 1 ? "Vas a reemplazar 1 celda que ya tiene datos" : `Vas a reemplazar ${conDatos.length} celdas que ya tienen datos` }),
          nodo("span", { text: (total > conDatos.length ? ` (de ${total} que se pegan)` : "") + ": " + muestra })),
        nodo("span", { class: "vcf-atajos", text: "Enter pega · Esc cancela" }),
        botonPegar,
        nodo("button", { class: "boton boton-chico", type: "button", text: "Cancelar", onclick: () => terminar(false) }));
      barra.cerrar = () => terminar(false);
      barra.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        terminar(false);
      });
      ventana.querySelector(".visor-barra").after(barra);
      botonPegar.focus();
    });
  }

  // ------------------------------------------------------------------ guardar, deshacer y «Mis cambios»
  // Lo que esta persona escribe o pega desde el visor queda anotado para «Mis cambios» y para
  // Ctrl+Z. Vive solo en la memoria de la pestaña: al cerrar la sesión se borra con lo demás.
  const misCambios = [];      // { id, archivo, hoja, sheetId, f, c, antes, despues, hora, deshecho }, el último primero
  const pilaDeshacer = [];    // una entrada por edición o pegado: { id, cambios }
  let celdaPendiente = null;  // { id, f, c }: la celda a la que ir cuando termine de cargar la hoja

  const refCelda = (k) => letra(k.c) + (k.f + 1);
  const horaCorta = (d) => d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
  const cambioDe = (v, td, texto) => ({ td, hoja: v.hoja.title, sheetId: v.hoja.sheetId, f: Number(td.dataset.f), c: Number(td.dataset.c),
    texto, antes: textoEditable(td._celda), antesVisto: td._celda.formattedValue || "" });
  const tdDe = (v, k) => (v.hoja && v.hoja.sheetId === k.sheetId ? ventana.querySelector(`.visor-tabla td[data-f="${k.f}"][data-c="${k.c}"]`) : null);

  // Escribe en Google Sheets en una sola petición y deja todo al día: las celdas en pantalla,
  // «Mis cambios», Ctrl+Z y el registro de gestiones. modo: "editar", "pegar" o "deshacer".
  async function escribirCeldas(v, cambios, modo) {
    const donde = cambios.length === 1 ? refCelda(cambios[0]) : `${cambios.length} celdas`;
    for (const k of cambios) {
      if (!k.td) continue;
      k.td.classList.add("celda-guardando");
      k.td.replaceChildren(nodo("div", { class: "visor-c" }, k.texto));
    }
    avisar(`⏳ ${{ editar: "Guardando", pegar: "Pegando", deshacer: "Deshaciendo" }[modo]} ${donde}…`, "gris");
    let resp;
    try {
      resp = await apiGoogle(`https://sheets.googleapis.com/v4/spreadsheets/${v.id}/values:batchUpdate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valueInputOption: "USER_ENTERED", includeValuesInResponse: true, responseValueRenderOption: "FORMATTED_VALUE",
          data: cambios.map((k) => ({ range: rango(k.hoja, k.f, k.c), values: [[k.texto]] })) }),
      });
    } catch (e) {
      for (const k of cambios) if (k.td) { k.td.classList.remove("celda-guardando"); escribirContenido(k.td, k.td._celda); }
      avisar(`❌ No se ${{ editar: "guardó", pegar: "pegó", deshacer: "deshizo" }[modo]}: ${e.message}`, "error");
      return false;
    }
    const respuestas = resp.responses || [];
    const ahora = new Date();
    const vistos = [], grupo = [];
    cambios.forEach((k, n) => {
      const valor = ((((respuestas[n] || {}).updatedData || {}).values || [[]])[0] || [])[0];
      const visto = valor === undefined ? "" : String(valor);
      vistos.push(visto);
      if (k.td) {
        k.td._celda.formattedValue = visto;
        k.td._celda.userEnteredValue = k.texto.startsWith("=") ? { formulaValue: k.texto } : { stringValue: k.texto };
        escribirContenido(k.td, k.td._celda);
        k.td.classList.remove("celda-guardando");
        k.td.classList.add("celda-guardada");
        setTimeout(() => k.td.classList.remove("celda-guardada"), 1600);
      }
      misCambios.unshift({ id: v.id, archivo: v.archivo.name, hoja: k.hoja, sheetId: k.sheetId, f: k.f, c: k.c,
        antes: k.antesVisto, despues: visto, hora: ahora, deshecho: modo === "deshacer" });
      // Deshacer = volver a escribir lo que había (la fórmula, si era una fórmula).
      grupo.push({ hoja: k.hoja, sheetId: k.sheetId, f: k.f, c: k.c, texto: k.antes, antes: k.texto, antesVisto: visto });
    });
    if (modo !== "deshacer") pilaDeshacer.push({ id: v.id, cambios: grupo });
    if (visor === v && v.sel) seleccionar(v, v.sel.i, v.sel.j, false, true);
    actualizarHistorial(v);
    const listo = modo === "deshacer" ? `↶ Deshecho: ${donde} ${cambios.length > 1 ? "volvieron a como estaban" : "volvió a como estaba"} · ${horaCorta(ahora)}`
      : `✓ ${cambios.length > 1 ? `Pegadas ${donde}` : "Guardado " + donde} en Google Sheets · ${horaCorta(ahora)} · Ctrl+Z deshace`;
    avisar(listo, "ok");
    // Al registro de gestiones (si el config lo trae). Las celdas ya quedaron guardadas.
    try {
      if (google().registrar) await google().registrar(cambios.map((k, n) => ({ hoja: `${v.archivo.name} · ${k.hoja}`, ubicacion: refCelda(k),
        columna: "", antes: k.antesVisto, despues: vistos[n] })));
    } catch (e) {
      avisar(listo + " · ⚠️ No quedó en el registro de gestiones: " + e.message, "ambar");
    }
    return true;
  }

  // Ctrl+Z: deshace el último cambio hecho en este archivo (una edición o un pegado entero).
  async function deshacer(v) {
    if (!v.editable) return;
    let n = pilaDeshacer.length - 1;
    while (n >= 0 && pilaDeshacer[n].id !== v.id) n--;
    if (n < 0) { avisar("No hay nada que deshacer en esta hoja", "gris"); return; }
    const [grupo] = pilaDeshacer.splice(n, 1);
    const cambios = grupo.cambios.map((k) => ({ ...k, td: tdDe(v, k) }));
    const primera = cambios.find((k) => k.td);
    if (primera) seleccionar(v, Number(primera.td.dataset.i), Number(primera.td.dataset.j));
    if (!(await escribirCeldas(v, cambios, "deshacer"))) { pilaDeshacer.splice(n, 0, grupo); actualizarHistorial(v); }
  }

  function actualizarHistorial(v) {
    const b = ventana.querySelector(".visor-deshacer");
    if (b) b.disabled = !pilaDeshacer.some((g) => g.id === v.id);
    const boton = ventana.querySelector(".visor-cambios-boton");
    if (boton) { boton.hidden = !misCambios.length; boton.querySelector(".visor-cambios-n").textContent = misCambios.length; }
    const panel = ventana.querySelector(".visor-panel-cambios");
    if (panel) pintarCambios(v, panel);
  }

  function alternarCambios(v, boton) {
    const abierto = ventana.querySelector(".visor-panel-cambios");
    boton.setAttribute("aria-expanded", String(!abierto));
    if (abierto) { abierto.remove(); return; }
    cerrarFlotantes();
    const panel = nodo("div", { class: "visor-panel-cambios", role: "dialog", "aria-label": "Mis cambios" });
    panel.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault(); ev.stopPropagation();
      panel.remove(); boton.setAttribute("aria-expanded", "false"); boton.focus();
    });
    pintarCambios(v, panel);
    ventana.append(panel);
    const caja = ventana.getBoundingClientRect(), b = boton.getBoundingClientRect();
    panel.style.top = (b.bottom - caja.top + 6) + "px";
    panel.style.right = Math.max(8, caja.right - b.right) + "px";
    const primero = panel.querySelector("button");
    if (primero) primero.focus();
  }

  function pintarCambios(v, panel) {
    panel.replaceChildren(
      nodo("div", { class: "vpc-titulo" }, nodo("strong", { text: "Mis cambios" }),
        nodo("span", { text: misCambios.length === 1 ? "1 en esta sesión" : `${misCambios.length} en esta sesión` })),
      misCambios.length
        ? nodo("ol", { class: "vpc-lista" }, ...misCambios.map((k) => nodo("li", null,
          nodo("button", { type: "button", class: "vpc-item" + (k.deshecho ? " deshecho" : ""), title: "Ir a esta celda", onclick: () => irACambio(v, k) },
            nodo("span", { class: "vpc-donde" }, nodo("b", { text: refCelda(k) }),
              ` · ${k.hoja}` + (k.id !== v.id ? ` · ${partesTitulo(k.archivo).principal}` : "")),
            nodo("span", { class: "vpc-hora", text: (k.deshecho ? "↶ deshecho · " : "") + horaCorta(k.hora) }),
            nodo("span", { class: "vpc-valores" },
              nodo("s", { text: k.antes || "(vacía)" }), nodo("span", { "aria-hidden": "true", text: " → " }), nodo("b", { text: k.despues || "(vacía)" }))))))
        : nodo("p", { class: "vpc-vacio", text: "Todavía no has cambiado nada." }),
      nodo("p", { class: "vpc-pie", text: "Solo en esta pestaña: se borra al cerrar la sesión." }));
  }

  function irACambio(v, k) {
    cerrarFlotantes();
    if (k.id === v.id && v.hoja && k.sheetId === v.hoja.sheetId) { irACelda(v, k.f, k.c); return; }
    celdaPendiente = { id: k.id, f: k.f, c: k.c };
    if (k.id === v.id) cambiarPestana(v, v.hojas.find((h) => h.sheetId === k.sheetId));
    else abrirVisor(k.id, k.sheetId, null);
  }

  function irACelda(v, f, c) {
    if (!irA(v, f, c)) return;
    enfocarCuerpo();
    const td = v.mapa.get(v.sel.i + ":" + v.sel.j);
    if (td) { td.classList.add("celda-guardada"); setTimeout(() => td.classList.remove("celda-guardada"), 1600); }
  }

  // Cierra el menú, «Mis cambios» y la confirmación de pegado. Devuelve si había algo abierto.
  function cerrarFlotantes() {
    let algo = false;
    for (const e of ventana.querySelectorAll(".visor-menu, .visor-panel-cambios")) { e.remove(); algo = true; }
    const b = ventana.querySelector(".visor-cambios-boton");
    if (b) b.setAttribute("aria-expanded", "false");
    const c = ventana.querySelector(".visor-confirmar");
    if (c) { c.cerrar(); algo = true; }
    return algo;
  }

  // ------------------------------------------------------------------ buscar en la hoja (Ctrl+F)
  // Busca en lo que está cargado de la pestaña, sin tildes ni mayúsculas. Si se escriben solo
  // cifras, se comparan solo las cifras: «71712176» encuentra «71.712.176».
  const normalizar = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const soloCifras = (t) => String(t || "").replace(/\D/g, "");

  function abrirBuscador(v) {
    let caja = ventana.querySelector(".visor-buscar");
    if (!caja) caja = crearBuscador(v);
    caja.hidden = false;
    const barra = ventana.querySelector(".visor-barra");
    caja.style.top = (barra.offsetTop + barra.offsetHeight + 8) + "px";
    const entrada = caja.querySelector("input");
    entrada.focus();
    entrada.select();
    if (entrada.value) caja.buscar();
  }

  function crearBuscador(v) {
    const entrada = nodo("input", { type: "text", class: "vb-entrada", placeholder: "Buscar en esta hoja", "aria-label": "Buscar en esta hoja", spellcheck: "false" });
    const conteo = nodo("span", { class: "vb-conteo", "aria-live": "polite" });
    let hallazgos = [], actual = -1, temporizadorBusqueda = null;
    const limpiar = () => ventana.querySelectorAll(".visor-tabla td.vb-hallada, .visor-tabla td.vb-actual")
      .forEach((td) => td.classList.remove("vb-hallada", "vb-actual"));
    const ir = () => {
      ventana.querySelectorAll(".visor-tabla td.vb-actual").forEach((td) => td.classList.remove("vb-actual"));
      const td = hallazgos[actual];
      td.classList.add("vb-actual");
      seleccionar(v, Number(td.dataset.i), Number(td.dataset.j));
      conteo.textContent = `${actual + 1} de ${hallazgos.length}`;
    };
    const saltar = (d) => { if (!hallazgos.length) return; actual = (actual + d + hallazgos.length) % hallazgos.length; ir(); };
    const buscar = () => {
      limpiar();
      hallazgos = []; actual = -1;
      const q = normalizar(entrada.value);
      const cifras = /^[\d\s.,$]+$/.test(entrada.value.trim()) ? soloCifras(entrada.value) : "";
      if (!q) { conteo.textContent = ""; return; }
      const vistas = new Set();
      for (let i = 0; i < v.visF.length; i++) {
        for (let j = 0; j < v.visC.length; j++) {
          const td = v.mapa.get(i + ":" + j);
          if (!td || vistas.has(td)) continue;
          vistas.add(td);
          const texto = td._celda.formattedValue || "";
          if (cifras ? soloCifras(texto).includes(cifras) : normalizar(texto).includes(q)) { hallazgos.push(td); td.classList.add("vb-hallada"); }
        }
      }
      if (!hallazgos.length) { conteo.textContent = "Sin resultados"; return; }
      // Primero el que sigue a la celda activa, como en Sheets.
      actual = hallazgos.findIndex((td) => Number(td.dataset.i) > v.sel.i || (Number(td.dataset.i) === v.sel.i && Number(td.dataset.j) >= v.sel.j));
      if (actual < 0) actual = 0;
      ir();
    };
    entrada.addEventListener("input", () => { clearTimeout(temporizadorBusqueda); temporizadorBusqueda = setTimeout(buscar, 120); });
    entrada.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(temporizadorBusqueda); if (actual < 0) buscar(); else saltar(ev.shiftKey ? -1 : 1); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cerrarBuscador(true); }
    });
    const caja = nodo("div", { class: "visor-buscar", role: "search" },
      nodo("span", { class: "vb-lupa", "aria-hidden": "true", text: "🔍" }), entrada, conteo,
      nodo("button", { type: "button", title: "Anterior (Shift+Enter)", "aria-label": "Anterior", text: "↑", onclick: () => saltar(-1) }),
      nodo("button", { type: "button", title: "Siguiente (Enter)", "aria-label": "Siguiente", text: "↓", onclick: () => saltar(1) }),
      nodo("button", { type: "button", title: "Cerrar (Esc)", "aria-label": "Cerrar la búsqueda", text: "✕", onclick: () => cerrarBuscador(true) }));
    caja.buscar = buscar;
    caja.limpiar = () => { limpiar(); hallazgos = []; actual = -1; conteo.textContent = ""; };
    ventana.append(caja);
    return caja;
  }

  function cerrarBuscador(enfocar) {
    const caja = ventana.querySelector(".visor-buscar");
    if (!caja || caja.hidden) return false;
    caja.hidden = true;
    caja.limpiar();
    if (enfocar) enfocarCuerpo();
    return true;
  }

  // ------------------------------------------------------------------ clic derecho en una celda
  function menuCelda(v, ev) {
    const td = ev.target.closest(".visor-tabla td");
    if (!td || td.classList.contains("celda-editando")) return;
    ev.preventDefault();
    const i = Number(td.dataset.i), j = Number(td.dataset.j);
    const r = rangoSeleccionado(v);
    if (i < r.i0 || i > r.i1 || j < r.j0 || j > r.j1) seleccionar(v, i, j, false);
    enfocarCuerpo();
    cerrarFlotantes();
    const sel = rangoSeleccionado(v);
    const f = v.visF[sel.i0], c = v.visC[sel.j0];
    const enlace = v.excel || !v.hoja ? v.archivo.webViewLink
      : `https://docs.google.com/spreadsheets/d/${v.id}/edit#gid=${v.hoja.sheetId}&range=${letra(c)}${f + 1}`;
    let menu = null;
    const opcion = (texto, atajo, hacer, desactivada) => nodo("button", { type: "button", role: "menuitem", class: "vm-item", disabled: desactivada,
      onclick: () => { menu.remove(); hacer(); } }, nodo("span", { text: texto }), atajo ? nodo("kbd", { text: atajo }) : null);
    menu = nodo("div", { class: "visor-menu", role: "menu", "aria-label": "Opciones de la celda" },
      opcion("Copiar", "Ctrl+C", () => { copiarRango(v, sel); enfocarCuerpo(); }),
      v.editable ? opcion("Pegar", "Ctrl+V", () => pegarDelPortapapeles(v)) : null,
      opcion(sel.i0 === sel.i1 ? "Copiar fila completa" : "Copiar filas completas", "", () => {
        seleccionarRango(v, sel.i0, 0, sel.i1, v.visC.length - 1);
        copiarRango(v, rangoSeleccionado(v));
        enfocarCuerpo();
      }),
      v.editable ? opcion("Deshacer", "Ctrl+Z", () => { enfocarCuerpo(); deshacer(v); }, !pilaDeshacer.some((g) => g.id === v.id)) : null,
      nodo("div", { class: "vm-separador", role: "separator" }),
      opcion("Buscar en la hoja", "Ctrl+F", () => abrirBuscador(v)),
      enlace ? opcion("Abrir esta celda en Google Sheets ↗", "", () => { window.open(enlace, "_blank", "noopener"); }) : null);
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll(".vm-item:not([disabled])")];
      const k = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        items[(k + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault(); e.stopPropagation();
        menu.remove(); enfocarCuerpo();
      }
    });
    ventana.append(menu);
    const caja = ventana.getBoundingClientRect();
    const x = ev.clientX - caja.left, y = ev.clientY - caja.top;
    const m = menu.getBoundingClientRect();
    menu.style.left = (x + m.width > caja.width - 8 ? Math.max(8, x - m.width) : x) + "px";
    menu.style.top = (y + m.height > caja.height - 8 ? Math.max(8, y - m.height) : y) + "px";
    menu.querySelector(".vm-item:not([disabled])").focus();
  }

  async function pegarDelPortapapeles(v) {
    enfocarCuerpo();
    let texto;
    try {
      texto = await navigator.clipboard.readText();
    } catch (_) {
      avisar("El navegador no dejó leer el portapapeles desde el menú: usa Ctrl+V", "ambar");
      return;
    }
    pegar(v, texto);
  }

  // ------------------------------------------------------------------ edición
  function textoEditable(celda) {
    const u = celda.userEnteredValue || {};
    if ("formulaValue" in u) return u.formulaValue;
    if ("stringValue" in u) return u.stringValue;
    if ("numberValue" in u) return celda.formattedValue || String(u.numberValue);
    if ("boolValue" in u) return u.boolValue ? "TRUE" : "FALSE";
    return celda.formattedValue || "";
  }

  // inicial: la tecla con la que se empezó a escribir (reemplaza el contenido, como en Sheets).
  function editar(v, td, inicial) {
    if (td.classList.contains("celda-editando")) return;
    const celda = td._celda;
    const original = textoEditable(celda);
    const entrada = nodo("input", { class: "visor-entrada", type: "text", "aria-label": "Valor de la celda" });
    entrada.value = inicial === undefined ? original : inicial;
    td.classList.add("celda-editando");
    td.replaceChildren(entrada);
    entrada.focus();
    if (inicial === undefined) entrada.select();
    if (celda.userEnteredValue && "formulaValue" in celda.userEnteredValue) avisar("⚠️ Esta celda tiene una fórmula: si la cambias, la reemplazas", "ambar");

    let cerrada = false;
    const cerrar = (guardarCambio, di, dj) => {
      if (cerrada) return;
      cerrada = true;
      td.classList.remove("celda-editando");
      const nuevo = entrada.value;
      if (!guardarCambio || nuevo === original) { escribirContenido(td, celda); avisar("", ""); }
      else escribirCeldas(v, [cambioDe(v, td, nuevo)], "editar");
      enfocarCuerpo();
      if (di || dj) mover(v, di, dj);
    };
    entrada.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); cerrar(true, ev.shiftKey ? -1 : 1, 0); }
      else if (ev.key === "Tab") { ev.preventDefault(); cerrar(true, 0, ev.shiftKey ? -1 : 1); }
      else if (ev.key === "Escape") { ev.preventDefault(); cerrar(false); }
    });
    entrada.addEventListener("blur", () => cerrar(true));
  }

  // ------------------------------------------------------------------ mover la ventana
  function arrastrable(asa) {
    asa.addEventListener("pointerdown", (ev) => {
      // Sobre el nombre no se arrastra: ahí se selecciona el texto para copiarlo.
      if (ev.target.closest("button, a, .visor-titulo") || ventana.classList.contains("maximizada")) return;
      const caja = ventana.getBoundingClientRect();
      const dx = ev.clientX - caja.left, dy = ev.clientY - caja.top;
      asa.setPointerCapture(ev.pointerId);
      const mover = (m) => {
        ventana.style.margin = "0";
        ventana.style.left = Math.max(0, Math.min(window.innerWidth - 120, m.clientX - dx)) + "px";
        ventana.style.top = Math.max(0, Math.min(window.innerHeight - 60, m.clientY - dy)) + "px";
      };
      const soltar = () => { asa.removeEventListener("pointermove", mover); asa.removeEventListener("pointerup", soltar); };
      asa.addEventListener("pointermove", mover);
      asa.addEventListener("pointerup", soltar);
    });
  }

  // ------------------------------------------------------------------ enganche con app.js
  // app.js llama a esto con cada enlace a una hoja (ver enlaceHoja). Sin sesión de Google,
  // o si no es un archivo de Google, el enlace queda como estaba.
  window.axioMejorarEnlace = function (a, url) {
    const id = idDeArchivo(url || "");
    if (!id || !/^https:\/\/(docs|drive)\.google\.com\//.test(url)) return;
    a.addEventListener("mouseenter", () => {
      if (!google() || !google().conectado()) return;
      clearTimeout(temporizador);
      temporizador = setTimeout(() => mostrarPrevia(a, id), 350);
    });
    a.addEventListener("mouseleave", ocultarPrevia);
    // Solo las hojas de cálculo se abren dentro de Axio; un PDF u otro archivo sigue su enlace.
    // Ctrl/Shift + clic: como siempre, en otra pestaña.
    if (!/\/spreadsheets\/d\//.test(url)) return;
    a.addEventListener("click", (ev) => {
      if (!google() || !google().conectado() || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      ev.preventDefault();
      ev.stopPropagation();
      abrirVisor(id, gidDe(url), url);
    });
  };
})();
