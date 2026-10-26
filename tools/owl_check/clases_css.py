#!/usr/bin/env python3
"""Revisa que las clases CSS usadas en los XML del módulo existan en el
CSS compilado, y que las variables --shalom-* usadas existan definidas.

Uso:
    npx sass --no-source-map ruta_shalom.scss /tmp/owl_check/out.css
    python3 clases_css.py [CSS_COMPILADO] [DIR_XML ...]
"""
import re
import sys
import glob
import os

css_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/owl_check/out.css"
base = os.path.join(os.path.dirname(__file__), "../../shalom_location_map/static/src")
xml_files = sys.argv[2:] or glob.glob(os.path.join(base, "xml/ruta_shalom/*.xml"))
scss = open(os.path.join(base, "scss/ruta_shalom.scss")).read()
css = open(css_path).read()

css_classes = set(re.findall(r"\.([A-Za-z_][\w-]*)", css))
vars_def = set(re.findall(r"(--shalom-[\w-]+)\s*:", css))
vars_use = set(re.findall(r"var\((--shalom-[\w-]+)", css)) | set(re.findall(r"var\((--shalom-[\w-]+)", scss))
print("Variables --shalom-* usadas pero NO definidas:", sorted(vars_use - vars_def) or "ninguna")

faltan = {}
for f in sorted(xml_files):
    txt = open(f, encoding="utf8").read()
    usadas = set()
    for m in re.finditer(r'\bclass="([^"]*)"', txt):
        usadas |= {t for t in re.sub(r"\{\{.*?\}\}", " ", m.group(1)).split() if re.fullmatch(r"[A-Za-z_][\w-]*", t)}
    for m in re.finditer(r't-att(?:f)?-class="([^"]*)"', txt):
        # literales entre comillas simples
        for lit in re.findall(r"'([^']*)'", m.group(1)):
            usadas |= {t for t in lit.split() if re.fullmatch(r"[A-Za-z_][\w-]*", t)}
        usadas |= {t for t in re.sub(r"\{\{.*?\}\}", " ", m.group(1)).split() if re.fullmatch(r"[A-Za-z_][\w-]*", t) and "'" not in m.group(1)}
    for c in sorted(usadas):
        if c not in css_classes:
            faltan.setdefault(os.path.basename(f), []).append(c)
for f, cs in faltan.items():
    print(f"{f}: clases sin regla en el CSS -> {cs}")
if not faltan:
    print("Todas las clases usadas tienen regla")
