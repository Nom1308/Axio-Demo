"""Copia a esta demo el código de Axio que corre en el navegador.

La demo no tiene lógica propia: usa el mismo axio/dominio, axio/nucleo y web/servicio.py
del proyecto principal (ejecutados con Pyodide) y la misma interfaz de Axio Web. Correr
esto después de cambiar el proyecto principal deja la demo igual al original:

    python actualizar.py [ruta del proyecto Axio]     (por defecto ../Axio)

Solo se copia código. Nada de config, cachés, índices ni logs: este repo es público.
"""

import shutil
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
ORIGEN = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else AQUI.parent / "Axio"

# Paquetes de Python que necesita web/servicio.py. axio/ui queda fuera: es tkinter.
CARPETAS_PY = ["axio", "axio/nucleo", "axio/dominio"]
ARCHIVOS_PY_SUELTOS = ["web/__init__.py", "web/servicio.py"]

# La única diferencia con la interfaz del servidor: las llamadas a /api/... no viajan por
# la red, las responde el Python que corre en esta misma pestaña (ver estatico/puente.js).
LLAMADA_ORIGINAL = "const resp = await fetch(url, {"
LLAMADA_DEMO = "const resp = await window.axioFetch(url, {"
# Y las búsquedas recientes (cédulas, nombres) van a sessionStorage, que el navegador
# borra al cerrar la pestaña: en la demo nada debe quedar guardado en el equipo.
ALMACEN_ORIGINAL = "localStorage."
ALMACEN_DEMO = "sessionStorage."


def main():
    if not (ORIGEN / "axio" / "dominio" / "buscador.py").exists():
        sys.exit(f"No encuentro el proyecto Axio en {ORIGEN}")

    destino_py = AQUI / "py"
    if destino_py.exists():
        shutil.rmtree(destino_py)
    copiados = []
    for carpeta in CARPETAS_PY:
        (destino_py / carpeta).mkdir(parents=True, exist_ok=True)
        for archivo in sorted((ORIGEN / carpeta).glob("*.py")):
            shutil.copy2(archivo, destino_py / carpeta / archivo.name)
            copiados.append(f"{carpeta}/{archivo.name}")
    for relativo in ARCHIVOS_PY_SUELTOS:
        (destino_py / relativo).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ORIGEN / relativo, destino_py / relativo)
        copiados.append(relativo)
    # El trabajador lee esta lista para saber qué archivos bajar al sistema de archivos
    # de Pyodide (en el navegador no se puede listar una carpeta del servidor).
    (destino_py / "archivos.txt").write_text("\n".join(copiados) + "\n", encoding="utf-8")

    estatico = AQUI / "estatico"
    estatico.mkdir(exist_ok=True)
    for nombre in ["estilos.css", "icono.svg"]:
        shutil.copy2(ORIGEN / "web" / "estatico" / nombre, estatico / nombre)

    app_js = (ORIGEN / "web" / "estatico" / "app.js").read_text(encoding="utf-8")
    if app_js.count(LLAMADA_ORIGINAL) != 1:
        sys.exit("app.js cambió: no encuentro la llamada a fetch() que hay que redirigir. "
                 "Revisa LLAMADA_ORIGINAL en actualizar.py.")
    if ALMACEN_ORIGINAL not in app_js:
        sys.exit("app.js cambió: ya no usa localStorage. Revisa ALMACEN_ORIGINAL en actualizar.py.")
    app_js = app_js.replace(LLAMADA_ORIGINAL, LLAMADA_DEMO).replace(ALMACEN_ORIGINAL, ALMACEN_DEMO)
    (estatico / "app.js").write_text(app_js, encoding="utf-8")

    print(f"Copiados {len(copiados)} archivos de Python, estilos, ícono y app.js desde {ORIGEN}")


if __name__ == "__main__":
    main()
