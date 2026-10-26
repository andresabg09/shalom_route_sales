#!/bin/bash
# Arnés de pruebas: levanta un Odoo 18 REAL y desechable (PostgreSQL propio,
# módulos OCA de Field Service, stubs de geoengine y del módulo privado del
# cliente), instala una COPIA RECORTADA fiel de shalom_location_map y corre
# los tests de tools/odoo_harness/tests_addon con datos sintéticos.
#
# NO toca producción ni usa ODOO_URL/ODOO_API_KEY. Requiere root (usa el
# usuario `pgtest` para PostgreSQL) y red hacia github.com y PyPI.
#
# Uso:
#   tools/odoo_harness/run.sh                 # prueba el árbol de trabajo
#   tools/odoo_harness/run.sh --limpiar       # borra $WORK y reconstruye todo
#   tools/odoo_harness/run.sh --ref 502d9e8   # prueba esa revisión de git
#   tools/odoo_harness/run.sh --desde 502d9e8 # instala 502d9e8 (+ datos
#                                             # duplicados) y ACTUALIZA al árbol
#                                             # de trabajo antes de los tests
#   tools/odoo_harness/run.sh --tags /shalom_harness_tests:TestCarteras
# Variables: WORK (def. /tmp/odoo_test), PGPORT (def. 5433), DB (def. shalom_test),
#            SHALOM_REPO (def. la raíz de este repo)
set -u
AQUI="$(cd "$(dirname "$0")" && pwd)"
export SHALOM_REPO="${SHALOM_REPO:-$(cd "$AQUI/../.." && pwd)}"
WORK="${WORK:-/tmp/odoo_test}"
PGPORT="${PGPORT:-5433}"
DB="${DB:-shalom_test}"
PGBIN=/usr/lib/postgresql/16/bin
TAGS="/shalom_harness_tests"
REF=""; DESDE=""; LIMPIAR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --limpiar) LIMPIAR=1;; --ref) REF="$2"; shift;; --desde) DESDE="$2"; shift;;
    --tags) TAGS="$2"; shift;; *) echo "opción desconocida: $1"; exit 2;;
  esac; shift
done
[ "$(id -u)" = 0 ] || { echo "Necesita root (por PostgreSQL con usuario pgtest)"; exit 2; }
paso() { echo; echo "=== $* ==="; }
fallo() { echo "FALLO: $*"; exit 1; }

# ---- 0. limpieza opcional -------------------------------------------------
if [ "$LIMPIAR" = 1 ]; then
  paso "Limpiando $WORK"
  [ -d "$WORK/pgdata" ] && runuser -u pgtest -- $PGBIN/pg_ctl -D "$WORK/pgdata" -m immediate stop >/dev/null 2>&1
  rm -rf "$WORK"
fi
mkdir -p "$WORK"; chmod 755 "$WORK"

# ---- 1. dependencias ------------------------------------------------------
paso "Código de Odoo 18 y OCA field-service"
[ -d "$WORK/odoo" ] || git clone -q --depth 1 -b 18.0 https://github.com/odoo/odoo "$WORK/odoo" || fallo "clone odoo"
[ -d "$WORK/field-service" ] || git clone -q --depth 1 -b 18.0 https://github.com/OCA/field-service "$WORK/field-service" || fallo "clone field-service"
paso "Entorno virtual (python3.12)"
if [ ! -x "$WORK/venv/bin/python" ]; then
  python3.12 -m venv "$WORK/venv" || fallo "venv"
  # psycopg2/python-ldap se compilan: se usa psycopg2-binary y se omite ldap
  grep -v -i -E "^(psycopg2|python-ldap)" "$WORK/odoo/requirements.txt" > "$WORK/req_filtrado.txt"
  "$WORK/venv/bin/pip" install -q psycopg2-binary -r "$WORK/req_filtrado.txt" || fallo "pip"
fi

# ---- 2. PostgreSQL --------------------------------------------------------
paso "PostgreSQL (puerto $PGPORT, usuario del sistema pgtest)"
id pgtest >/dev/null 2>&1 || useradd -m pgtest
mkdir -p "$WORK/pgsock"
if [ ! -d "$WORK/pgdata" ]; then
  mkdir -p "$WORK/pgdata"; chown -R pgtest "$WORK/pgdata"
  runuser -u pgtest -- $PGBIN/initdb -D "$WORK/pgdata" -A trust -U odoo_test -E UTF8 --locale=C.UTF-8 >/dev/null || fallo "initdb"
fi
chown -R pgtest "$WORK/pgsock" "$WORK/pgdata"
if ! psql -h 127.0.0.1 -p "$PGPORT" -U odoo_test -d postgres -c "select 1" >/dev/null 2>&1; then
  runuser -u pgtest -- $PGBIN/pg_ctl -D "$WORK/pgdata" -w -l "$WORK/pgsock/pg.log" \
    -o "-p $PGPORT -k $WORK/pgsock -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" start >/dev/null || fallo "pg_ctl start"
fi

# ---- 3. addons: stubs, copia fiel recortada, módulo de tests --------------
paso "Módulos de prueba"
rm -rf "$WORK/stubs"; mkdir -p "$WORK/stubs" "$WORK/addons_tests"
cp -r "$AQUI"/stubs/* "$WORK/stubs/"
sync_modulo() {  # $1 = ref de git opcional
  python3 "$AQUI/sync_modulo.py" "$SHALOM_REPO/shalom_location_map" "$WORK/addons_prueba" $1 || fallo "sync_modulo"
}
rm -rf "$WORK/addons_tests/shalom_harness_tests"; cp -r "$AQUI/tests_addon/shalom_harness_tests" "$WORK/addons_tests/"
cat > "$WORK/odoo.conf" <<CONF
[options]
; los stubs van PRIMERO: pisan a fieldservice_geoengine/base_geoengine reales
addons_path = $WORK/stubs,$WORK/odoo/addons,$WORK/odoo/odoo/addons,$WORK/field-service,$WORK/addons_prueba,$WORK/addons_tests
db_host = 127.0.0.1
db_port = $PGPORT
db_user = odoo_test
db_password = False
data_dir = $WORK/datadir
without_demo = True
workers = 0
limit_time_real = 0
limit_time_cpu = 0
http_enable = False
CONF
ODOO() { "$WORK/venv/bin/python" "$WORK/odoo/odoo-bin" -c "$WORK/odoo.conf" -d "$DB" "$@"; }
ODOO_SHELL() { "$WORK/venv/bin/python" "$WORK/odoo/odoo-bin" shell -c "$WORK/odoo.conf" -d "$DB" "$@"; }
limpio() {  # $1 = log; falla si hay traceback/CRITICAL/ERROR del módulo
  if grep -n -E "Traceback|CRITICAL|Failed to load registry" "$1" | head -5 | grep . ; then fallo "problemas en $1"; fi
  grep -n -E " (ERROR|WARNING) .*(shalom|odoo.modules.loading|odoo.modules.registry)" "$1" | head -10
  return 0
}

# ---- 4. instalación y update ----------------------------------------------
psql -h 127.0.0.1 -p "$PGPORT" -U odoo_test -d postgres -qc "DROP DATABASE IF EXISTS $DB" 2>&1 | grep -v NOTICE
if [ -n "$DESDE" ]; then
  paso "Instalando la revisión $DESDE (punto de partida de la prueba de actualización)"
  sync_modulo "$DESDE"
  ODOO -i shalom_location_map --stop-after-init > "$WORK/log_install_desde.log" 2>&1 || fallo "install $DESDE (ver $WORK/log_install_desde.log)"
  limpio "$WORK/log_install_desde.log"
  paso "Sembrando eventos duplicados (sale_id repetido) en la base vieja"
  ODOO_SHELL --log-level=error < "$AQUI/scripts/sembrar_duplicados.py" 2>&1 | grep -E "SEMBRADO|Error|Traceback" || fallo "no se pudo sembrar"
  paso "Actualizando ${DESDE} -> ${REF:-árbol de trabajo} (como lo hace el deploy)"
  sync_modulo "$REF"
  ODOO -u shalom_location_map --stop-after-init > "$WORK/log_update.log" 2>&1 || fallo "update (ver $WORK/log_update.log)"
  limpio "$WORK/log_update.log"
  grep -n -i "unique\|constraint" "$WORK/log_update.log" | head -5
else
  sync_modulo "$REF"
  paso "Instalación limpia: -i shalom_location_map"
  ODOO -i shalom_location_map --stop-after-init > "$WORK/log_install.log" 2>&1 || fallo "install (ver $WORK/log_install.log)"
  limpio "$WORK/log_install.log"
fi
paso "Segundo -u shalom_location_map (así lo despliega el cliente)"
ODOO -u shalom_location_map --stop-after-init > "$WORK/log_update2.log" 2>&1 || fallo "update 2 (ver $WORK/log_update2.log)"
limpio "$WORK/log_update2.log"
echo "OK: instala y actualiza sin traceback"

# ---- 5. tests --------------------------------------------------------------
paso "Tests ($TAGS)"
ODOO -i shalom_harness_tests --test-enable --test-tags "$TAGS" --stop-after-init > "$WORK/log_tests.log" 2>&1
RC=$?
grep -E "(FAIL|ERROR): Test|Ran [0-9]+ tests" "$WORK/log_tests.log" | sed 's/^.*odoo.addons.//' | cut -c1-220
grep -E "H-[0-9]+ (PRESENTE|CORREGIDO)|INFO (fsm_user|pedido)" "$WORK/log_tests.log" | sed 's/^.*test_/test_/' | cut -c1-220
tail -n 1 <(grep "odoo.tests.result" "$WORK/log_tests.log")
grep -q " 0 failed, 0 error(s) of " "$WORK/log_tests.log" && RES=0 || RES=1
echo "Logs en $WORK/log_*.log"
exit $RES
