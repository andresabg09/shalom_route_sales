# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Odoo 18 addon module, `shalom_location_map`, that layers mapping, GPS
capture and route-tracing onto the OCA **Field Service** app. It carries
production code pulled from the `traspastras2-east` server
(`/root/odoo-addons/shalom_location_map`) — see `README.md` for the full
architecture writeup and the OCA dependency chain it sits on.

Also present: `docker-compose.yml` + `config/odoo.conf`, a local
Odoo 18 + PostgreSQL stack for testing this module before touching
production (see README for the run commands).

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
