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
  current name with `docker ps`, never assume it**.
- Postgres container: `crm_odoo-db`.
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

## Deployment workflow (mandatory order, no exceptions)

Changes are deployed straight to production (no separate staging in
active use), during low-traffic hours. For **any** change headed to
production, this exact order:

1. Give the user the exact code to paste over SSH.
2. Give verification commands to confirm the change applied correctly.
3. **Only if verification passes**, proceed with permissions
   (`chown`/`chmod`) and module update.

Never skip a step or assume a step worked without verifying it
explicitly with the user. Upload replaces the `shalom_location_map`
folder in place, same name — never uninstall first. If something breaks,
uninstall over SSH if needed (no GUI required). Before the **first**
test of a significant change, remind the user to snapshot the GCP data
disk as a safety net.

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

`shalom_location_map` defines **no models of its own** — it only extends
three native `fieldservice` models via `_inherit`, plus one HTTP
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
- **Git commits**: the user reviews and confirms every commit manually —
  never commit automatically. Show `git status`/`git diff` before
  proposing a commit and wait for explicit confirmation. If `git commit`
  itself is blocked in this environment, give the exact command for the
  user to run in their own terminal.
- **Production risk**: flag it explicitly before proceeding whenever a
  change carries real production risk, even if it seems obvious and even
  if the user didn't ask.
- **Product/UX decisions** (as opposed to technical ones): ask the user
  directly instead of assuming.
