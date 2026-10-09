/* Axio demo: gestionar un pago de los Extractos (la Matriz_Nube) sin salir de Axio.
 *
 * En el detalle de un pago aparece «Gestionar en la Matriz» con las cuatro casillas que
 * llena la gente: RWS (Recaudos), NOTA CARTERA y CREDITO (Cartera) y NOTA RECAUDO (cuando
 * hay un problema). Axio solo escribe esos valores: los colores los pone la propia Matriz
 * con su formato condicional, igual que si se escribieran a mano.
 *
 * Cómo se encuentra la fila: Axio busca los Extractos en una copia (CSV) que no trae número
 * de fila, así que el pago se ubica en la hoja real por su contenido (cédula, fecha, valor,
 * banco...). Justo antes de guardar se vuelve a leer esa fila y se comprueba que sigue
 * siendo el mismo pago y que nadie llenó las casillas mientras tanto: si José insertó
 * filas o alguien más la gestionó, no se escribe nada y se avisa.
 *
 * Todo pasa con la cuenta de quien inició sesión (window.axioGoogle, de puente.js): Google
 * aplica sus permisos. Quien solo puede ver la Matriz, ve las casillas sin poder guardar.
 */
(function () {
  "use strict";

  const google = () => window.axioGoogle;
  const VIGENCIA_COPIA_MS = 5 * 60 * 1000;   // tras esto se vuelve a leer la Matriz completa

  // Mismos estados y colores que clasificar_estado_pago (axio/dominio/buscador.py).
  const ESTADOS = {
    referencia_erronea: { clave: "referencia_erronea", etiqueta: "Referencia no encontrada", icono: "⚠️", color: "#FF7EB6" },
    ingresado: { clave: "ingresado", etiqueta: "Ingresado (RWS)", icono: "🟢", color: "#30D158" },
    gestion_cartera: { clave: "gestion_cartera", etiqueta: "En gestión de Cartera", icono: "🟠", color: "#FF9F0A" },
    pendiente_recaudo: { clave: "pendiente_recaudo", etiqueta: "Pendiente Recaudo", icono: "🔴", color: "#FF0000" },
  };
  const ERRORES_EXCEL = ["#N/A", "#REF!", "#VALUE!", "#NAME?", "#NULL!", "#DIV/0!"];

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

  const letra = (i) => { let s = ""; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  const comillas = (titulo) => `'${titulo.replace(/'/g, "''")}'`;
  const mayus = (s) => String(s == null ? "" : s).trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const lleno = (v) => !["", "NAN", "NONE"].includes(mayus(v));
  const hora = () => new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });

  // Un valor tal como lo dejan comparable tanto la hoja ("$ 1.200.000", "5/10/2026") como
  // la copia de Axio ("1,200,000", "05/10/2026"): fechas a a-m-d, números solo con sus
  // dígitos, textos sin tildes ni signos.
  function comparable(v) {
    const s = mayus(v);
    if (!s) return "";
    let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(s);
    if (m) return `F${m[3]}-${+m[2]}-${+m[1]}`;
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s);
    if (m) return `F${m[1]}-${+m[2]}-${+m[3]}`;
    const n = s.replace(/[$\s]/g, "");
    if (/^-?[\d.,]*\d[\d.,]*$/.test(n)) return "N" + n.replace(/[.,]0{1,2}$/, "").replace(/[.,]/g, "").replace(/^(-?)0+(?=\d)/, "$1");
    return "T" + s.replace(/[^A-Z0-9#]/g, "");
  }

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
    if (resp.status === 403 && /protected/i.test(detalle)) {
      throw new Error("esa casilla está protegida en la Matriz y tu cuenta no puede escribir en ella");
    }
    if (resp.status === 400 && /validation|invalid/i.test(detalle)) {
      throw new Error("la Matriz no aceptó el valor (" + detalle + ")");
    }
    if (resp.status === 403 || resp.status === 404) throw new Error("tu cuenta de Google no tiene permiso sobre la Matriz");
    throw new Error(`Google respondió ${resp.status}${detalle ? ": " + detalle : ""}`);
  }
  const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";

  // ------------------------------------------------------------------ la Matriz
  // { id, sheetId, titulo, canEdit, encabezado (índice de fila), columnas, filas, leida }
  let matriz = null;
  let leyendo = null;

  async function urlExtractos() {
    const resp = await window.axioFetch("/api/estado");
    const estado = await resp.json();
    const f = (estado.fuentes || []).find((x) => x.clave === "extractos");
    if (!f || !f.url) throw new Error("no está la dirección de los Extractos en la configuración");
    return f.url;
  }

  // La fila de encabezados: la primera si trae nombres de columna, si no la que más se
  // parezca a un encabezado entre las 30 primeras (lo mismo que descargar_base_global).
  function filaEncabezado(filas) {
    const claves = ["FECH", "FEC", "DATE", "CEDULA", "VALOR", "MONTO", "CREDIT", "DEBITO", "BANCO"];
    const puntaje = (fila) => claves.filter((k) => (fila || []).some((c) => mayus(c).includes(k))).length;
    if (puntaje(filas[0]) >= 2) return 0;
    let mejor = 0, maximo = 0;
    for (let i = 0; i < Math.min(30, filas.length); i++) {
      const p = puntaje(filas[i]);
      if (p > maximo) { maximo = p; mejor = i; }
    }
    return mejor;
  }

  // Las cuatro casillas que se gestionan, por el nombre de su columna.
  function ubicarColumnas(encabezados) {
    const nombres = encabezados.map(mayus);
    const exacta = (...opciones) => nombres.findIndex((n) => opciones.includes(n));
    const contiene = (texto) => nombres.findIndex((n) => n.includes(texto));
    const credito = nombres.findIndex((n) => /^CREDITO\b/.test(n) && n.includes("<01>"));
    const columnas = {
      rws: exacta("RWS", "RCW"),
      notaCartera: exacta("NOTA CARTERA") >= 0 ? exacta("NOTA CARTERA") : contiene("NOTA CARTERA"),
      credito: credito >= 0 ? credito : nombres.findIndex((n) => /^CREDITO\b/.test(n)),
      notaRecaudo: contiene("NOTA RECAUDO"),
      nombre: exacta("NOMBRE"),
    };
    for (const [k, v] of Object.entries(columnas)) if (v < 0) columnas[k] = null;
    return columnas;
  }

  async function leerMatriz(forzar) {
    if (!forzar && matriz && Date.now() - matriz.leida < VIGENCIA_COPIA_MS) return matriz;
    if (leyendo) return leyendo;
    leyendo = (async () => {
      const url = await urlExtractos();
      const id = (/\/spreadsheets\/d\/([\w-]{20,})/.exec(url) || [])[1];
      if (!id) throw new Error("la dirección de los Extractos no es de una hoja de Google");
      const gid = (/[#&?]gid=(\d+)/.exec(url) || [])[1];
      const [libro, archivo] = await Promise.all([
        apiGoogle(`${SHEETS}${id}?fields=${encodeURIComponent("sheets.properties(sheetId,title)")}`),
        apiGoogle(`https://www.googleapis.com/drive/v3/files/${id}?fields=capabilities(canEdit)&supportsAllDrives=true`),
      ]);
      const hojas = libro.sheets.map((h) => h.properties);
      const hoja = hojas.find((h) => String(h.sheetId) === gid) || hojas[0];
      const valores = await apiGoogle(`${SHEETS}${id}/values/${encodeURIComponent(comillas(hoja.title))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
      const filas = valores.values || [];
      const encabezado = filaEncabezado(filas);
      const columnas = ubicarColumnas(filas[encabezado] || []);
      matriz = {
        id, sheetId: hoja.sheetId, titulo: hoja.title, canEdit: Boolean(archivo.capabilities && archivo.capabilities.canEdit),
        encabezado, nombres: filas[encabezado] || [], columnas, filas, leida: Date.now(),
      };
      return matriz;
    })();
    try { return await leyendo; } finally { leyendo = null; }
  }

  // Los valores del pago que sirven para reconocerlo: todos menos las casillas que se
  // gestionan (pueden haber cambiado desde que Axio bajó su copia).
  // ('Credit' es CREDITO -<01> renombrada por descargar_base_global.)
  function huella(d) {
    const gestionadas = /^(RWS|RCW|CREDIT)$|NOTA CARTERA|NOTA RECAUDO|^CREDITO\b/;
    const valores = d.campos.filter((c) => !gestionadas.test(mayus(c.columna))).map((c) => comparable(c.valor)).filter(Boolean);
    return { valores, cedula: d.cedula_limpia && d.cedula_limpia !== "0" ? d.cedula_limpia : null };
  }

  // Igual que limpiar_cedula (axio/nucleo/utils.py).
  function limpiarCedula(v) {
    let s = mayus(v);
    if (/E[+-]/.test(s) && isFinite(Number(s))) s = String(Math.round(Number(s)));
    return s.replace(/[,.]0+$/, "").replace(/\D/g, "");
  }

  function puntaje(fila, h) {
    fila = fila || [];
    if (h.cedula && !fila.some((c) => limpiarCedula(c) === h.cedula)) return 0;
    const celdas = new Set(fila.map(comparable));
    return h.valores.filter((v) => celdas.has(v)).length;
  }
  const minimo = (h) => Math.max(3, Math.ceil(h.valores.length * 0.7));

  // Las filas (número de fila de la hoja, desde 1) que mejor coinciden con el pago.
  function buscarFilas(m, h) {
    let mejor = 0, filas = [];
    for (let i = m.encabezado + 1; i < m.filas.length; i++) {
      const p = puntaje(m.filas[i], h);
      if (p > mejor) { mejor = p; filas = [i + 1]; }
      else if (p === mejor && p > 0) filas.push(i + 1);
    }
    return mejor >= minimo(h) ? filas : [];
  }

  const celda = (m, fila, col) => (col === null ? "" : String(((m.filas[fila - 1] || [])[col]) ?? ""));

  function estadoDe(m, fila) {
    const c = m.columnas;
    if (c.nombre !== null && ERRORES_EXCEL.includes(mayus(celda(m, fila, c.nombre)))) return ESTADOS.referencia_erronea;
    if (c.rws !== null && lleno(celda(m, fila, c.rws))) return ESTADOS.ingresado;
    if (c.notaRecaudo !== null && lleno(celda(m, fila, c.notaRecaudo))) return ESTADOS.pendiente_recaudo;
    if (c.notaCartera !== null && lleno(celda(m, fila, c.notaCartera))) return ESTADOS.gestion_cartera;
    return null;
  }

  async function leerFila(m, fila) {
    const ultima = letra(Math.max(m.nombres.length, ...Object.values(m.columnas).filter((c) => c !== null).map((c) => c + 1)) - 1);
    const r = await apiGoogle(`${SHEETS}${m.id}/values/${encodeURIComponent(`${comillas(m.titulo)}!A${fila}:${ultima}${fila}`)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
    return (r.values || [[]])[0] || [];
  }

  // Las opciones de la lista desplegable de CREDITO, leídas de la validación de la propia
  // celda: si alguien agrega un crédito a la lista de la Matriz, aparece aquí solo.
  const cacheListas = new Map();
  async function opcionesCredito(m, fila) {
    if (m.columnas.credito === null) return null;
    const rango = `${comillas(m.titulo)}!${letra(m.columnas.credito)}${fila}`;
    const r = await apiGoogle(`${SHEETS}${m.id}?ranges=${encodeURIComponent(rango)}&fields=${encodeURIComponent("sheets.data.rowData.values.dataValidation")}`);
    const validacion = ((((((r.sheets || [])[0] || {}).data || [])[0] || {}).rowData || [])[0] || {}).values;
    const condicion = validacion && validacion[0] && validacion[0].dataValidation && validacion[0].dataValidation.condition;
    if (!condicion) return null;
    const valores = (condicion.values || []).map((v) => v.userEnteredValue);
    if (condicion.type === "ONE_OF_LIST") return valores;
    if (condicion.type !== "ONE_OF_RANGE" || !valores[0]) return null;
    const origen = valores[0].replace(/^=/, "");
    if (!cacheListas.has(origen)) {
      const lista = await apiGoogle(`${SHEETS}${m.id}/values/${encodeURIComponent(origen)}?majorDimension=ROWS`);
      cacheListas.set(origen, [...new Set((lista.values || []).flat().map((v) => String(v).trim()).filter(Boolean))]);
    }
    return cacheListas.get(origen);
  }

  // ------------------------------------------------------------------ la tarjeta
  const CASILLAS = [
    { clave: "rws", area: "Recaudos", titulo: "RWS", ayuda: "Número de recibo. Al llenarlo, la fila queda en verde.", color: "verde" },
    { clave: "notaCartera", area: "Cartera", titulo: "NOTA CARTERA", ayuda: "Junto con el crédito, la fila queda en naranja.", color: "naranja", largo: true },
    { clave: "credito", area: "Cartera", titulo: "CREDITO", ayuda: "", color: "naranja", lista: true },
    { clave: "notaRecaudo", area: "Problema", titulo: "NOTA RECAUDO", ayuda: "Si el pago tiene un problema. La fila queda en rojo.", color: "rojo", largo: true },
  ];

  window.axioGestionPago = function (d, mostrarEstado) {
    if (d.fuente !== "Extractos" || !google() || !google().conectado()) return null;
    const cuerpo = nodo("div", { class: "gestion-cuerpo" });
    const boton = nodo("button", { class: "boton boton-principal boton-chico", type: "button", text: "✏️ Gestionar en la Matriz" });
    const tarjeta = nodo("div", { class: "tarjeta gestion-pago" },
      nodo("div", { class: "gestion-cabecera" },
        nodo("h3", { text: "📝 Gestión del pago" }),
        boton),
      cuerpo);
    boton.addEventListener("click", () => { boton.remove(); abrir(d, cuerpo, mostrarEstado); });
    return tarjeta;
  };

  // forzar: volver a leer la Matriz completa aunque la copia sea reciente (se sabe que cambió).
  async function abrir(d, cuerpo, mostrarEstado, { aviso, forzar } = {}) {
    cuerpo.replaceChildren(nodo("p", { class: "gris", text: "⏳ Buscando el pago en la Matriz…" }));
    let m, filas;
    const h = huella(d);
    try {
      m = await leerMatriz(Boolean(forzar));
      filas = buscarFilas(m, h);
      // Con la copia de hace unos minutos no apareció: puede que José haya movido filas.
      if (filas.length !== 1 && Date.now() - m.leida > 5000) { m = await leerMatriz(true); filas = buscarFilas(m, h); }
    } catch (e) {
      cuerpo.replaceChildren(nodo("p", { class: "aviso aviso-error", text: "No se pudo leer la Matriz: " + e.message + "." }));
      return;
    }
    const faltan = CASILLAS.filter((c) => m.columnas[c.clave] === null).map((c) => c.titulo);
    if (faltan.length === CASILLAS.length) {
      cuerpo.replaceChildren(nodo("p", { class: "aviso aviso-ambar", text: "⚠️ La hoja de Extractos no tiene las columnas RWS, NOTA CARTERA, CREDITO ni NOTA RECAUDO." }));
      return;
    }
    if (!filas.length) {
      cuerpo.replaceChildren(nodo("p", { class: "aviso aviso-ambar",
        text: "⚠️ No encontré este pago en la Matriz. Puede que lo hayan borrado o cambiado; usa «Refrescar datos» y vuelve a buscarlo." }));
      return;
    }
    if (filas.length > 1) {
      // Dos filas iguales (mismo pago subido dos veces): que la persona elija cuál.
      cuerpo.replaceChildren(
        nodo("p", { class: "aviso aviso-ambar", text: `⚠️ Este pago aparece igual en ${filas.length} filas de la Matriz. Elige cuál vas a gestionar:` }),
        nodo("div", { class: "gestion-opciones" }, ...filas.slice(0, 12).map((f) => {
          const e = estadoDe(m, f);
          return nodo("button", { class: "boton boton-chico", type: "button", text: `Fila ${f}${e ? " · " + e.icono + " " + e.etiqueta : " · sin gestionar"}`,
            onclick: () => formulario(d, cuerpo, mostrarEstado, m, f, h) });
        })));
      return;
    }
    formulario(d, cuerpo, mostrarEstado, m, filas[0], h, aviso);
  }

  async function formulario(d, cuerpo, mostrarEstado, m, fila, h, aviso) {
    const editable = m.canEdit && google().puedeEscribir();
    let opciones = null;
    try { opciones = await opcionesCredito(m, fila); } catch (_) { /* sin lista: se escribe a mano */ }

    const originales = {};
    const entradas = {};
    const grupos = [];
    for (const c of CASILLAS) {
      const col = m.columnas[c.clave];
      if (col === null) continue;
      const valor = celda(m, fila, col);
      originales[c.clave] = valor;
      let entrada;
      if (c.lista && opciones && opciones.length) {
        entrada = nodo("select", { class: "gestion-entrada" }, nodo("option", { value: "", text: "— Sin crédito —" }));
        const lista = opciones.includes(valor) || !valor ? opciones : [valor, ...opciones];
        for (const o of lista) entrada.append(nodo("option", { value: o, text: o }));
        entrada.value = valor;
      } else if (c.largo) {
        entrada = nodo("textarea", { class: "gestion-entrada", rows: "2" });
        entrada.value = valor;
      } else {
        entrada = nodo("input", { class: "gestion-entrada", type: "text" });
        entrada.value = valor;
      }
      entrada.disabled = !editable;
      entrada.setAttribute("aria-label", m.nombres[col] || c.titulo);
      entradas[c.clave] = entrada;
      grupos.push(nodo("label", { class: "gestion-casilla gestion-" + c.color },
        nodo("span", { class: "gestion-titulo" },
          nodo("strong", { text: m.nombres[col] || c.titulo }),
          nodo("span", { class: "gestion-area", text: c.area })),
        entrada,
        c.ayuda ? nodo("span", { class: "gestion-ayuda", text: c.ayuda }) : null));
    }

    const estadoLinea = nodo("p", { class: "gestion-estado gris" });
    const guardar = nodo("button", { class: "boton boton-principal", type: "button", text: "Guardar en la Matriz", disabled: true });
    const cambios = () => Object.keys(entradas).filter((k) => entradas[k].value.trim() !== originales[k].trim());
    const alCambiar = () => {
      guardar.disabled = !cambios().length;
      if (cambios().length) { estadoLinea.textContent = "Sin guardar: " + cambios().map((k) => m.nombres[m.columnas[k]]).join(", "); estadoLinea.className = "gestion-estado ambar"; }
      else { estadoLinea.textContent = ""; }
    };
    for (const e of Object.values(entradas)) { e.addEventListener("input", alCambiar); e.addEventListener("change", alCambiar); }

    const enlace = `https://docs.google.com/spreadsheets/d/${m.id}/edit#gid=${m.sheetId}&range=A${fila}`;
    cuerpo.replaceChildren(
      nodo("p", { class: "gestion-fila" },
        `Fila ${fila} de «${m.titulo}»`,
        nodo("a", { class: "boton boton-chico", href: enlace, target: "_blank", rel: "noopener noreferrer", text: "Ver en Google Sheets ↗" })),
      aviso ? nodo("p", { class: "aviso aviso-ambar", text: aviso }) : null,
      editable ? null : nodo("p", { class: "aviso aviso-info", text: m.canEdit
        ? "👁️ No aceptaste el permiso para editar hojas al iniciar sesión: cierra sesión y vuelve a entrar marcándolo."
        : "👁️ Tu cuenta solo puede ver la Matriz. Para gestionar pagos, pide permiso de edición a quien la administra." }),
      nodo("div", { class: "gestion-casillas" }, ...grupos),
      editable ? nodo("div", { class: "gestion-pie" }, estadoLinea, guardar) : null);

    guardar.addEventListener("click", async () => {
      const lista = cambios();
      if (!lista.length) return;
      guardar.disabled = true;
      for (const e of Object.values(entradas)) e.disabled = true;
      estadoLinea.className = "gestion-estado gris";
      estadoLinea.textContent = "⏳ Comprobando que la fila no haya cambiado…";
      try {
        // ¿Sigue siendo el mismo pago, y nadie lo gestionó mientras tanto?
        const actual = await leerFila(m, fila);
        if (puntaje(actual, h) < minimo(h)) {
          await abrir(d, cuerpo, mostrarEstado, { forzar: true,
            aviso: "⚠️ La Matriz cambió mientras tanto (se movieron filas) y el pago ahora está en otra posición. Revisa y vuelve a guardar; no se guardó nada." });
          return;
        }
        const ajenos = Object.keys(entradas).filter((k) => String(actual[m.columnas[k]] ?? "").trim() !== originales[k].trim());
        if (ajenos.length) {
          m.filas[fila - 1] = actual;
          const nombres = ajenos.map((k) => m.nombres[m.columnas[k]]).join(", ");
          await formulario(d, cuerpo, mostrarEstado, m, fila, h,
            `⚠️ Alguien más cambió ${nombres} de este pago mientras lo tenías abierto. Te muestro lo que hay ahora; no se guardó nada.`);
          return;
        }
        estadoLinea.textContent = "⏳ Guardando en la Matriz…";
        const datos = lista.map((k) => {
          let valor = entradas[k].value.trim();
          if (valor.startsWith("=")) valor = "'" + valor;   // texto, nunca una fórmula
          return { range: `${comillas(m.titulo)}!${letra(m.columnas[k])}${fila}`, values: [[valor]] };
        });
        await apiGoogle(`${SHEETS}${m.id}/values:batchUpdate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: datos }),
        });
        // Al registro de gestiones (si el config lo trae). Ya se guardó en la Matriz: si
        // anotar falla, se avisa pero no se deshace nada.
        let avisoRegistro = "";
        try {
          if (google().registrar) await google().registrar(lista.map((k) => ({
            hoja: "Matriz · " + m.titulo, ubicacion: `Fila ${fila}`, cedula: h.cedula || "",
            columna: m.nombres[m.columnas[k]] || k, antes: originales[k], despues: entradas[k].value.trim(),
          })));
        } catch (e) {
          avisoRegistro = " ⚠️ No quedó en el registro de gestiones: " + e.message + ".";
        }
        m.filas[fila - 1] = await leerFila(m, fila);
        const estado = estadoDe(m, fila);
        mostrarEstado(estado);
        await formulario(d, cuerpo, mostrarEstado, m, fila, h);
        const linea = cuerpo.querySelector(".gestion-estado");
        if (linea) {
          linea.className = "gestion-estado " + (avisoRegistro ? "ambar" : "ok");
          linea.textContent = `✓ Guardado en la Matriz · ${hora()} · ${estado ? estado.icono + " " + estado.etiqueta : "sin gestionar"}. ` +
            "La lista de resultados se actualiza con «Refrescar datos»." + avisoRegistro;
        }
      } catch (e) {
        estadoLinea.className = "gestion-estado error";
        estadoLinea.textContent = "❌ No se guardó: " + e.message + ".";
        for (const x of Object.values(entradas)) x.disabled = false;
        guardar.disabled = false;
      }
    });
  }
})();
