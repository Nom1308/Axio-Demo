/* Axio demo: las hojas de Google de cada obligación, sin salir de Axio.
 *
 * - Al pasar el mouse por un enlace a una hoja (🔗 Ver obligación, ↗ de un campo), una
 *   tarjeta con su miniatura, nombre, propietario y si se puede editar.
 * - Al hacer clic, la tabla se abre en una ventana pequeña dentro de Axio, con sus colores,
 *   celdas combinadas y pestañas. Doble clic (o Enter) en una celda para escribir; Enter
 *   guarda en la hoja real de Google.
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
  const ventana = nodo("dialog", { class: "visor-hoja", "aria-label": "Hoja de Google" });
  document.body.append(ventana);
  ventana.addEventListener("cancel", (ev) => { if (ventana.querySelector(".celda-editando")) ev.preventDefault(); });

  let visor = null;   // { id, archivo, hojas, hoja, editable, celdas }

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
      const libro = await apiGoogle(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=${encodeURIComponent("sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))")}`);
      const hojas = libro.sheets.map((h) => h.properties);
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
      v ? nodo("span", { class: v.editable ? "visor-insignia editable" : "visor-insignia", text: v.editable ? "Puedes editar" : v.excel ? "Excel · solo lectura" : "Solo lectura" }) : null,
      estado,
      v ? nodo("a", { class: "boton boton-chico", href: v.archivo.webViewLink || `https://docs.google.com/spreadsheets/d/${v.id}/edit${v.hoja && !v.excel ? "#gid=" + v.hoja.sheetId : ""}`,
        target: "_blank", rel: "noopener noreferrer", text: "Abrir en Google Sheets ↗" }) : null,
      nodo("button", { class: "boton boton-texto boton-cerrar", type: "button", "aria-label": "Cerrar", text: "✕", onclick: () => ventana.close() }));
    arrastrable(cabecera);
    return cabecera;
  }

  function avisar(texto, clase) {
    const e = ventana.querySelector("#visor-estado");
    if (e) { e.textContent = texto; e.className = "visor-estado " + (clase || ""); }
  }

  async function cargarHoja() {
    const v = visor;
    ventana.replaceChildren(cabeceraVisor(v), pestanas(v), nodo("div", { class: "visor-cuerpo" },
      nodo("p", { class: "visor-nota", text: "⏳ Cargando " + (v.hoja ? v.hoja.title : v.archivo.name) + "…" })));
    let libro, filas, cols;
    if (v.excel) {
      const r = await google().leerExcel(v.id, v.hoja ? v.hoja.title : "", MAX_FILAS, MAX_COLUMNAS);
      v.hojas = r.hojas.map((titulo, i) => ({ sheetId: i, title: titulo }));
      v.hoja = v.hojas.find((h) => h.title === r.hoja) || v.hojas[0];
      v.recortada = r.recortada;
      libro = r.libro;
      const rowData = libro.sheets[0].data[0].rowData;
      filas = rowData.length;
      cols = Math.max(1, ...rowData.map((f) => f.values.length));
      ventana.querySelector(".visor-pestanas").replaceWith(pestanas(v));
    } else {
      filas = Math.min(v.hoja.gridProperties.rowCount || MAX_FILAS, MAX_FILAS);
      cols = Math.min(v.hoja.gridProperties.columnCount || 26, MAX_COLUMNAS);
      const r = `'${v.hoja.title.replace(/'/g, "''")}'!A1:${letra(cols - 1)}${filas}`;
      const campos = "sheets(merges,data(columnMetadata(pixelSize),rowMetadata(pixelSize),rowData(values(" +
        "formattedValue,hyperlink,userEnteredValue,effectiveValue(numberValue)," +
        "effectiveFormat(backgroundColor,horizontalAlignment,textFormat(bold,italic,foregroundColor,fontSize))))))";
      libro = await apiGoogle(`https://sheets.googleapis.com/v4/spreadsheets/${v.id}?ranges=${encodeURIComponent(r)}&includeGridData=true&fields=${encodeURIComponent(campos)}`);
      v.recortada = (v.hoja.gridProperties.rowCount || 0) > MAX_FILAS || (v.hoja.gridProperties.columnCount || 0) > MAX_COLUMNAS;
    }
    v.datos = (libro.sheets[0].data || [])[0] || {};
    v.merges = libro.sheets[0].merges || [];
    ventana.querySelector(".visor-cuerpo").replaceChildren(tabla(v, filas, cols));
    avisar(v.editable ? "Doble clic en una celda para escribir"
      : v.excel ? "Es un archivo de Excel guardado en Drive: para editarlo, ábrelo en Google Sheets" : "", "gris");
  }

  function pestanas(v) {
    if (v.hojas.length < 2) return nodo("div", { class: "visor-pestanas vacio" });
    const barra = nodo("div", { class: "visor-pestanas", role: "tablist" });
    for (const h of v.hojas) {
      barra.append(nodo("button", { type: "button", role: "tab", class: "visor-pestana" + (h.sheetId === v.hoja.sheetId ? " activa" : ""),
        "aria-selected": String(h.sheetId === v.hoja.sheetId), text: h.title,
        onclick: () => { if (h.sheetId !== v.hoja.sheetId) { v.hoja = h; cargarHoja().catch((e) => avisar("❌ " + e.message, "error")); } } }));
    }
    return barra;
  }

  function tabla(v, filas, cols) {
    const datos = v.datos;
    const filasDatos = datos.rowData || [];
    // Celdas combinadas: la de arriba a la izquierda lleva colspan/rowspan; las demás no se dibujan.
    const cubiertas = new Set();
    const combinadas = new Map();
    for (const m of v.merges) {
      for (let f = m.startRowIndex; f < Math.min(m.endRowIndex, filas); f++) {
        for (let c = m.startColumnIndex; c < Math.min(m.endColumnIndex, cols); c++) cubiertas.add(f + ":" + c);
      }
      cubiertas.delete(m.startRowIndex + ":" + m.startColumnIndex);
      combinadas.set(m.startRowIndex + ":" + m.startColumnIndex,
        { filas: Math.min(m.endRowIndex, filas) - m.startRowIndex, cols: Math.min(m.endColumnIndex, cols) - m.startColumnIndex });
    }
    const anchos = (datos.columnMetadata || []).map((c) => Math.max(40, Math.min(c.pixelSize || 100, 360)));
    const grupoCols = nodo("colgroup", null, nodo("col", { style: "width:42px" }));
    for (let c = 0; c < cols; c++) grupoCols.append(nodo("col", { style: `width:${anchos[c] || 100}px` }));

    const cabeza = nodo("tr", null, nodo("th", { class: "visor-esquina" }));
    for (let c = 0; c < cols; c++) cabeza.append(nodo("th", { text: letra(c) }));
    const cuerpo = nodo("tbody");
    for (let f = 0; f < filas; f++) {
      const valores = (filasDatos[f] || {}).values || [];
      const alto = ((datos.rowMetadata || [])[f] || {}).pixelSize;
      const tr = nodo("tr", alto && alto > 21 ? { style: `height:${Math.min(alto, 120)}px` } : null, nodo("th", { text: String(f + 1) }));
      for (let c = 0; c < cols; c++) {
        if (cubiertas.has(f + ":" + c)) continue;
        const celda = valores[c] || {};
        const comb = combinadas.get(f + ":" + c);
        tr.append(pintarCelda(v, celda, f, c, comb));
      }
      cuerpo.append(tr);
    }
    const t = nodo("table", { class: "visor-tabla" }, grupoCols, nodo("thead", null, cabeza), cuerpo);
    const envoltura = nodo("div", { class: "visor-tabla-envoltura" }, t);
    if (v.recortada) envoltura.append(nodo("p", { class: "visor-nota", text: `Se muestran las primeras ${filas} filas y ${cols} columnas. El resto, en «Abrir en Google Sheets».` }));
    return envoltura;
  }

  function pintarCelda(v, celda, f, c, comb) {
    const formato = celda.effectiveFormat || {};
    const texto = formato.textFormat || {};
    const estilos = [];
    const fondo = color(formato.backgroundColor);
    if (fondo) estilos.push("background:" + fondo);
    const letraColor = color(texto.foregroundColor);
    if (letraColor && letraColor !== "rgb(0,0,0)") estilos.push("color:" + letraColor);
    if (texto.bold) estilos.push("font-weight:700");
    if (texto.italic) estilos.push("font-style:italic");
    const alineacion = formato.horizontalAlignment || (celda.effectiveValue && "numberValue" in celda.effectiveValue ? "RIGHT" : "LEFT");
    estilos.push("text-align:" + alineacion.toLowerCase());

    const td = nodo("td", {
      style: estilos.join(";"), colspan: comb && comb.cols > 1 ? comb.cols : null, rowspan: comb && comb.filas > 1 ? comb.filas : null,
      tabindex: v.editable ? "0" : null, "data-f": f, "data-c": c,
      title: celda.userEnteredValue && celda.userEnteredValue.formulaValue ? "Fórmula: " + celda.userEnteredValue.formulaValue : null,
    });
    escribirContenido(td, celda);
    if (v.editable) {
      td.addEventListener("dblclick", () => editar(v, td, celda));
      td.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === "F2") { ev.preventDefault(); editar(v, td, celda); } });
    }
    return td;
  }

  function escribirContenido(td, celda) {
    const valor = celda.formattedValue || "";
    td.replaceChildren(celda.hyperlink && /^https?:\/\//i.test(celda.hyperlink)
      ? nodo("a", { href: celda.hyperlink, target: "_blank", rel: "noopener noreferrer", text: valor || celda.hyperlink })
      : valor);
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

  function editar(v, td, celda) {
    if (td.classList.contains("celda-editando")) return;
    const original = textoEditable(celda);
    const entrada = nodo("input", { class: "visor-entrada", type: "text", "aria-label": "Valor de la celda" });
    entrada.value = original;
    td.classList.add("celda-editando");
    td.replaceChildren(entrada);
    entrada.focus();
    entrada.select();
    if (celda.userEnteredValue && "formulaValue" in celda.userEnteredValue) avisar("⚠️ Esta celda tiene una fórmula: si la cambias, la reemplazas", "ambar");

    let cerrada = false;
    const cerrar = (guardarCambio) => {
      if (cerrada) return;
      cerrada = true;
      td.classList.remove("celda-editando");
      const nuevo = entrada.value;
      if (!guardarCambio || nuevo === original) { escribirContenido(td, celda); avisar("", ""); td.focus(); return; }
      guardar(v, td, celda, nuevo);
    };
    entrada.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); cerrar(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); cerrar(false); }
    });
    entrada.addEventListener("blur", () => cerrar(true));
  }

  async function guardar(v, td, celda, texto) {
    const f = Number(td.dataset.f), c = Number(td.dataset.c);
    const r = rango(v.hoja.title, f, c);
    td.classList.add("celda-guardando");
    td.textContent = texto;
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
      avisar(`✓ Guardado en Google Sheets · ${letra(c)}${f + 1} · ${new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}`, "ok");
    } catch (e) {
      td.classList.remove("celda-guardando");
      escribirContenido(td, celda);
      avisar("❌ No se guardó: " + e.message, "error");
    }
  }

  // ------------------------------------------------------------------ mover la ventana
  function arrastrable(asa) {
    asa.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest("button, a")) return;
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
