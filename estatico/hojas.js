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
  ventana.addEventListener("cancel", (ev) => { if (ventana.querySelector(".celda-editando")) ev.preventDefault(); });

  const ALTO_CABECERA = 22;   // fila de letras A, B, C...
  const ANCHO_NUMEROS = 46;   // columna de números de fila
  const NIVELES_ZOOM = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
  let zoom = 100;
  try { zoom = NIVELES_ZOOM.includes(Number(localStorage.getItem("axio-visor-zoom"))) ? Number(localStorage.getItem("axio-visor-zoom")) : 100; } catch (_) { /* sin almacenamiento */ }

  let visor = null;   // { id, archivo, hojas, hoja, editable, datos, merges, visF, visC, mapa, sel }

  async function abrirVisor(id, gid) {
    ocultarPrevia();
    ventana.replaceChildren(cabeceraVisor(null), nodo("div", { class: "visor-cuerpo" }, nodo("p", { class: "visor-nota", text: "⏳ Abriendo la hoja…" })));
    if (!ventana.open) ventana.showModal();
    try {
      const archivo = await datosArchivo(id);
      if (esExcel(archivo)) {
        visor = { id, archivo, excel: true, hojas: [], hoja: null, editable: false };
        await cargarHoja();
        return;
      }
      const libro = await apiGoogle(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=${encodeURIComponent(
        "sheets.properties(sheetId,title,index,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))")}`);
      const hojas = libro.sheets.map((h) => h.properties).filter((h) => !h.hidden || h.sheetId === gid);
      const hoja = hojas.find((h) => h.sheetId === gid) || hojas[0];
      visor = { id, archivo, hojas, hoja, editable: Boolean(archivo.capabilities && archivo.capabilities.canEdit && google().puedeEscribir()) };
      await cargarHoja();
    } catch (e) {
      ventana.querySelector(".visor-cuerpo").replaceChildren(nodo("p", { class: "visor-nota error", text: "No se pudo abrir la hoja: " + e.message + "." }));
    }
  }

  function cabeceraVisor(v) {
    const estado = nodo("span", { class: "visor-estado", id: "visor-estado" });
    const cabecera = nodo("div", { class: "visor-cabecera" },
      nodo("span", { class: "icono-sheets", "aria-hidden": "true" }),
      nodo("strong", { class: "visor-titulo", text: v ? v.archivo.name : "Hoja de Google", title: v ? v.archivo.name : null }),
      // El nombre del archivo trae código, cédula y nombre: Cartera lo copia seguido.
      v ? nodo("button", { class: "boton boton-texto visor-copiar-titulo", type: "button", title: "Copiar el nombre completo de la hoja",
        "aria-label": "Copiar el nombre de la hoja", text: "📋", onclick: () => copiarTexto(v.archivo.name, "📋 Nombre de la hoja copiado") }) : null,
      v ? nodo("span", { class: v.editable ? "visor-insignia editable" : "visor-insignia", text: v.editable ? "Puedes editar" : v.excel ? "Excel · solo lectura" : "Solo lectura" }) : null,
      estado,
      v ? nodo("a", { class: "boton boton-chico", href: v.archivo.webViewLink || `https://docs.google.com/spreadsheets/d/${v.id}/edit${v.hoja && !v.excel ? "#gid=" + v.hoja.sheetId : ""}`,
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
        text: "📋 Copiar encabezado", onclick: () => copiarEncabezado(v) }),
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
      libro = r.libro;
      const rowData = libro.sheets[0].data[0].rowData;
      filas = rowData.length;
      cols = Math.max(1, ...rowData.map((f) => f.values.length));
      ventana.querySelector(".visor-pestanas").replaceWith(pestanas(v));
    } else {
      const g = v.hoja.gridProperties || {};
      filas = Math.min(g.rowCount || MAX_FILAS, MAX_FILAS);
      cols = Math.min(g.columnCount || 26, MAX_COLUMNAS);
      v.congeladas = { filas: g.frozenRowCount || 0, cols: g.frozenColumnCount || 0 };
      const r = `'${v.hoja.title.replace(/'/g, "''")}'!A1:${letra(cols - 1)}${filas}`;
      const campos = "sheets(merges,data(columnMetadata(pixelSize,hiddenByUser),rowMetadata(pixelSize,hiddenByUser,hiddenByFilter),rowData(values(" +
        "formattedValue,hyperlink,userEnteredValue,effectiveValue(numberValue)," +
        "effectiveFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,borders," +
        "textFormat(bold,italic,underline,strikethrough,foregroundColor,fontSize,fontFamily))))))";
      libro = await apiGoogle(`https://sheets.googleapis.com/v4/spreadsheets/${v.id}?ranges=${encodeURIComponent(r)}&includeGridData=true&fields=${encodeURIComponent(campos)}`);
      v.recortada = (g.rowCount || 0) > MAX_FILAS || (g.columnCount || 0) > MAX_COLUMNAS;
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
    avisar(v.editable ? "Doble clic o Enter en una celda para escribir"
      : v.excel ? "Es un archivo de Excel guardado en Drive: para editarlo, ábrelo en Google Sheets" : "", "gris");
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
    for (let f = 0; f < filas; f++) if (!((metaF[f] || {}).hiddenByUser || (metaF[f] || {}).hiddenByFilter)) visF.push(f);
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
    if (v.recortada) envoltura.append(nodo("p", { class: "visor-nota", text: `Se muestran las primeras ${filas} filas y ${cols} columnas. El resto, en «Abrir en Google Sheets».` }));
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
          else if (ctrl && (ev.key === "c" || ev.key === "C")) copiarRango(v, rangoSeleccionado(v));
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

  async function copiarRango(v, r) {
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
      else guardar(v, td, celda, nuevo);
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

  async function guardar(v, td, celda, texto) {
    const f = Number(td.dataset.f), c = Number(td.dataset.c);
    const r = rango(v.hoja.title, f, c);
    const antes = celda.formattedValue || "";
    td.classList.add("celda-guardando");
    td.replaceChildren(nodo("div", { class: "visor-c" }, texto));
    avisar("⏳ Guardando " + letra(c) + (f + 1) + "…", "gris");
    try {
      const resp = await apiGoogle(`https://sheets.googleapis.com/v4/spreadsheets/${v.id}/values/${encodeURIComponent(r)}` +
        "?valueInputOption=USER_ENTERED&includeValuesInResponse=true&responseValueRenderOption=FORMATTED_VALUE", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ range: r, majorDimension: "ROWS", values: [[texto]] }),
      });
      const nuevo = (((resp.updatedData || {}).values || [[]])[0] || [])[0];
      celda.formattedValue = nuevo === undefined ? "" : String(nuevo);
      celda.userEnteredValue = texto.startsWith("=") ? { formulaValue: texto } : { stringValue: texto };
      escribirContenido(td, celda);
      td.classList.remove("celda-guardando");
      td.classList.add("celda-guardada");
      setTimeout(() => td.classList.remove("celda-guardada"), 1600);
      if (td.classList.contains("sel")) seleccionar(v, v.sel.i, v.sel.j, false);
      const guardado = `✓ Guardado en Google Sheets · ${letra(c)}${f + 1} · ${new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}`;
      avisar(guardado, "ok");
      // Al registro de gestiones (si el config lo trae). La celda ya quedó guardada.
      try {
        if (google().registrar) await google().registrar([{ hoja: `${v.archivo.name} · ${v.hoja.title}`, ubicacion: `${letra(c)}${f + 1}`,
          columna: "", antes, despues: texto }]);
      } catch (e) {
        avisar(guardado + " · ⚠️ No quedó en el registro de gestiones: " + e.message, "ambar");
      }
    } catch (e) {
      td.classList.remove("celda-guardando");
      escribirContenido(td, celda);
      avisar("❌ No se guardó: " + e.message, "error");
    }
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
      abrirVisor(id, gidDe(url));
    });
  };
})();
