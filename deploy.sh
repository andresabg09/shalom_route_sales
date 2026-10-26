#!/usr/bin/env bash
# Deploy de shalom_location_map a producción, de un solo golpe.
#
#   sudo shalom-deploy              # git pull -> copiar -> permisos -> actualizar módulo -> reiniciar
#   sudo shalom-deploy --rollback   # vuelve al respaldo más reciente (y reinicia)
#   sudo shalom-deploy --sin-reinicio   # todo menos el `docker service update --force`
#   sudo shalom-deploy --rollback --sin-actualizar   # rollback SIN `odoo -u` (ver nota abajo)
#
# Nota sobre --rollback: el `odoo -u` con el código VIEJO borra los campos que
# ese código ya no declara (y sus columnas, con sus datos). Si el deploy que se
# revierte había AGREGADO campos (p. ej. x_cartera_* y x_es_distribuidora del
# juego de ventas), usar --rollback --sin-actualizar: restaura los archivos y
# reinicia, pero deja la base intacta (las columnas nuevas sobran, no estorban).
#
# Instalación (una sola vez, en la VM traspastras2-east):
#   sudo git clone https://github.com/andresabg09/shalom_route_sales /root/shalom_route_sales
#   sudo ln -sf /root/shalom_route_sales/deploy.sh /usr/local/bin/shalom-deploy
#   sudo chmod +x /root/shalom_route_sales/deploy.sh
#
# Seguridad: respalda el módulo antes de tocarlo, verifica sha256 de cada archivo
# copiado, y NO reinicia el servicio si la actualización del módulo da traceback.

set -euo pipefail

REPO_URL="https://github.com/andresabg09/shalom_route_sales"
REPO_DIR="/root/shalom_route_sales"
BRANCH="master"
ADDONS="/root/odoo-addons"
MODULO="shalom_location_map"
BACKUPS="/root/backups-shalom"
DB="shalom"
SERVICIO="crm_odoo"
RUTA_ADDONS_CONTENEDOR="/mnt/extra-addons"

paso() { printf '\n\033[1;35m==> %s\033[0m\n' "$*"; }
fallo() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

manifiesto() { # sha256 ordenado de todos los archivos de un directorio (sin .pyc)
    (cd "$1" && find . -type f ! -name '*.pyc' ! -path '*/__pycache__/*' -print0 \
        | sort -z | xargs -0 sha256sum)
}

contenedor_odoo() { # solo la app, nunca crm_odoo-db (ver CLAUDE.md)
    local ids n
    ids=$(docker ps --filter 'name=crm_odoo.1' --format '{{.ID}}')
    n=$(printf '%s\n' "$ids" | grep -c . || true)
    [ "$n" = "1" ] || fallo "se esperaba 1 contenedor 'crm_odoo.1', hay $n"
    printf '%s' "$ids"
}

permisos() {
    paso "Permisos (host y contenedor)"
    chown -R 101:101 "$ADDONS/$MODULO"
    chmod -R 755 "$ADDONS/$MODULO"
    CID=$(contenedor_odoo)
    docker exec -u root "$CID" chown -R odoo:odoo "$RUTA_ADDONS_CONTENEDOR/$MODULO"
    echo "contenedor: $CID"
}

actualizar_modulo() {
    if [ "${SIN_ACTUALIZAR:-0}" = "1" ]; then
        paso "Actualización del módulo omitida (--sin-actualizar): la base queda intacta"
        return
    fi
    paso "Actualizando módulo en la base '$DB' (puede tardar)"
    local h p u pw log
    h=$(docker exec "$CID" printenv HOST)
    p=$(docker exec "$CID" printenv PORT)
    u=$(docker exec "$CID" printenv USER)
    pw=$(docker exec "$CID" printenv PASSWORD)
    log=$(mktemp)
    docker exec -e PGPASSWORD="$pw" "$CID" odoo -u "$MODULO" -d "$DB" \
        --db_host="$h" --db_port="$p" --db_user="$u" --stop-after-init 2>&1 | tee "$log" || true
    if grep -qE 'Traceback|CRITICAL|ParseError' "$log"; then
        echo; grep -nE 'Traceback|CRITICAL|ParseError' "$log" | head -n 10
        fallo "la actualización del módulo falló. NO se reinició Odoo (sigue sirviendo la versión anterior en memoria). Respaldo: $RESPALDO — para volver: sudo shalom-deploy --rollback"
    fi
    echo "actualización limpia (sin traceback)"
}

reiniciar() {
    if [ "${SIN_REINICIO:-0}" = "1" ]; then
        paso "Reinicio omitido (--sin-reinicio)"
        return
    fi
    paso "Reiniciando $SERVICIO"
    docker service update --force "$SERVICIO"
}

main() {
    [ "$(id -u)" = "0" ] || fallo "correr con sudo"
    local modo="deploy"
    for a in "$@"; do
        case "$a" in
            --rollback) modo="rollback" ;;
            --sin-reinicio) SIN_REINICIO=1 ;;
            --sin-actualizar) SIN_ACTUALIZAR=1 ;;
            *) fallo "opción desconocida: $a" ;;
        esac
    done

    mkdir -p "$BACKUPS"

    if [ "$modo" = "rollback" ]; then
        local ultimo
        ultimo=$(ls -1t "$BACKUPS"/${MODULO}_*.tar.gz 2>/dev/null | head -n1 || true)
        [ -n "$ultimo" ] || fallo "no hay respaldos en $BACKUPS"
        paso "Rollback a $ultimo"
        rm -rf "${ADDONS:?}/$MODULO"
        tar xzf "$ultimo" -C "$ADDONS"
        permisos
        actualizar_modulo
        reiniciar
        paso "Rollback listo"
        return
    fi

    paso "Trayendo $BRANCH desde GitHub"
    if [ ! -d "$REPO_DIR/.git" ]; then
        git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
    fi
    git -C "$REPO_DIR" fetch --quiet origin "$BRANCH"
    git -C "$REPO_DIR" reset --hard --quiet "origin/$BRANCH"   # la copia del servidor es solo un espejo
    echo "commit: $(git -C "$REPO_DIR" log -1 --format='%h %s')"
    [ -d "$REPO_DIR/$MODULO" ] || fallo "no existe $REPO_DIR/$MODULO"

    paso "Respaldo del módulo actual"
    RESPALDO="$BACKUPS/${MODULO}_$(date +%Y%m%d_%H%M%S).tar.gz"
    if [ -d "$ADDONS/$MODULO" ]; then
        tar czf "$RESPALDO" -C "$ADDONS" "$MODULO"
        echo "$RESPALDO"
        ls -1t "$BACKUPS"/${MODULO}_*.tar.gz | tail -n +11 | xargs -r rm -f   # deja los 10 últimos
    else
        echo "(no había módulo previo)"
    fi

    paso "Copiando archivos a $ADDONS/$MODULO"
    mkdir -p "$ADDONS/$MODULO"
    rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' \
        "$REPO_DIR/$MODULO/" "$ADDONS/$MODULO/"

    paso "Verificando sha256 (repo vs. servidor)"
    if ! diff <(manifiesto "$REPO_DIR/$MODULO") <(manifiesto "$ADDONS/$MODULO") >/dev/null; then
        fallo "los hashes no coinciden entre el repo y $ADDONS/$MODULO; no se continúa"
    fi
    echo "OK: $(manifiesto "$ADDONS/$MODULO" | wc -l) archivos idénticos"

    permisos
    actualizar_modulo
    reiniciar
    paso "Listo: $(git -C "$REPO_DIR" log -1 --format='%h %s') está en producción"
}

main "$@"
exit $?
