# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Who this is for

Shalom Panamá, a beauty-products distributor. The user is the sole
technical admin of the whole stack: a self-hosted Odoo 18 Community on
Google Cloud (GCP project `nomadic-freedom-476621-p4`), running in Docker
Swarm via EasyPanel, on VM `traspastras2-east` (zone `us-east1-b`, static
IP `104.196.114.160`).

## What this repo is (and isn't)

This repo is named `shalom_route_sales` on GitHub (public:
https://github.com/andresabg09/shalom_route_sales), but **that name is
just the repo's** — it is not an installable Odoo module and has no
relation to the module name. The repo is the version-controlled working
copy for editing the **already-existing, already-in-production** module
`shalom_location_map`. Before this repo existed, edits were made by
uploading loose folders over SSH with no version control, which left
stray backup/temp folders on the server (`shalom_location_map_temp3`,
`shalom_location_map_temp4`, `geoengine_temp`,
`clientes_geolocalizados` — already cleaned up;
`shalom_location_map_backup_20260710_020735` and
`shalom_location_map_v19.tar.gz` are still pending deletion, only once
it's 100% confirmed this repo has the full real code).

An initial exploratory module also named `shalom_route_sales` (own
models, own everything) was built before the real goal was clarified.
It was discarded — gone from the working tree, kept only in git history.

`shalom_location_map` exists in two places, same code: this repo (source
of truth, with history) and the server at
`/root/odoo-addons/shalom_location_map/` (where it actually runs).

Also present: `docker-compose.yml` + `config/odoo.conf`, a local
Odoo 18 + PostgreSQL stack for testing without touching production. It
does **not** include the OCA Field Service stack, so installing
`shalom_location_map` there directly will fail on missing dependencies.

## Infrastructure (for correct SSH/docker commands)

- VM: `traspastras2-east`, GCP, IP `104.196.114.160`.
- Odoo container: `crm_odoo` — has a rotating suffix, **always get the
  current name with `docker ps`, never assume it**. `docker ps --filter
  name=crm_odoo` matches on substring, so it **also returns the Postgres
  container** (`crm_odoo-db.1...`) alongside the real one
  (`crm_odoo.1...`) — confirmed in production: `CID=$(docker ps
  --filter name=crm_odoo --format '{{.ID}}')` silently captured both
  IDs (newline-joined) into one variable, and the second one then got
  passed as the *command* to `docker exec -u root $CID chown ...`,
  which failed as "executable file not found". Always filter on
  `name=crm_odoo.1` instead (the Swarm task-naming pattern
  `<service>.<replica>.<task-id>`) to get only the Odoo app container.
- Postgres container: `crm_odoo-db` (matches `docker ps --filter
  name=crm_odoo` too — see above).
- Addons live at `/root/odoo-addons/` on the host, owned by `root`; the
  user's normal account needs `sudo` to read/write there.
- Module update flow: `sudo chown -R 101:101` + `sudo chmod -R 755` on
  the host → `docker exec -u root [CONTAINER] chown -R odoo:odoo` inside
  the container → update with `--stop-after-init` →
  `docker service update --force crm_odoo`.

Other custom modules on the same server, **unrelated to this project —
do not touch unless explicitly asked**: `digifact_fe_panama`,
`l10n_pa_digifact_secure` (Panama DGI e-invoicing), and
`stock_picking_sale_buttons`, `product_multiple_barcodes`.

## End-to-end workflow (mandatory order)

Flujo completo de **cualquier** cambio, de la petición a producción.
Seguirlo cada vez, en cada chat nuevo, sin que el usuario lo repita.
Los cambios van directo a producción (sin staging), en horas de poco
tráfico. El usuario autorizó explícitamente (standing permission) que
Claude haga commit + push a `master` y que el deploy sea **un solo
comando**; este flujo reemplaza al viejo de scripts `.sh` por archivo,
hashes pegados a mano y comandos separados.

1. **El usuario pide** un cambio/fix, con las palabras que sea.
2. **Mini-plan de Claude** — sin código todavía — qué entendió y qué
   va a tocar, archivo por archivo. Si pudo malinterpretar, lo dice.
3. **Mockup para cambios visuales**: si el cambio toca lo que se ve
   (pantallas, tarjetas, colores, layout), Claude lo muestra primero
   como mockup en **Claude Design** (artifact tipo Design), respetando
   el diseño y colores actuales del módulo (variables `--shalom-*` de
   `ruta_shalom.scss`). Sin aprobación del mockup no se toca código.
4. **El usuario aprueba** el plan (y el mockup) o lo corrige; se repite
   2–3 hasta aprobarse.
5. **Claude implementa** en el working tree, valida lo que pueda
   localmente (XML con `xml.dom.minidom`, sintaxis Python/JS) y avisa de
   cualquier riesgo de producción. En la primera prueba de un cambio
   grande recuerda al usuario el snapshot del disco de datos en GCP.
6. **Claude commitea y pushea a `master`** (permiso permanente, ver
   "Git commits"). Luego entrega el comando de deploy y el
   procedimiento de prueba (qué debe ver el usuario).
7. **Deploy: un solo comando** que el usuario corre en la VM:

   ```
   sudo shalom-deploy
   ```

   `deploy.sh` (en la raíz del repo, enlazado en `/usr/local/bin/shalom-deploy`)
   hace todo, en orden y abortando ante el primer error:
   `git fetch` + `reset --hard origin/master` en `/root/shalom_route_sales`
   → respaldo `.tar.gz` del módulo actual en `/root/backups-shalom/` (deja
   los 10 últimos) → `rsync --delete` a `/root/odoo-addons/shalom_location_map/`
   → verifica sha256 repo vs. servidor → `chown 101:101` + `chmod 755` en
   host → `chown odoo:odoo` dentro del contenedor (id fresco con
   `docker ps --filter name=crm_odoo.1`) → `odoo -u shalom_location_map
   -d shalom --stop-after-init` (credenciales leídas del env del
   contenedor, `PGPASSWORD` por `-e`) → **solo si no hay traceback**,
   `docker service update --force crm_odoo`. Con traceback NO reinicia
   (el checkpoint sigue existiendo, pero ahora automático).

   Variantes: `sudo shalom-deploy --rollback` (vuelve al respaldo más
   reciente y reinicia) y `sudo shalom-deploy --sin-reinicio`.

   **Instalación (una sola vez)** en la VM:
   ```
   sudo git clone https://github.com/andresabg09/shalom_route_sales /root/shalom_route_sales
   sudo ln -sf /root/shalom_route_sales/deploy.sh /usr/local/bin/shalom-deploy
   sudo chmod +x /root/shalom_route_sales/deploy.sh
   ```
   Claude no tiene acceso al servidor: nunca corre el deploy, solo lo
   entrega. Cualquier cambio a `deploy.sh` también se prueba con
   cuidado: corre como root sobre producción.
8. **El usuario prueba en vivo** y reporta. Si algo se rompe:
   `sudo shalom-deploy --rollback`, y Claude corrige con un commit nuevo
   (`git revert` si hace falta; nunca reescribir historia de `master`).

Nunca asumir que un paso funcionó sin la salida pegada por el usuario.
El módulo se reemplaza en el lugar, mismo nombre — nunca desinstalar
primero. Si algo se rompe de verdad, desinstalar por SSH si hace falta.

Si un stop hook (u otro mecanismo) protesta por cambios sin commitear,
no cambia este flujo: se resuelve según las reglas de arriba.

## Project goal

Redesign `shalom_location_map`'s UX for zero-friction street sales: a
salesperson sees their route for the day → visits a customer → takes the
order → moves to the next stop. The invoice is generated **later**, back
at the office — not at the moment of the visit. Onboarding a new
customer from the street is an occasional case, not the main flow to
optimize for. Paid alternatives (VanGo, VanBiz Pro, FieldOpt) were
evaluated and rejected (thousands of USD) — building on the existing
in-house base instead.

## Running / testing

This repo contains only the addon, not a full Odoo installation with the
OCA Field Service stack. To use it for real, an Odoo 18 server needs
`fieldservice`, `fieldservice_geoengine`, `fieldservice_route` and
`base_geoengine` (OCA) already installed, plus `--addons-path` pointed at
the parent of `shalom_location_map/` and the module installed
(`-i shalom_location_map`).

- The bundled `docker-compose.yml` starts Postgres + a bare `odoo:18.0`
  image with this module mounted — it does **not** include the OCA
  Field Service modules, so installing `shalom_location_map` there will
  fail on missing dependencies until those are added to the image/addons
  path.
- Restart/upgrade after code changes: `-u shalom_location_map`
- Validate XML syntax quickly without a full Odoo run:
  `python -c "import xml.dom.minidom as m; m.parse('path/to/file.xml')"`
- `action_calcular_trazado_ruta()` (in `models/fsm_route.py`) requires a
  `MAPBOX_ACCESS_TOKEN` environment variable on the server to call Mapbox
  Directions API — not needed for anything else in the module.

## Architecture

`shalom_location_map` extends three native `fieldservice` models via
`_inherit` (its only models of its own are the game ones listed below), plus one HTTP
controller and a handful of Owl frontend widgets. See `README.md` for the
full breakdown (fields added, business rules, request/response shapes);
the short version:

- `models/fsm_location.py` — extends `fsm.location` (the customer site).
  Adds `x_orden_ruta` (position within its route) and makes the
  `fieldservice_geoengine` auto-geocoding call fail-soft instead of
  blocking record creation when the external geocoder is down.
- `models/fsm_order.py` — extends `fsm.order` (a visit/task). Adds GPS
  capture, `x_jornada` (auto-computed workday-within-route counter),
  purchase-history lookups, and `action_crear_cotizacion()` — a
  visit-first quote-creation flow that's the inverse of the native
  `fieldservice_sale` flow (which creates the visit from an existing
  sale).
- `models/fsm_route.py` — extends `fsm.route`. Bulk-generates visits from
  a route's locations (ordered by `x_orden_ruta`, skipping locations that
  already have an open order), archives closed visits, and calls Mapbox
  Directions API to compute/store the route's real street-following
  geometry.
- Juego de ventas (plan en `docs/plan_implementacion_ruta_juego.md`):
  `models/juego_utils.py` (reglas puras: estrellas, clases, XP, reparto de
  carteras; se prueban con `python3 tools/test_juego_utils.py`),
  `models/shalom_estrategia.py` (modelo `shalom.estrategia`: qué empujar /
  no ofrezcas), `models/shalom_juego.py` (modelo `shalom.juego.evento`: libro
  de XP), campos `x_cartera_*` en `fsm.order`, `x_es_distribuidora` en
  `fsm.location`. El cron de reposición de ciclos está DESACTIVADO a pedido
  del usuario (`data/reponer_rutas_cron.xml`, `active=False`).
- `controllers/mapbox_token.py` — exposes the server's public Mapbox
  token to authenticated frontend sessions.
- `static/src/` — Owl widgets: GPS-capture button, Mapbox background tile
  layer, a live-tracing mini-map on the visit card, and a purchase-history
  chart widget.

## Conventions

- Depends on `fieldservice`, `fieldservice_geoengine`, `fieldservice_route`
  and `base_geoengine` (declared in `__manifest__.py`) — all OCA modules
  that live upstream and are never modified in this repo. It does **not**
  depend on `fieldservice_sale`, `fieldservice_crm`,
  `fieldservice_account` or `base_territory`, even though those are part
  of the same server's broader Field Service stack.
- Custom fields on inherited models are prefixed `x_` and named in
  Spanish (`x_orden_ruta`, `x_jornada`, `x_gps_capturado_lat`, ...),
  matching the rest of the codebase (docstrings, log messages, user-facing
  strings) which is written in Spanish throughout.
- Never hardcode the Mapbox token — always read it from the
  `MAPBOX_ACCESS_TOKEN` environment variable on the server.

## Working rules (no exceptions)

- **Surgical changes**: prefer minimal, targeted diffs over rewriting
  whole files.
- **Git commits**: the user authorized (standing permission) committing
  and pushing to `master` once the mini-plan — and, for UI changes, the
  design mockup — has been approved. No per-commit confirmation round
  needed. Commit messages in Spanish or English, descriptive, one logical
  change per commit. Never force-push `master`; never rewrite history.
  If `git push` is blocked in this environment, give the exact command
  for the user to run.
- **Production risk**: flag it explicitly before proceeding whenever a
  change carries real production risk, even if it seems obvious and even
  if the user didn't ask.
- **Product/UX decisions** (as opposed to technical ones): ask the user
  directly instead of assuming.

## En curso: rediseño visual de Administración (sin commitear todavía)

Pendiente de terminar, iniciado a pedido explícito del usuario ("más
profesional, refinado, minimalista"). Contexto para retomarlo en un
chat nuevo sin releer la conversación original (fue muy larga):

- **Mockup de referencia** (Claude Design, navegable): 
  https://claude.ai/code/artifact/87f54901-0943-4f0c-a051-1774bf3d9d62 —
  5 láminas: escritorio, celular, Visita Exprés desplegada, buscador de
  Visita Exprés, Editar cliente. El usuario ya lo aprobó como objetivo
  visual final.
- **Estado del código (working tree, sin commitear)**: `admin_gestion.xml`
  fue reescrito de punta a punta con clases nuevas propias, prefijo
  `adm-*` (ej. `adm-tab`, `adm-row`, `adm-chip`, `adm-card-list`) —
  **a propósito** no reusa `.stop-card`/`.chip`/`.segmented`/etc., que
  también usa la app del vendedor (ruta_detalle, order_screen,
  rutas_hub, clientes) — así el rediseño no depende de ganarle en
  especificidad CSS a nada compartido. `ruta_shalom.scss` tiene el CSS
  completo para ese sistema `adm-*`, anidado bajo
  `&.o_shalom_admin_screen`. Se verificó (diff de handlers/t-model/
  t-on-change/componentes contra la versión en git) que NINGÚN botón o
  control se perdió en la reescritura.
- **Último problema sin resolver**: tras desplegar esta versión, la
  pantalla se veía sin NINGÚN estilo aplicado (ni siquiera el CSS base
  que ya funcionaba antes) -- texto plano, sin tarjetas, sin colores de
  layout. Se confirmó del lado del servidor que el CSS nuevo SÍ está en
  el bundle que Odoo sirve (`grep` sobre el archivo real del
  `ir_attachment` que Odoo entrega, contando ocurrencias de `adm-tab` >
  0) y que no hay ningún traceback de compilación en los logs. Quedó
  pendiente probar en una ventana de incógnito nueva, sin extensiones,
  para descartar caché del navegador o algo intermedio (proxy/CDN de
  EasyPanel) antes de seguir tocando código.
- **Antes de seguir**: repetir esa prueba de incógnito. Si ahí tampoco
  se ve el rediseño, investigar caché/proxy en vez de seguir cambiando
  CSS -- ya se descartó que sea un problema de especificidad o de
  compilación.
- **No commitear ni pushear** `admin_gestion.xml`/`ruta_shalom.scss`
  hasta que el usuario confirme en producción que el rediseño se ve
  bien -- misma regla de siempre (ver "End-to-end workflow" y "Git
  commits" arriba). El color por estado en el mapa de "Rutas de mis
  vendedores" y el fix del popup de Editar cliente (tapado por
  z-index) SÍ están confirmados por el usuario y solo esperan
  commitearse junto con este rediseño, a pedido explícito suyo.
