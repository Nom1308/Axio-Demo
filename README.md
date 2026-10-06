# Axio · prueba técnica (GitHub Pages)

El buscador de Axio Web completo (búsqueda, detalle con encargado de Cartera y líneas de crédito, filtros, orden y exportación a Excel) corriendo **100% en el navegador**, sin servidor.

## Cómo funciona

1. La página arranca [Pyodide](https://pyodide.org) (Python en WebAssembly) dentro de un Web Worker.
2. Se carga el `config_axio.json` desde el equipo. **Se lee localmente y no se sube a ningún lado.**
3. Con esos links, el navegador descarga las hojas directo de Google Sheets y las procesa con el mismo código de Axio (`py/`).
4. Todo vive en la memoria de la pestaña. Al cerrarla o recargarla no queda nada guardado.

La primera vez tarda un poco más: el navegador descarga Python y pandas (~30 MB). Después quedan en caché.

## Iniciar sesión con Google

Con un `clientId` en [estatico/ajustes.js](estatico/ajustes.js), la portada muestra **«Iniciar sesión con Google»**:

- Cada persona entra con su correo corporativo y Axio lee las hojas **con sus permisos**. Las hojas pueden ser privadas.
- Si `configDriveId` apunta al `config_axio.json` guardado en Drive, se lee de ahí. Si está vacío, se pide el archivo después de entrar.
- `dominio` limita la entrada a los correos de la empresa.
- El token vive solo en la memoria de la pestaña, dura una hora y se anula al «Cerrar sesión».

Sin `clientId`, la página funciona como antes: se carga el config a mano y las hojas tienen que estar compartidas por enlace.

### Crear el ID de cliente (una vez, lo hace sistemas)

1. [console.cloud.google.com](https://console.cloud.google.com): crear el proyecto «Axio» con la cuenta corporativa.
2. **APIs y servicios → Biblioteca**: habilitar **Google Drive API** y **Google Sheets API**.
3. **Pantalla de consentimiento de OAuth**: tipo **Interno**.
4. **Credenciales → ID de cliente de OAuth**, tipo **Aplicación web**. Orígenes autorizados de JavaScript: `https://nom1308.github.io` y `http://localhost:8000`.
5. Poner el ID en `estatico/ajustes.js`. No es secreto.

## Qué hay en el repo

| Ruta | Qué es |
|---|---|
| `index.html` | La página de Axio Web, con una portada para cargar el config en vez del login. |
| `estatico/estilos.css`, `icono.svg` | Copia exacta de los de Axio Web. |
| `estatico/app.js` | Copia de Axio Web. Única diferencia: `fetch` → `window.axioFetch`. |
| `estatico/puente.js` | Responde las llamadas `/api/...` de `app.js` con el Python de la pestaña. |
| `estatico/trabajador.js` | El Web Worker que arranca Pyodide. |
| `motor/navegador.py` | Hace de `web/app.py`: atiende `/api/...` con el `MotorWeb` de Axio. |
| `py/` | Copia de `axio/nucleo`, `axio/dominio` y `web/servicio.py`. **No editar aquí.** |

**Este repo no contiene datos ni configuración**, y el `.gitignore` bloquea `.json`, `.csv` y `.xlsx` por si acaso.

## Actualizar después de cambiar Axio

```
python actualizar.py
```

Copia de nuevo `py/`, los estilos y `app.js` desde `../Axio`.

## Probar en local

```
python -m http.server 8000
```

y abrir `http://localhost:8000`.

## Diferencias con el servidor

- No hay login: la llave es el `config_axio.json`.
- No incluye los cierres locales: una página web no puede leer carpetas del equipo.
- Sin «¿Quisiste decir…?»: `rapidfuzz` no está disponible en Pyodide.

Es una prueba de concepto. La instalación definitiva va en el servidor (repo principal de Axio).
