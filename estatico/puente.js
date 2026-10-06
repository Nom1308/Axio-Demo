/* Axio demo: une la interfaz de Axio Web con el Python que corre en la pestaña.
 *
 * app.js es el mismo del servidor; lo único distinto es que sus llamadas a /api/... pasan
 * por window.axioFetch (definido aquí) en vez de por la red. axioFetch devuelve objetos
 * Response normales, así que app.js no nota la diferencia.
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const trabajador = new Worker("estatico/trabajador.js");
  const pendientes = new Map();
  let siguienteId = 1;
  let motorListo = false;
  let cargando = false;            // descargando las hojas: /api/... se responde desde aquí
  let mensaje = "Preparando el motor de búsqueda…";
  let interfazIniciada = false;

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
      $("#estado-motor").textContent = "✓ Motor listo. Carga tu archivo para empezar.";
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

  async function cargarDatos(datos) {
    cargando = true;
    try {
      const r = await pedir(datos);
      if (r.error) mostrarErrorCarga(r.error);
    } finally {
      cargando = false;
    }
  }

  window.axioFetch = async function (url, opciones = {}) {
    const metodo = (opciones.method || "GET").toUpperCase();
    if (metodo === "POST" && url === "/api/refrescar") {
      if (cargando) return respuestaJson({ iniciada: false, mensaje: "Ya hay una descarga en curso." });
      cargarDatos({ accion: "recargar" });
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
    let texto, config;
    try {
      texto = decodificar(await leerBytes(archivo)).trim();
    } catch (e) {
      mostrarErrorPortada(`No se pudo leer ${quien}: ${e.message}. Prueba con Chrome o Edge actualizados.`);
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
    script.src = "estatico/app.js";
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

  // "Cambiar archivo": recargar la página borra todo lo que había en memoria.
  $("#btn-cambiar").addEventListener("click", () => window.location.reload());
})();
