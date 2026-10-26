#!/usr/bin/env bash
# Corre todas las verificaciones del frontend Owl de Ruta Shalom.
# No toca el módulo ni producción. Trabaja en /tmp/owl_check.
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
W=/tmp/owl_check
mkdir -p "$W" && cd "$W"
[ -f package.json ] || npm init -y >/dev/null
[ -d node_modules/jsdom ] && [ -d node_modules/esbuild ] && [ -d node_modules/luxon ] && [ -d node_modules/sass ] \
  || npm i jsdom esbuild luxon sass >/dev/null 2>&1
# owl.js EXACTO que usa Odoo 18 (rama 18.0)
[ -f owl_odoo18.js ] || curl -sS -o owl_odoo18.js https://raw.githubusercontent.com/odoo/odoo/18.0/addons/web/static/lib/owl/owl.js

echo "=== 1/4 Compilación de plantillas (Owl dev:true) ==="
node "$AQUI/compilar_plantillas.js" "$W/owl_odoo18.js"
echo; echo "=== 2/4 SCSS -> CSS y clases/variables ==="
npx sass --no-source-map "${SHALOM_MOD:-$AQUI/../../shalom_location_map}/static/src/scss/ruta_shalom.scss" "$W/out.css"
python3 -I "$AQUI/clases_css.py" "$W/out.css" | grep -v "fa-" || true
echo; echo "=== 3/4 Bundle de componentes ==="
node "$AQUI/build_bundle.js" "$W/bundle.cjs"
echo; echo "=== 4/4 Simulaciones con jsdom ==="
BUNDLE="$W/bundle.cjs" node "$AQUI/simular.js" "$@"
