#!/usr/bin/env python3
"""Copia FIEL y automática de shalom_location_map a un directorio de
pruebas, recortando SOLO el manifest.

Qué cambia en la copia (nada de código .py ni de vistas propias):
  - __manifest__.py: se quitan los 4 archivos de datos que dependen de
    geoengine real (vistas tipo geoengine / capa raster) y la clave
    "assets" (el JS/SCSS no se prueba aquí).
Todo lo demás se copia byte a byte, y al final se verifica con sha256
que cada .py de la copia es idéntico al del repo.

Uso: sync_modulo.py <repo>/shalom_location_map <destino_addons> [ref_git]

Sin ref_git copia el árbol de trabajo; con ref_git (p. ej. 502d9e8) copia
esa revisión con `git archive` (sirve para comparar antes/después de un fix).
"""
import ast
import hashlib
import pathlib
import shutil
import subprocess
import sys
import tempfile

QUITAR_DATA = {
    "views/fsm_location_action.xml",
    "views/fsm_location_geoengine_patch.xml",
    "views/fsm_order_geoengine_patch.xml",
    "data/mapbox_raster_layer.xml",
}


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main(origen, destino, ref=None):
    origen = pathlib.Path(origen).resolve()
    if ref:
        repo = origen.parent
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="shalom_ref_"))
        subprocess.run(
            "git -C %s archive %s %s | tar -x -C %s" % (repo, ref, origen.name, tmp),
            shell=True, check=True,
        )
        origen = tmp / origen.name
    destino = pathlib.Path(destino).resolve() / origen.name
    if destino.exists():
        shutil.rmtree(destino)
    shutil.copytree(
        origen, destino,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "static"),
    )
    man_path = destino / "__manifest__.py"
    manifest = ast.literal_eval(man_path.read_text())
    manifest["data"] = [d for d in manifest["data"] if d not in QUITAR_DATA]
    manifest.pop("assets", None)
    man_path.write_text("# MANIFEST RECORTADO por tools/odoo_harness/sync_modulo.py\n" + repr(manifest) + "\n")
    # verificación: todo .py (salvo el manifest) idéntico al del repo
    malos = []
    n = 0
    for py in origen.rglob("*.py"):
        if "__pycache__" in py.parts or py.name == "__manifest__.py":
            continue
        copia = destino / py.relative_to(origen)
        n += 1
        if not copia.exists() or sha(copia) != sha(py):
            malos.append(str(py))
    for xml in origen.rglob("*.xml"):
        rel = xml.relative_to(origen).as_posix()
        if "static" in xml.parts or rel in QUITAR_DATA:
            continue
        n += 1
        if sha(destino / rel) != sha(xml):
            malos.append(str(xml))
    if malos:
        sys.exit("ERROR: archivos distintos tras la copia: %s" % malos)
    print("OK: %d archivos .py/.xml idénticos al repo; manifest recortado (%d data)" % (n, len(manifest["data"])))


if __name__ == "__main__":
    main(*sys.argv[1:4])
