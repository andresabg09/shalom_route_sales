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

## End-to-end workflow (mandatory order, no exceptions)

This is the full loop for **any** requested change, from the moment the
user asks for something to the moment it's live and committed. Follow
it every time, in every new chat, without the user having to repeat it
— that's the whole point of it living here instead of in the user's
head. Changes are deployed straight to production (no separate staging
in active use), during low-traffic hours.

1. **User asks** for a change/fix, in whatever words.
2. **Claude gives a mini-plan** — no code yet — restating what was
   understood and what's about to be done. If Claude might have
   misread the ask, this is the moment to say so plainly, not to
   guess and build.
3. **User approves the mini-plan** (or corrects it — repeat step 2
   until approved).
4. **Only once approved**, Claude does the actual implementation in
   this repo's working tree (code, views, data files, docs — whatever
   the plan called for). Don't stop to re-ask about things already
   covered by the approved plan; do stop for a real product/UX
   decision that comes up mid-implementation (see "Working rules"
   below).
5. Claude hands the user **one `.sh` script**, sent as a file (not a
   giant blob to paste by hand into an interactive shell — that has
   caused real mistakes: skipped steps, literal placeholders left
   un-replaced, etc.). The script must, in order: write each
   changed/new file to a temp dir via `cat <<'EOF' ... EOF` heredocs
   (quoted delimiter, so nothing expands), `sudo cp`/`sudo mkdir -p`
   each one into place under `/root/odoo-addons/shalom_location_map/`,
   then run `sudo sha256sum` on every touched file (full paths — never
   a bare `cd` into `/root/odoo-addons/...`, that directory isn't
   readable by the normal user even to `cd`). Claude computes the same
   `sha256sum` locally first and posts those hashes in chat so the
   user has something to diff against. The user's commands are just:
   `scp the-script.sh user@host:~/` then `bash the-script.sh`.
6. **User runs it, pastes back the hash output.** Claude compares
   against its own precomputed hashes. If anything doesn't match,
   stop and figure out why before continuing.
7. **Only if the hashes match**, give the permission-fix commands
   (`chown`/`chmod` on host, then `chown` **inside the container** —
   remember the container-side addons path is `/mnt/extra-addons/...`,
   not the host's `/root/odoo-addons/...`, even though they're the
   same bind-mounted folder; get the container ID fresh via
   `docker ps` every time, never reuse an old one, especially right
   after a `docker service update --force` since that always spins up
   a new container ID).
8. **Only after permissions are confirmed applied**, give the module
   update command (`docker exec ... odoo -u shalom_location_map -d
   shalom --db_host=... --db_port=... --db_user=... --stop-after-init`,
   with `PGPASSWORD` passed via `-e` env var to `docker exec`, never as
   a plain CLI flag). The production database is named **`shalom`**
   (confirmed via `psql -l` — the only real DB besides
   `postgres`/`template0`/`template1`) — don't re-discover this via
   `psql -l` every session, go straight to the update command.
   `odoo.conf` on this server has no `db_*` keys — those live as env
   vars on the container (`HOST`, `PORT`, `USER`, `PASSWORD`); read
   them with `docker exec [ID] env | grep -iE 'host|port|user|pass|name'`
   if unsure (container env vars, unlike the DB name, can change if the
   stack is reconfigured, so still worth a quick check rather than
   hardcoding host/port/user/password here).
9. **Only if that update runs clean (no traceback)**, give
   `docker service update --force crm_odoo` to restart the service.

   **Delivery of steps 5/7/8/9, to cut back-and-forth**: Claude sends
   steps 5, 7 and 8 together in a single message — the script, the
   precomputed hashes, the permission-fix commands, *and* the module
   update command, all at once, with an explicit "STOP HERE" marker
   right before the restart command (step 9). The user runs
   everything up to that marker in one go and pastes back the whole
   combined output (hashes + permission commands + update log) in one
   message; Claude reviews it all at once and only then hands over the
   restart command. The restart command itself is **never** bundled
   into the same block the user runs unattended — that would remove
   the one real checkpoint this flow has (catching a traceback in the
   update log *before* the broken module goes live via restart), which
   is the whole reason steps 8/9 are gated in the first place. If the
   hashes don't match or the update log shows a traceback, stop there
   and figure out why before giving anything else.

   **Everything the user runs on the server is a `.sh` file, no
   exceptions** — explicit user request, this rule is absolute. This
   was already true for step 5; it applies just as much to steps 7, 8
   and 9: the permission-fix commands and the module update command
   (bundled together per the paragraph above) go into one `.sh` script
   sent as a file, and the restart command (step 9, sent separately
   after the STOP checkpoint) is its **own** `.sh` script too — never
   raw shell commands pasted inline in chat for the user to copy by
   hand, no matter how short or "safe-looking" the command is (a
   one-line `docker service update --force crm_odoo` still goes in its
   own tiny script). Claude never runs these commands itself either —
   it has no direct access to the production server; the user always
   executes the script themselves, in their own SSH session already
   open on the VM (no `scp` needed when they're already logged in —
   only when the script needs to get from Claude's environment onto
   the VM in the first place).
10. **User tests the change live** in production and reports back
    what happened.
11. **Only once the user confirms it works**, `git commit` + `push` —
    never before. Until that confirmation, don't even edit the tracked
    files in this repo's working tree for a **code** change (see the
    "Git commits" rule below) — pure documentation changes (like this
    file) are the one exception, since they don't run on the server
    and can be committed once the user explicitly approves the text.

Never skip a step or assume one worked without the user's pasted
output proving it. Upload replaces the `shalom_location_map` folder in
place, same name — never uninstall first. If something breaks,
uninstall over SSH if needed (no GUI required). Before the **first**
test of a significant change, remind the user to snapshot the GCP data
disk as a safety net.

If a session's stop hook (or similar mechanism) complains about
uncommitted changes or pushes back asking to commit/push before the
user has confirmed the production test, that hook does not override
this rule — surface the conflict to the user and ask, don't just
comply and push.

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
  user to run in their own terminal. For any change to the
  `shalom_location_map` module code (not pure docs), this confirmation
  can only come **after** the user has verified the change works on
  production — see "End-to-end workflow" above.
- **Production risk**: flag it explicitly before proceeding whenever a
  change carries real production risk, even if it seems obvious and even
  if the user didn't ask.
- **Product/UX decisions** (as opposed to technical ones): ask the user
  directly instead of assuming.
