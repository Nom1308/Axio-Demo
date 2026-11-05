/* Axio demo: une la interfaz de Axio Web con el Python que corre en la pestaña.
 *
 * app.js es el mismo del servidor; lo único distinto es que sus llamadas a /api/... pasan
 * por window.axioFetch (definido aquí) en vez de por la red. axioFetch devuelve objetos
 * Response normales, así que app.js no nota la diferencia.
 *
 * Con un clientId en ajustes.js, la portada pide "Iniciar sesión con Google": cada persona
 * entra con su cuenta y el Python de la pestaña descarga las hojas con SU token, o sea con
 * sus permisos. Las hojas pueden ser privadas. El token vive solo en la memoria de esta
 * pestaña y dura una hora; nunca se guarda.
 */
(function () {
  "use strict";

  // El tema elegido en el menú (app.js lo guarda en «axio.tema»), también en la portada:
  // app.js entra recién después de iniciar sesión.
  try {
    const tema = localStorage.getItem("axio.tema");
    if (tema === "claro") document.documentElement.dataset.theme = "light";
    else if (tema === "oscuro") document.documentElement.dataset.theme = "dark";
  } catch (_) { /* sin almacenamiento */ }

  const $ = (sel) => document.querySelector(sel);
  const AJUSTES = window.AXIO_AJUSTES || {};
  const CON_GOOGLE = Boolean(AJUSTES.clientId);
  // drive.readonly: leer las hojas (y el config en Drive) con los permisos de la persona.
  // spreadsheets: editar celdas desde la tabla de una obligación (estatico/hojas.js). Axio
  // solo escribe cuando la persona edita una celda, y Google aplica sus permisos: quien
  // solo puede ver una hoja, no puede escribirle.
  const ALCANCE_HOJAS = "https://www.googleapis.com/auth/spreadsheets";
  const ALCANCES = "openid email profile https://www.googleapis.com/auth/drive.readonly " + ALCANCE_HOJAS;
  const trabajador = new Worker("estatico/trabajador.js?v=2026-11-05-093248");
  const pendientes = new Map();
  let siguienteId = 1;
  let motorListo = false;
  let cargando = false;            // descargando las hojas: /api/... se responde desde aquí
  let parcial = false;             // ...salvo que ya estén los Extractos: entonces va a Python
  let fuentesConfig = [];          // [{clave, nombre}] de las hojas del config
  let mensaje = "Preparando el motor de búsqueda…";
  let interfazIniciada = false;
  let usuario = null;              // datos de la cuenta de Google, si inició sesión
  let token = null;
  let venceToken = 0;
  let respuestaToken = null;       // para saber qué permisos aceptó la persona

  // Las búsquedas recientes de app.js van a sessionStorage (actualizar.py lo cambia), que
  // el navegador ya borra al cerrar la pestaña. Por si acaso, también se borran al abrir y
  // al salir, junto con cualquier copia en localStorage de una versión anterior.
  const CLAVE_RECIENTES = "axio_recientes";
  const olvidarRecientes = () => {
    for (const almacen of ["sessionStorage", "localStorage"]) {
      try { window[almacen].removeItem(CLAVE_RECIENTES); } catch (_) { /* sin almacenamiento */ }
    }
  };
  olvidarRecientes();
  window.addEventListener("pagehide", olvidarRecientes);

  // ------------------------------------------------------------------ presentación
  // La portada se presenta mientras se prepara el motor de Python, sin que parezca una
  // carga: solo la marca, con el logo en reposo. Cuando el motor está listo, la lupa se
  // completa y la tarjeta se abre con el botón para entrar, así al iniciar sesión no hay que
  // esperarlo (ver «presentación» en demo.css). Nunca antes de ~1,6 s, para que la
  // presentación se vea completa aunque el motor llegue al instante. Si tarda demasiado,
  // la tarjeta se abre igual: se puede entrar y la carga espera al motor sola.
  const MS_PRESENTACION_MINIMA = 1600;
  const MS_MAXIMO_ESPERA = 30000;
  let esperandoMotor = document.body.classList.contains("esperando-motor");
  function terminarEsperaMotor(despues) {
    if (!esperandoMotor) { if (despues) despues(); return; }
    esperandoMotor = false;
    setTimeout(async () => {
      // Los puntos dorados del fondo viajan al logo (portada.js); la lupa se completa
      // cuando llegan.
      if (window.axioPortada) await window.axioPortada.reunir();
      document.body.classList.replace("esperando-motor", "motor-listo");
      if (despues) despues();
      // Ya desplegada, la tarjeta deja de recortar (las sombras del botón se ven enteras).
      setTimeout(() => document.body.classList.add("portada-abierta"), 1300);
    }, Math.max(0, MS_PRESENTACION_MINIMA - performance.now()));
  }
  setTimeout(() => { if (esperandoMotor) terminarEsperaMotor(); }, MS_MAXIMO_ESPERA);

  // ------------------------------------------------------------------ trabajador
  trabajador.onmessage = (ev) => {
    const m = ev.data;
    if (m.tipo === "progreso") {
      mensaje = m.mensaje;
      window.dispatchEvent(new CustomEvent("axio-progreso", { detail: { mensaje } }));
      // En la portada solo si ya se abrió sin el motor (tardó más de la cuenta).
      if (!motorListo && !esperandoMotor) $("#estado-motor").textContent = "⏳ " + mensaje;
    } else if (m.tipo === "motor-listo") {
      motorListo = true;
      // Sin «listo» ni palomita: nada que delate que hubo una carga. Con Google basta el
      // botón; sin Google se dice qué hacer.
      terminarEsperaMotor(() => {
        $("#estado-motor").textContent = CON_GOOGLE ? "" : "Carga tu archivo para empezar.";
      });
    } else if (m.tipo === "paso") {
      window.dispatchEvent(new CustomEvent("axio-paso", { detail: { clave: m.clave } }));
    } else if (m.tipo === "parcial") {
      parcial = true;
      window.dispatchEvent(new CustomEvent("axio-carga-parcial"));
    } else if (m.tipo === "error-motor") {
      terminarEsperaMotor();
      mostrarErrorPortada("No se pudo preparar el motor: " + m.error + ". Revisa tu conexión a internet y recarga la página.");
      $("#estado-motor").textContent = "";
    } else if (m.tipo === "respuesta") {
      const resolver = pendientes.get(m.id);
      pendientes.delete(m.id);
      if (resolver) resolver(m);
    }
  };

  function pedir(datos) {
    return new Promise((resolver) => {
      const id = siguienteId++;
      pendientes.set(id, resolver);
      trabajador.postMessage({ ...datos, id });
    });
  }

  // ------------------------------------------------------------------ axioFetch
  const respuestaJson = (datos, codigo = 200) =>
    new Response(JSON.stringify(datos), { status: codigo, headers: { "Content-Type": "application/json" } });

  // Lo que muestra la barra de fuentes mientras se descargan las hojas.
  function estadoCargando() {
    return {
      listo: false, cargando: true, mensaje_carga: mensaje,
      matriz: { configurada: true, filas: 0, hora: null, error: null, aviso: null },
      lineas: { configuradas: false, cargadas: [], hora: null, errores: {} },
      cierres_locales: false,
    };
  }

  // 'antes' corre con la bandera de carga ya puesta: así app.js ve "cargando" desde el
  // primer instante aunque primero haya que renovar el token de Google.
  // Avisa del inicio y del fin de cada carga (estatico/juego.js entretiene mientras tanto).
  async function cargarDatos(datos, antes) {
    cargando = true;
    let error = null;
    window.dispatchEvent(new CustomEvent("axio-carga-inicio", { detail: { accion: datos.accion, fuentes: fuentesConfig } }));
    try {
      if (antes) await antes();
      const r = await pedir(datos);
      if (r.error) { error = r.error; mostrarErrorCarga(r.error); }
    } catch (e) {
      error = e.message;
      mostrarErrorCarga(e.message);
    } finally {
      cargando = false;
      parcial = false;
      window.dispatchEvent(new CustomEvent("axio-carga-fin", { detail: { accion: datos.accion, error } }));
    }
  }

  window.axioFetch = async function (url, opciones = {}) {
    const metodo = (opciones.method || "GET").toUpperCase();
    // La agenda del equipo no depende de las hojas cargadas: va a su propia hoja de Google.
    if (url === "/api/agenda") {
      try {
        let cuerpo = null;
        if (metodo === "POST") { try { cuerpo = JSON.parse(opciones.body || "{}"); } catch (_) { cuerpo = {}; } }
        return respuestaJson(await atenderAgenda(cuerpo));
      } catch (e) {
        return respuestaJson({ error: e.message || String(e) }, e.codigo || 500);
      }
    }
    if (metodo === "POST" && url === "/api/refrescar") {
      if (cargando) return respuestaJson({ iniciada: false, mensaje: "Ya hay una descarga en curso." });
      cargarDatos({ accion: "recargar" }, usuario ? tokenVigente : null);
      return respuestaJson({ iniciada: true, mensaje: "Descargando los datos de nuevo..." });
    }
    if (metodo === "POST" && url.startsWith("/api/sincronizar")) {
      // La pide app.js sola cada pocos minutos. Nunca abre la ventana de Google: si el
      // permiso venció, espera a que se renueve con el próximo clic (ver RENOVAR_ANTES).
      if (cargando || !motorListo || (usuario && (!token || Date.now() >= venceToken))) return respuestaJson({ version: null, cambio: false });
      const r = await pedir({ accion: "sincronizar", forzar: url.includes("forzar=1") });
      return r.error ? respuestaJson({ error: r.error }, 500) : respuestaJson(r.datos);
    }
    if (cargando && !parcial) {
      if (url === "/api/estado") return respuestaJson(estadoCargando());
      if (url.startsWith("/api/buscar")) return respuestaJson({ cargando: true, mensaje: "Cargando los datos..." }, 202);
      return respuestaJson({ error: "Los datos todavía se están cargando." }, 503);
    }
    const r = await pedir({ accion: "api", url });
    if (r.error) return respuestaJson({ error: r.error }, 500);
    return new Response(r.cuerpo, { status: r.codigo, headers: { "Content-Type": r.tipoContenido } });
  };

  // ------------------------------------------------------------------ portada
  function mostrarErrorPortada(texto) {
    const caja = $("#error-portada");
    caja.classList.replace("aviso-ambar", "aviso-error");   // por si mostraba el aviso de inactividad
    caja.textContent = texto;
    caja.hidden = !texto;
  }

  function mostrarErrorCarga(texto) {
    const zona = $("#fuentes");
    if (zona) zona.append(Object.assign(document.createElement("p"), { className: "aviso aviso-error", textContent: "No se pudieron cargar los datos: " + texto }));
  }

  // FileReader y no archivo.text(): funciona también en navegadores viejos.
  function leerBytes(archivo) {
    return new Promise((resolver, rechazar) => {
      const lector = new FileReader();
      lector.onload = () => resolver(new Uint8Array(lector.result));
      lector.onerror = () => rechazar(lector.error || new Error("no se pudo leer"));
      lector.readAsArrayBuffer(archivo);
    });
  }

  // El config puede llegar en otra codificación si alguien lo abrió y guardó con el Bloc
  // de notas (UTF-16) o con un editor viejo (ANSI/Windows-1252). Se acepta cualquiera.
  function decodificar(bytes) {
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    if (bytes.length > 1 && bytes[1] === 0 && bytes[0] !== 0) return new TextDecoder("utf-16le").decode(bytes);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    } catch (_) {
      return new TextDecoder("windows-1252").decode(bytes);
    }
  }

  async function usarArchivo(archivo) {
    if (!archivo) return;
    mostrarErrorPortada("");
    const quien = `«${archivo.name}» (${archivo.size.toLocaleString("es-CO")} bytes)`;
    let texto;
    try {
      texto = decodificar(await leerBytes(archivo)).trim();
    } catch (e) {
      mostrarErrorPortada(`No se pudo leer ${quien}: ${e.message}. Prueba con Chrome o Edge actualizados.`);
      return;
    }
    usarTexto(texto, quien);
  }

  function usarTexto(texto, quien) {
    let config;
    if (CON_GOOGLE && !usuario) {
      mostrarErrorPortada("Primero inicia sesión con Google: las hojas se leen con tus permisos.");
      return;
    }
    if (!texto) {
      mostrarErrorPortada(`${quien} está vacío. Pide de nuevo el config_axio.json.`);
      return;
    }
    if (texto.startsWith("<")) {
      mostrarErrorPortada(`${quien} es una página web, no el archivo de configuración. Pasa a veces al descargarlo de un correo o de Drive: pide el config_axio.json por USB o carpeta compartida.`);
      return;
    }
    try {
      config = JSON.parse(texto);
    } catch (e) {
      mostrarErrorPortada(`${quien} no es un JSON válido (${e.message}). Probablemente se dañó al enviarlo o al abrirlo con otro programa: pide una copia nueva y no lo abras antes de cargarlo.`);
      return;
    }
    if (!config || typeof config !== "object" || !String(config.url_base_global || "").includes("docs.google.com")) {
      mostrarErrorPortada(`${quien} es un JSON, pero no trae la URL de la Matriz_Nube en Google Sheets («url_base_global»). ¿Es el config_axio.json correcto?`);
      return;
    }
    urlRegistro = String(config.url_registro_gestiones || "").trim();
    urlAgenda = String(config.url_agenda || "").trim();
    hojaAgenda = null;
    // Las hojas que se van a cargar, en el orden en que se leen (para la pantalla de carga).
    const conUrl = (u) => Boolean(String(u || "").trim());
    fuentesConfig = [
      { clave: "extractos", nombre: "Extractos" },
      ...(config.lineas_credito || []).filter((l) => conUrl(l.url)).map((l) => ({ clave: l.clave, nombre: l.nombre || l.clave })),
      ...(conUrl(config.url_whatsapp) ? [{ clave: "whatsapp", nombre: "WhatsApp" }] : []),
    ];
    if (!motorListo) mensaje = "Preparando el motor de búsqueda (solo la primera vez tarda)…";
    cargarDatos({ accion: "configurar", config: texto });
    iniciarInterfaz();
  }

  function iniciarInterfaz() {
    if (interfazIniciada) return;
    interfazIniciada = true;
    if (window.axioPortada) window.axioPortada.apagar();
    const entrar = () => {
      document.body.classList.remove("pagina-login");
      $("#portada").hidden = true;
      for (const nodo of document.querySelectorAll("[data-app]")) nodo.hidden = false;
    };
    // El logo viaja de la tarjeta a la barra mientras aparece la aplicación (View
    // Transitions; ver «logo-axio» en estilos.css). Sin soporte o sin movimiento, directo.
    if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = document.startViewTransition(entrar);
      t.ready.catch(() => {});
      t.finished.catch(() => {});
    } else {
      entrar();
    }
    // app.js arranca al cargarse (pinta el estado y empieza a sondear), por eso entra
    // recién ahora y no con la página.
    const script = document.createElement("script");
    script.src = "estatico/app.js?v=2026-11-05-093248";
    document.body.append(script);
  }

  const entrada = $("#archivo-config");
  entrada.addEventListener("change", () => usarArchivo(entrada.files[0]));

  const tarjeta = $("#portada");
  tarjeta.addEventListener("dragover", (ev) => { ev.preventDefault(); tarjeta.classList.add("arrastrando"); });
  tarjeta.addEventListener("dragleave", () => tarjeta.classList.remove("arrastrando"));
  tarjeta.addEventListener("drop", (ev) => {
    ev.preventDefault();
    tarjeta.classList.remove("arrastrando");
    usarArchivo(ev.dataTransfer.files[0]);
  });

  // ------------------------------------------------------------------ sesión de Google
  function esperarGoogle() {
    return new Promise((resolver, rechazar) => {
      const inicio = Date.now();
      (function mirar() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolver();
        if (Date.now() - inicio > 15000) {
          return rechazar(new Error("no cargó el inicio de sesión de Google. Revisa tu conexión o si la red de la empresa bloquea accounts.google.com"));
        }
        setTimeout(mirar, 100);
      })();
    });
  }

  let clienteToken = null;
  let alRecibirToken = () => {};
  let alFallarToken = () => {};

  // Pide un token a Google. Con prompt "" no vuelve a preguntar si la sesión sigue activa.
  async function pedirToken(prompt) {
    await esperarGoogle();
    if (!clienteToken) {
      clienteToken = google.accounts.oauth2.initTokenClient({
        client_id: AJUSTES.clientId,
        scope: ALCANCES,
        hd: AJUSTES.dominio || undefined,
        callback: (r) => alRecibirToken(r),
        error_callback: (e) => alFallarToken(e),
      });
    }
    return new Promise((resolver, rechazar) => {
      alRecibirToken = (r) => {
        if (r.error) return rechazar(new Error(r.error_description || r.error));
        token = r.access_token;
        respuestaToken = r;
        venceToken = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
        resolver(token);
      };
      alFallarToken = (e) => rechazar(new Error(e && e.type === "popup_closed"
        ? "se cerró la ventana de Google antes de terminar"
        : (e && (e.message || e.type)) || "Google no respondió"));
      clienteToken.requestAccessToken({ prompt });
    });
  }

  // El trabajador descarga las hojas: necesita el token para mandarlo en cada petición.
  const enviarToken = () => pedir({ accion: "token", token });

  async function tokenVigente() {
    if (!token || Date.now() >= venceToken) {
      await pedirToken("");
      await enviarToken();
    }
    return token;
  }

  const conToken = (url) => fetch(url, { headers: { Authorization: "Bearer " + token } });

  // El permiso de Google dura una hora. Si se espera a que venza, la ventanita de Google sale
  // justo al guardar una gestión. Por eso, cuando le quedan menos de 10 minutos, se renueva
  // con el siguiente clic cualquiera (Google exige un clic para abrir su ventana). No se hace
  // al tocar un campo de texto, para no quitarle el foco a quien va a escribir.
  const RENOVAR_ANTES = 10 * 60000;
  let renovando = false, ultimoIntento = 0;
  document.addEventListener("click", (ev) => {
    if (!usuario || !token || renovando || venceToken - Date.now() > RENOVAR_ANTES) return;
    if (Date.now() - ultimoIntento < 120000) return;
    if (ev.target.closest && ev.target.closest("input, textarea, select, [contenteditable]")) return;
    renovando = true;
    ultimoIntento = Date.now();
    pedirToken("").then(enviarToken).catch(() => { /* se reintenta al guardar, como antes */ })
      .finally(() => { renovando = false; });
  }, true);

  // ------------------------------------------------------------------ registro de gestiones
  // Si el config trae «url_registro_gestiones» (una hoja de Google aparte), cada valor que
  // Axio escribe en una hoja (la Matriz desde «Gestionar», o una celda de una obligación
  // desde el visor) se anota ahí: cuándo, quién, dónde, qué columna, antes y después. Se
  // escribe con la cuenta de la persona, así que todos los que gestionan necesitan permiso
  // de edición en esa hoja. Sin la clave en el config, no se anota nada.
  // Google guarda además el historial de cada celda en la propia hoja (con el correo de quien
  // escribió, porque Axio usa su cuenta): este registro es la versión fácil de consultar.
  let urlRegistro = "";
  let hojaRegistro = null;   // { id, rango } una vez ubicada (y con encabezado)
  const ENCABEZADO_REGISTRO = ["Fecha y hora", "Correo", "Nombre", "Hoja", "Ubicación", "Cédula", "Columna", "Antes", "Después"];

  async function ubicarRegistro() {
    if (hojaRegistro) return hojaRegistro;
    const id = (/\/spreadsheets\/d\/([\w-]{20,})/.exec(urlRegistro) || [])[1];
    if (!id) throw new Error("«url_registro_gestiones» no es la dirección de una hoja de Google");
    const gid = (/[#&?]gid=(\d+)/.exec(urlRegistro) || [])[1];
    const r = await conToken(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=${encodeURIComponent("sheets.properties(sheetId,title)")}`);
    if (!r.ok) throw new Error(`no se pudo abrir la hoja del registro (Google respondió ${r.status})`);
    const hojas = (await r.json()).sheets.map((h) => h.properties);
    const hoja = hojas.find((h) => String(h.sheetId) === gid) || hojas[0];
    const rango = `'${hoja.title.replace(/'/g, "''")}'!A1:I1`;
    const actual = await conToken(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(rango)}`);
    const valores = actual.ok ? ((await actual.json()).values || []) : [];
    if (!valores.length || !valores[0].length) await anotar(id, rango, [ENCABEZADO_REGISTRO]);   // hoja nueva: va el encabezado
    hojaRegistro = { id, rango };
    return hojaRegistro;
  }

  async function anotar(id, rango, filas) {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(rango)}:append` +
      "?valueInputOption=RAW&insertDataOption=INSERT_ROWS", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ values: filas }),
    });
    if (r.status === 403) throw new Error("tu cuenta no puede escribir en la hoja del registro; pide permiso de edición");
    if (!r.ok) throw new Error(`Google respondió ${r.status} al anotar en el registro`);
  }

  // cambios: [{ hoja, ubicacion, cedula, columna, antes, despues }]. Devuelve false si no
  // hay registro configurado; lanza un error si está configurado y no se pudo anotar.
  async function registrar(cambios) {
    if (!urlRegistro || !cambios.length) return false;
    await tokenVigente();
    const { id, rango } = await ubicarRegistro();
    const ahora = new Date();
    const dosDigitos = (n) => String(n).padStart(2, "0");
    const fecha = `${ahora.getFullYear()}-${dosDigitos(ahora.getMonth() + 1)}-${dosDigitos(ahora.getDate())} ` +
      `${dosDigitos(ahora.getHours())}:${dosDigitos(ahora.getMinutes())}:${dosDigitos(ahora.getSeconds())}`;
    await anotar(id, rango, cambios.map((c) => [fecha, (usuario && usuario.email) || "", (usuario && usuario.name) || "",
      c.hoja || "", c.ubicacion || "", c.cedula || "", c.columna || "", c.antes == null ? "" : String(c.antes), c.despues == null ? "" : String(c.despues)]));
    return true;
  }

  // ------------------------------------------------------------------ agenda del equipo
  // Los compromisos de pago, las notas por asociado y los fijados de app.js (lo mismo que
  // web/agenda.py en el servidor). Con «url_agenda» en el config, viven en esa hoja de Google
  // (una hoja aparte, NO la Matriz), en tres pestañas que Axio crea si faltan: Compromisos,
  // Notas y Fijados. Se escribe con la cuenta de cada persona: todos los que usan Axio
  // necesitan permiso de edición en esa hoja. Sin la clave, la agenda vive solo en esta
  // pestaña (sessionStorage) y app.js avisa que falta conectarla.
  let urlAgenda = "";
  let hojaAgenda = null;   // { id, titulo } una vez preparada
  let colaAgenda = Promise.resolve();   // un cambio a la vez: las filas no se cruzan
  const PESTANAS_AGENDA = {
    Compromisos: ["ID", "Creado", "Correo", "Quién anotó", "Cédula", "Asociado", "Valor", "Fecha prometida", "Nota", "Estado", "Actualizado", "Actualizado por"],
    Notas: ["ID", "Creado", "Correo", "Quién escribió", "Cédula", "Asociado", "Nota", "Borrada"],
    Fijados: ["Correo", "Cédula", "Asociado", "Creado"],
  };
  const MAX_FIJADOS = 30;
  const DIAS_RESUELTOS_VISIBLES = 90;
  const CLAVE_AGENDA_LOCAL = "axio_agenda_local";

  const errorAgenda = (mensaje, codigo) => Object.assign(new Error(mensaje), { codigo: codigo || 400 });
  const dos = (n) => String(n).padStart(2, "0");
  const ahoraLocal = () => { const d = new Date(); return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`; };
  const nuevoId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 11);
  const limpio = (v, largo) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, largo);
  function cedulaValida(v) {
    const c = String(v == null ? "" : v).replace(/\D/g, "");
    if (c.length < 5 || c.length > 12) throw errorAgenda("La cédula no es válida.");
    return c;
  }

  // Lo que pide app.js, validado igual que en web/agenda.py.
  function validarAgenda(p) {
    const accion = p && p.accion;
    if (accion === "compromiso") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.fecha || ""))) throw errorAgenda("La fecha del compromiso no es válida.");
      const monto = p.monto === null || p.monto === undefined || p.monto === "" ? null : Math.round(Number(p.monto));
      if (monto !== null && !(monto >= 0 && monto <= 1e12)) throw errorAgenda("El valor del compromiso no es válido.");
      return { accion, cedula: cedulaValida(p.cedula), nombre: limpio(p.nombre, 120), monto, fecha: p.fecha, nota: limpio(p.nota, 500) };
    }
    if (accion === "estado") {
      if (!["pendiente", "cumplida", "incumplida"].includes(p.estado)) throw errorAgenda("Estado inválido.");
      return { accion, id: String(p.id || ""), estado: p.estado };
    }
    if (accion === "nota") {
      const texto = limpio(p.texto, 500);
      if (!texto) throw errorAgenda("La nota está vacía.");
      return { accion, cedula: cedulaValida(p.cedula), nombre: limpio(p.nombre, 120), texto };
    }
    if (accion === "borrar_nota") return { accion, id: String(p.id || "") };
    if (accion === "fijar" || accion === "desfijar") return { accion, cedula: cedulaValida(p.cedula), nombre: limpio(p.nombre, 120) };
    throw errorAgenda("Acción desconocida.");
  }

  // La agenda como la espera app.js. todos: { compromisos, notas, fijados } con los de todos.
  function agendaParaPagina(todos, yo, compartida) {
    const limite = new Date(Date.now() - DIAS_RESUELTOS_VISIBLES * 86400000);
    const desde = `${limite.getFullYear()}-${dos(limite.getMonth() + 1)}-${dos(limite.getDate())}`;
    return {
      configurada: compartida, compartida, yo, hoja: (hojaAgenda && hojaAgenda.titulo) || "",
      compromisos: todos.compromisos.filter((c) => c.estado === "pendiente" || String(c.actualizado || c.creado || "").slice(0, 10) >= desde),
      notas: todos.notas.filter((n) => !n.borrada),
      fijados: todos.fijados.filter((f) => f.autor === yo).map(({ cedula, nombre, creado }) => ({ cedula, nombre, creado })),
    };
  }

  // Aplica un cambio sobre listas en memoria (la agenda de prueba, sin hoja).
  function aplicarEnMemoria(todos, p, yo, quien) {
    if (p.accion === "compromiso") {
      todos.compromisos.push({ id: nuevoId(), cedula: p.cedula, nombre: p.nombre, monto: p.monto, fecha: p.fecha, nota: p.nota, estado: "pendiente",
        autor: yo, autor_nombre: quien, creado: ahoraLocal(), actualizado: null, actualizado_por: null });
    } else if (p.accion === "estado") {
      const c = todos.compromisos.find((x) => x.id === p.id);
      if (!c) throw errorAgenda("Ese compromiso ya no existe.");
      Object.assign(c, { estado: p.estado, actualizado: ahoraLocal(), actualizado_por: yo });
    } else if (p.accion === "nota") {
      todos.notas.push({ id: nuevoId(), cedula: p.cedula, nombre: p.nombre, texto: p.texto, autor: yo, autor_nombre: quien, creado: ahoraLocal() });
    } else if (p.accion === "borrar_nota") {
      const n = todos.notas.find((x) => x.id === p.id && !x.borrada);
      if (!n) throw errorAgenda("Esa nota ya no existe.");
      if (n.autor !== yo) throw errorAgenda("Solo quien escribió la nota la puede borrar.");
      n.borrada = ahoraLocal();
    } else if (p.accion === "fijar") {
      const mios = todos.fijados.filter((f) => f.autor === yo);
      if (mios.some((f) => f.cedula === p.cedula)) return;
      if (mios.length >= MAX_FIJADOS) throw errorAgenda(`Puedes fijar hasta ${MAX_FIJADOS} personas. Quita alguna primero.`);
      todos.fijados.unshift({ autor: yo, cedula: p.cedula, nombre: p.nombre, creado: ahoraLocal() });
    } else if (p.accion === "desfijar") {
      todos.fijados = todos.fijados.filter((f) => !(f.autor === yo && f.cedula === p.cedula));
    }
  }

  function agendaLocal(peticion, yo, quien) {
    let todos = { compromisos: [], notas: [], fijados: [] };
    try { todos = { ...todos, ...JSON.parse(sessionStorage.getItem(CLAVE_AGENDA_LOCAL)) }; } catch (_) { /* vacía */ }
    if (peticion) {
      aplicarEnMemoria(todos, validarAgenda(peticion), yo, quien);
      try { sessionStorage.setItem(CLAVE_AGENDA_LOCAL, JSON.stringify(todos)); } catch (_) { /* sin almacenamiento */ }
    }
    return agendaParaPagina(todos, yo, false);
  }

  // ---- la hoja de Google
  async function pedirHoja(ruta, opciones = {}) {
    const r = await fetch("https://sheets.googleapis.com/v4/spreadsheets/" + ruta, {
      ...opciones, headers: { Authorization: "Bearer " + token, ...(opciones.body ? { "Content-Type": "application/json" } : {}) },
    });
    if (r.status === 403) throw errorAgenda(opciones.method ? "Tu cuenta no puede escribir en la hoja de la agenda: pide permiso de edición a quien la administra." : "Tu cuenta no tiene permiso para ver la hoja de la agenda.", 403);
    if (r.status === 404) throw errorAgenda("No encuentro la hoja de la agenda («url_agenda»): puede que la hayan movido o borrado.", 404);
    if (!r.ok) throw errorAgenda(`Google respondió ${r.status} con la hoja de la agenda.`, 502);
    return r.json();
  }

  async function prepararAgenda() {
    if (hojaAgenda) return hojaAgenda;
    const id = (/\/spreadsheets\/d\/([\w-]{20,})/.exec(urlAgenda) || [])[1];
    if (!id) throw errorAgenda("«url_agenda» no es la dirección de una hoja de Google.", 500);
    const libro = await pedirHoja(`${id}?fields=${encodeURIComponent("properties.title,sheets.properties.title")}`);
    const hay = new Set(libro.sheets.map((h) => h.properties.title));
    const faltan = Object.keys(PESTANAS_AGENDA).filter((t) => !hay.has(t));
    if (faltan.length) {
      await pedirHoja(`${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: faltan.map((title) => ({ addSheet: { properties: { title } } })) }) });
      await pedirHoja(`${id}/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "RAW",
        data: faltan.map((t) => ({ range: `'${t}'!A1`, values: [PESTANAS_AGENDA[t]] })) }) });
    }
    hojaAgenda = { id, titulo: libro.properties.title };
    return hojaAgenda;
  }

  // Todo lo de la hoja, con el número de fila de cada cosa (para cambiarla después).
  async function leerHojaAgenda() {
    const { id } = await prepararAgenda();
    const rangos = ["'Compromisos'!A2:L", "'Notas'!A2:H", "'Fijados'!A2:D"];
    const r = await pedirHoja(`${id}/values:batchGet?valueRenderOption=UNFORMATTED_VALUE&` + rangos.map((x) => "ranges=" + encodeURIComponent(x)).join("&"));
    const [c, n, f] = (r.valueRanges || []).map((v) => v.values || []);
    const texto = (v) => (v === undefined || v === null ? "" : String(v));
    const filas = (lista, hacer) => (lista || []).map((v, i) => (v && v.some((x) => texto(x) !== "") ? hacer(v, i + 2) : null)).filter(Boolean);
    return {
      compromisos: filas(c, (v, fila) => ({ fila, id: texto(v[0]), creado: texto(v[1]), autor: texto(v[2]), autor_nombre: texto(v[3]), cedula: texto(v[4]).replace(/\D/g, ""),
        nombre: texto(v[5]), monto: v[6] === "" || v[6] === undefined ? null : Number(String(v[6]).replace(/[^\d.-]/g, "")) || null, fecha: texto(v[7]).slice(0, 10), nota: texto(v[8]),
        estado: ["cumplida", "incumplida"].includes(texto(v[9])) ? texto(v[9]) : "pendiente", actualizado: texto(v[10]) || null, actualizado_por: texto(v[11]) || null })),
      notas: filas(n, (v, fila) => ({ fila, id: texto(v[0]), creado: texto(v[1]), autor: texto(v[2]), autor_nombre: texto(v[3]), cedula: texto(v[4]).replace(/\D/g, ""),
        nombre: texto(v[5]), texto: texto(v[6]), borrada: texto(v[7]) || null })),
      fijados: filas(f, (v, fila) => ({ fila, autor: texto(v[0]), cedula: texto(v[1]).replace(/\D/g, ""), nombre: texto(v[2]), creado: texto(v[3]) })),
    };
  }

  const agregarFilas = (id, pestana, filas) => pedirHoja(`${id}/values/${encodeURIComponent(`'${pestana}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: filas }) });
  const escribirRango = (id, rango, filas) => pedirHoja(`${id}/values:batchUpdate`,
    { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data: [{ range: rango, values: filas }] }) });

  async function cambiarHojaAgenda(p, yo, quien) {
    const { id } = await prepararAgenda();
    if (p.accion === "compromiso") {
      await agregarFilas(id, "Compromisos", [[nuevoId(), ahoraLocal(), yo, quien, p.cedula, p.nombre, p.monto === null ? "" : p.monto, p.fecha, p.nota, "pendiente", "", ""]]);
    } else if (p.accion === "nota") {
      await agregarFilas(id, "Notas", [[nuevoId(), ahoraLocal(), yo, quien, p.cedula, p.nombre, p.texto, ""]]);
    } else {
      // Lo demás cambia una fila que ya existe: se lee primero para ubicarla.
      const todos = await leerHojaAgenda();
      if (p.accion === "estado") {
        const c = todos.compromisos.find((x) => x.id === p.id);
        if (!c) throw errorAgenda("Ese compromiso ya no existe.");
        await escribirRango(id, `'Compromisos'!J${c.fila}:L${c.fila}`, [[p.estado, ahoraLocal(), yo]]);
      } else if (p.accion === "borrar_nota") {
        const n = todos.notas.find((x) => x.id === p.id && !x.borrada);
        if (!n) throw errorAgenda("Esa nota ya no existe.");
        if (n.autor !== yo) throw errorAgenda("Solo quien escribió la nota la puede borrar.");
        await escribirRango(id, `'Notas'!H${n.fila}`, [[ahoraLocal()]]);
      } else if (p.accion === "fijar") {
        const mios = todos.fijados.filter((f) => f.autor === yo);
        if (mios.some((f) => f.cedula === p.cedula)) return;
        if (mios.length >= MAX_FIJADOS) throw errorAgenda(`Puedes fijar hasta ${MAX_FIJADOS} personas. Quita alguna primero.`);
        await agregarFilas(id, "Fijados", [[yo, p.cedula, p.nombre, ahoraLocal()]]);
      } else if (p.accion === "desfijar") {
        const filas = todos.fijados.filter((f) => f.autor === yo && f.cedula === p.cedula).map((f) => `'Fijados'!A${f.fila}:D${f.fila}`);
        if (filas.length) await pedirHoja(`${id}/values:batchClear`, { method: "POST", body: JSON.stringify({ ranges: filas }) });
      }
    }
  }

  // GET (peticion null) o POST (lo que manda app.js). Devuelve la agenda al día.
  function atenderAgenda(peticion) {
    const yo = (usuario && usuario.email) || "esta-pestana";
    const quien = limpio((peticion && peticion.autor_nombre) || (usuario && usuario.name) || yo, 120);
    if (!urlAgenda || !usuario) return Promise.resolve().then(() => agendaLocal(peticion, yo, quien));
    const tarea = colaAgenda.then(async () => {
      if (!token || Date.now() >= venceToken) {
        // Leer sola cada pocos minutos nunca abre la ventana de Google; guardar sí (hubo un clic).
        if (!peticion) throw errorAgenda("El permiso de Google venció: se renueva con tu próximo clic.", 503);
        await tokenVigente();
      }
      if (peticion) await cambiarHojaAgenda(validarAgenda(peticion), yo, quien);
      const todos = await leerHojaAgenda();
      return agendaParaPagina(todos, yo, true);
    });
    colaAgenda = tarea.catch(() => {});
    return tarea;
  }

  // Lo que estatico/hojas.js necesita de la sesión, sin ver nada más de este módulo.
  window.axioGoogle = {
    conectado: () => Boolean(usuario && token),
    token: tokenVigente,
    registrar,
    // Google deja a la persona desmarcar permisos en la pantalla de consentimiento: si no
    // aceptó el de hojas de cálculo, la tabla se abre en solo lectura.
    puedeEscribir: () => Boolean(respuestaToken && window.google && google.accounts.oauth2.hasGrantedAllScopes(respuestaToken, ALCANCE_HOJAS)),
    // Un .xlsx guardado en Drive: lo baja y lo lee el Python del trabajador (con el token
    // de esta sesión) y lo devuelve con la forma de la API de Sheets. Ver leer_excel.
    leerExcel: async (archivo, hoja, filas, columnas) => {
      await tokenVigente();
      const r = await pedir({ accion: "excel", archivo, hoja, filas, columnas });
      if (r.error) throw new Error(r.error);
      return r.datos;
    },
  };

  async function iniciarSesion() {
    const boton = $("#btn-google");
    mostrarErrorPortada("");
    boton.disabled = true;
    try {
      await pedirToken("");
      const r = await conToken("https://www.googleapis.com/oauth2/v3/userinfo");
      if (!r.ok) throw new Error(`Google respondió ${r.status} al consultar tu cuenta`);
      const datos = await r.json();
      if (AJUSTES.dominio && String(datos.hd || "").toLowerCase() !== AJUSTES.dominio.toLowerCase()) {
        google.accounts.oauth2.revoke(token, () => {});
        token = null;
        throw new Error(`entra con tu correo de ${AJUSTES.dominio} (entraste con ${datos.email})`);
      }
      usuario = datos;
      await enviarToken();
      mostrarSesion();
      if (AJUSTES.configDriveId) {
        $("#estado-motor").textContent = "⏳ Leyendo la configuración de Axio en Drive…";
        await cargarConfigDeDrive();
      } else {
        $("#paso-archivo").hidden = false;
        $("#estado-motor").textContent = "Ahora carga el config_axio.json.";
      }
    } catch (e) {
      mostrarErrorPortada("No se pudo iniciar sesión: " + e.message + ".");
      boton.disabled = false;
    }
  }

  async function cargarConfigDeDrive() {
    const id = encodeURIComponent(AJUSTES.configDriveId);
    const r = await conToken(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`);
    if (r.status === 403 || r.status === 404) {
      throw new Error("tu cuenta no tiene acceso al archivo de configuración de Axio en Drive. Pide acceso a quien lo administra");
    }
    if (!r.ok) throw new Error(`Drive respondió ${r.status} al leer la configuración`);
    usarTexto(decodificar(new Uint8Array(await r.arrayBuffer())).trim(), "La configuración guardada en Drive");
  }

  function mostrarSesion() {
    const nombre = usuario.given_name || usuario.name || usuario.email;
    const inicial = (nombre || "?").trim().charAt(0).toUpperCase();
    $("#paso-google").hidden = true;
    $("#paso-sesion").hidden = false;
    $("#sesion-avatar").textContent = inicial;
    $("#sesion-nombre").textContent = usuario.name || nombre;
    $("#sesion-correo").textContent = usuario.email || "";
    $("#avatar-usuario").textContent = inicial;
    $("#nombre-usuario").textContent = nombre;
    $(".usuario").dataset.correo = usuario.email || "";   // lo muestra el menú del usuario
    // El saludo de la portada y las fotos de la barra y el menú (app.js).
    $(".usuario").dataset.nombre = usuario.given_name || nombre;
    $(".usuario").dataset.nombreCompleto = usuario.name || nombre;   // quién anota en la agenda
    if (/^https:\/\//.test(usuario.picture || "")) {
      $(".usuario").dataset.foto = usuario.picture;
      const foto = Object.assign(document.createElement("img"), { src: usuario.picture, alt: "", referrerPolicy: "no-referrer" });
      foto.addEventListener("error", () => foto.remove());
      $("#sesion-avatar").append(foto);
    }
    $("#btn-cambiar").textContent = "Cerrar sesión";
    $("#btn-cambiar").title = "Cierra la sesión de Google en Axio y borra los datos de la memoria";
  }

  if (CON_GOOGLE) {
    $("#paso-google").hidden = false;
    $("#paso-archivo").hidden = true;
    $("#nota-portada").replaceChildren(
      Object.assign(document.createElement("strong"), { textContent: "Con tu cuenta de la empresa." }),
      " Axio lee las hojas con tus permisos de Google: solo ves lo que tu cuenta puede ver. " +
      "Los datos viven solo en esta pestaña; al cerrarla o recargarla no queda nada guardado.");
    $("#btn-google").addEventListener("click", iniciarSesion);
  }

  // "Cambiar archivo" / "Cerrar sesión": recargar la página borra todo lo que había en
  // memoria. Con sesión, además se le devuelve el token a Google para que deje de valer.
  // app.js llama lo mismo cuando cierra la sesión por inactividad o al terminar la jornada.
  const MARCA_INACTIVIDAD = "axio_cierre_inactividad";   // solo una marca, sin datos
  // Recargar (F5) o cerrar la pestaña sin querer borra la sesión y obliga a esperar la carga
  // otra vez: el navegador pregunta antes. Al cerrar la sesión a propósito no se pregunta.
  let saliendo = false;
  window.addEventListener("beforeunload", (ev) => {
    if (!usuario || saliendo) return;
    ev.preventDefault();
    ev.returnValue = "";
  });
  const AVISOS_CIERRE = {
    inactividad: "Se cerró la sesión por inactividad y se borraron los datos de la pestaña. Vuelve a entrar para seguir.",
    jornada: "Terminó la jornada y se cerró la sesión; se borraron los datos de la pestaña. Si necesitas seguir, vuelve a entrar.",
  };
  function cerrarSesion(motivo) {
    saliendo = true;
    // «Tu día», la lista de trabajo y la agenda de prueba (sin hoja configurada) de app.js.
    try { for (const clave of ["axio_dia", "axio_lista", "axio_agenda_local", "axio_agenda_aviso"]) sessionStorage.removeItem(clave); } catch (_) { /* sin almacenamiento */ }
    if (AVISOS_CIERRE[motivo]) {
      try { sessionStorage.setItem(MARCA_INACTIVIDAD, motivo); } catch (_) { /* sin almacenamiento */ }
    }
    // Primero la despedida (los puntos del logo se dispersan; app.js), después se recarga.
    const despedida = typeof window.axioDespedida === "function" ? window.axioDespedida() : Promise.resolve();
    despedida.then(() => {
      if (token && window.google && google.accounts && google.accounts.oauth2) {
        google.accounts.oauth2.revoke(token, () => window.location.reload());
      } else {
        window.location.reload();
      }
    });
  }
  window.axioCerrarSesion = cerrarSesion;
  $("#btn-cambiar").addEventListener("click", () => cerrarSesion());

  try {
    const motivo = sessionStorage.getItem(MARCA_INACTIVIDAD);
    if (motivo) {
      sessionStorage.removeItem(MARCA_INACTIVIDAD);
      const nota = $("#error-portada");
      nota.textContent = AVISOS_CIERRE[motivo] || AVISOS_CIERRE.inactividad;
      nota.classList.replace("aviso-error", "aviso-ambar");
      nota.hidden = false;
    }
  } catch (_) { /* sin almacenamiento */ }
})();
