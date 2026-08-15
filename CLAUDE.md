# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Odoo 18 addon module, `shalom_route_sales`, implementing street / door-to-door
route sales: recurring routes with a weekly customer schedule, daily "visit"
instances generated from a route, and per-stop sale order creation from the
field. See `shalom_route_sales/README.md` for the functional flow.

## Running / testing

This repo contains only the addon, not an Odoo installation. To use it, point
an Odoo 18 server's `--addons-path` at the parent of `shalom_route_sales/` and
install the module (`-i shalom_route_sales`) against a database.

- Run tests (if/when added under `shalom_route_sales/tests/`):
  `odoo-bin -d <db> --addons-path=<path>,... -i shalom_route_sales --test-enable --stop-after-init`
- Restart/upgrade after code changes: `-u shalom_route_sales`
- Validate XML syntax quickly without a full Odoo run:
  `python -c "import xml.dom.minidom as m; m.parse('path/to/file.xml')"`

There is no local Odoo instance, virtualenv, or `requirements.txt` checked
into this repo yet — set one up separately when doing live testing.

## Architecture

Four models, in a linear dependency chain:

- `shalom.route.route` (`models/route_route.py`) — the route master record
  (name, salesperson, vehicle). Owns `line_ids`.
- `shalom.route.line` (`models/route_line.py`) — a template stop: one
  customer (`partner_id`) on a route, tagged with a `weekday` (0=Monday..
  6=Sunday, matching Python's `date.weekday()`). This is schedule data, not
  a day's actual activity.
- `shalom.route.visit` (`models/route_visit.py`) — one execution of a route
  on one `date`. `action_generate_stops()` reads the route's `line_ids`,
  filters by the visit date's weekday, and copies matches into `stop_ids`
  as `shalom.route.visit.line` records. Sequenced via `ir.sequence` code
  `shalom.route.visit` (prefix `RV/%(year)s/`, see
  `data/ir_sequence_data.xml`). Has a draft → in_progress → done/cancelled
  state machine.
- `shalom.route.visit.line` (`models/route_visit_line.py`) — one stop within
  a visit. `action_create_sale_order()` creates a bare `sale.order` for the
  stop's partner, links it via `sale_order_id`, and flips state to `sold`;
  `action_mark_no_sale()` flips to `no_sale`. `amount_total` is a related
  field read live from the linked order — no amount is stored redundantly.

Key point when extending: route lines (schedule) and visit lines (a day's
actual stops) are deliberately separate models. Editing a route's weekly
schedule never retroactively changes past or already-generated visits.

## Conventions

- Depends on `base`, `mail` (chatter/tracking on `shalom.route.visit`), and
  `sale_management` (for `sale.order`) — declared in `__manifest__.py`.
- Security groups: `group_route_sales_user` (read/write/create) and
  `group_route_sales_manager` (adds unlink), under the `Route Sales` module
  category (`security/route_sales_security.xml`). Access rules for all four
  models live in `security/ir.model.access.csv` — add a row per model per
  group when adding a model.
- `weekday` is a `Selection` of string integers `'0'`-`'6'` (not a real
  `Date`/`Datetime`) so it can represent a recurring day-of-week independent
  of any specific date.
