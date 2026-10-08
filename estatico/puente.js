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

  const $ = (sel) => document.querySelector(sel);
  const AJUSTES = window.AXIO_AJUSTES || {};
  const CON_GOOGLE = Boolean(AJUSTES.clientId);
  // drive.readonly: leer las hojas (y el config en Drive) con los permisos de la persona.
  // spreadsheets: editar celdas desde la tabla de una obligación (estatico/hojas.js). Axio
  // solo escribe cuando la persona edita una celda, y Google aplica sus permisos: quien
  // solo puede ver una hoja, no puede escribirle.
  const ALCANCE_HOJAS = "https://www.googleapis.com/auth/spreadsheets";
  const ALCANCES = "openid email profile https://www.googleapis.com/auth/drive.readonly " + ALCANCE_HOJAS;
  const trabajador = new Worker("estatico/trabajador.js?v=2026-10-08c");
  const pendientes = new Map();
  let siguienteId = 1;
  let motorListo = false;
  let cargando = false;            // descargando las hojas: /api/... se responde desde aquí
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

  // ------------------------------------------------------------------ trabajador
  trabajador.onmessage = (ev) => {
    const m = ev.data;
    if (m.tipo === "progreso") {
      mensaje = m.mensaje;
      if (!motorListo) $("#estado-motor").textContent = "⏳ " + mensaje;
    } else if (m.tipo === "motor-listo") {
      motorListo = true;
      $("#estado-motor").textContent = CON_GOOGLE && !usuario
        ? "✓ Motor listo. Inicia sesión para empezar."
        : "✓ Motor listo. Carga tu archivo para empezar.";
      $("#estado-motor").classList.add("listo");
    } else if (m.tipo === "error-motor") {
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
  async function cargarDatos(datos, antes) {
    cargando = true;
    try {
      if (antes) await antes();
      const r = await pedir(datos);
      if (r.error) mostrarErrorCarga(r.error);
    } catch (e) {
      mostrarErrorCarga(e.message);
    } finally {
      cargando = false;
    }
  }

  window.axioFetch = async function (url, opciones = {}) {
    const metodo = (opciones.method || "GET").toUpperCase();
    if (metodo === "POST" && url === "/api/refrescar") {
      if (cargando) return respuestaJson({ iniciada: false, mensaje: "Ya hay una descarga en curso." });
      cargarDatos({ accion: "recargar" }, usuario ? tokenVigente : null);
      return respuestaJson({ iniciada: true, mensaje: "Descargando los datos de nuevo..." });
    }
    if (cargando) {
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
    if (!motorListo) mensaje = "Preparando el motor de búsqueda (solo la primera vez tarda)…";
    cargarDatos({ accion: "configurar", config: texto });
    iniciarInterfaz();
  }

  function iniciarInterfaz() {
    if (interfazIniciada) return;
    interfazIniciada = true;
    document.body.classList.remove("pagina-login");
    $("#portada").hidden = true;
    for (const nodo of document.querySelectorAll("[data-app]")) nodo.hidden = false;
    // app.js arranca al cargarse (pinta el estado y empieza a sondear), por eso entra
    // recién ahora y no con la página.
    const script = document.createElement("script");
    script.src = "estatico/app.js?v=2026-10-08c";
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

  // Lo que estatico/hojas.js necesita de la sesión, sin ver nada más de este módulo.
  window.axioGoogle = {
    conectado: () => Boolean(usuario && token),
    token: tokenVigente,
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
  $("#btn-cambiar").addEventListener("click", () => {
    if (token && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(token, () => window.location.reload());
    } else {
      window.location.reload();
    }
  });
})();
