/* Ajustes de esta instalación de Axio.
 *
 * Nada de esto es secreto: va visible en la página a propósito. Lo que protege los datos
 * no son estos valores sino los permisos de Google de cada persona: quien no tenga acceso
 * a una hoja no la puede leer aunque conozca su enlace.
 */
window.AXIO_AJUSTES = {
  // ID de cliente OAuth de la empresa (Google Cloud → Credenciales → ID de cliente de
  // OAuth, tipo "Aplicación web"). Vacío: no hay "Iniciar sesión con Google" y la página
  // funciona como antes, cargando config_axio.json a mano con hojas públicas por enlace.
  clientId: "168094989144-nn61un73q0sds0p5fe6joadg8rv8vp8d.apps.googleusercontent.com",

  // ID del archivo config_axio.json guardado en Drive (lo que va entre /d/ y /view en su
  // enlace). Vacío: después de iniciar sesión se pide el archivo.
  configDriveId: "1G0YNCFTxa6IYzjqF5uwDSitYwRUeJN0y",

  // Dominio de los correos que pueden entrar, por ejemplo "miempresa.org". Vacío: entra
  // cualquiera que Google deje pasar (con la app en modo "Interno", solo la empresa).
  dominio: "",
};
