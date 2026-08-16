# Plan: app del vendedor "Ruta Shalom" — Fases 1 a 4

> Este documento existe para que una sesión nueva de Claude Code pueda
> retomar el trabajo sin perder contexto. Fase 0 (backend) ya está
> completa, probada en producción y commiteada (ver abajo). Este
> archivo cubre el plan aprobado para las fases que faltan (el
> frontend, la app en sí).

## Origen

El diseño visual de referencia es un artifact de Claude (prototipo
HTML/JS standalone, "Ruta Shalom"):
https://claude.ai/code/artifact/b05b9d84-98f2-4328-892e-e27d18c9ed2d

Es solo **referencia de UX/interacciones** — el mapa del prototipo es
una cuadrícula esquemática dibujada a mano (`<canvas>`) hecha para la
demo, no la implementación real. En producción el mapa usa Mapbox GL
real, reusando el patrón que ya existe en
`static/src/js/mini_mapa_widget.js` + `controllers/mapbox_token.py`.

## Estado actual: Fase 0 completa (backend)

- Rama: `claude/field-service-odoo-design-6nphya`
- Commit: `4d8e9b0` "Fase 0: modelo de programación semanal de rutas +
  arreglos de bugs preexistentes"
- **Ya desplegado y probado de punta a punta en producción**
  (servidor `traspastras2-east`, contenedor `crm_odoo`, base de datos
  `shalom`).

Qué se construyó:
- **Modelo nuevo `fsm.route.schedule`**: una ocurrencia semanal de una
  `fsm.route` (la ruta en sí no cambia). Campos: `route_id`,
  `date_start`/`date_end`, `x_tiempo_estimado` (carga manual de
  oficina), `capacidad` (compute: suma del último `sale.order`
  confirmado de cada cliente de la ruta), `estado` (compute:
  por_iniciar/en_curso/completada, según las `fsm.order` vinculadas).
  Vistas admin + menú dentro de **Servicio de Campo → Operaciones**
  (xml_id `fieldservice.operations`) — NO es una app aparte.
- **`fsm.order`**: campos `x_route_schedule_id`,
  `x_observaciones_visita`; método `shalom_confirmar_pedido(lineas)`
  que crea/actualiza la cotización, la confirma (`action_confirm`,
  venta real, reserva stock) y cierra la visita — pensado para el
  flujo de catálogo+carrito de la app (Fase 3).
- **`fsm.route`**: `action_generar_visitas_ruta()` acepta un `schedule`
  opcional para taggear las visitas creadas.
- **`fsm.location`**: `shalom_crear_cliente_rapido(name, phone,
  address)` para alta rápida de cliente desde la calle (sin asignar
  ruta, eso lo hace oficina después).
- **`fsm.person`** (archivo nuevo `models/fsm_person.py`): 3 métodos
  "mis datos" para que la app pida todo en una llamada:
  `shalom_mis_rutas_programadas(date_start, date_end)`,
  `shalom_mis_clientes()`, `shalom_mis_cotizaciones()`. Resuelven
  "asignado a mí" vía `fsm.person.user_id = uid` → sus `fsm.route` →
  las `fsm.location`/`fsm.order`/`sale.order` de esas rutas.
- **Etapa nueva "No quiso"** (cerrada, distinta de "Cancelado").
- **Dos bugs preexistentes corregidos** (no relacionados al pedido
  original, encontrados durante la verificación): cálculo de Jornada
  comparaba contra el nombre de etapa "Cancelled" (inglés) en vez de
  "Cancelado" (el real, vía xml_id ahora); y el color del kanban de
  visitas asumía IDs de etapa fijos que no correspondían a esta
  instalación (ahora colorea por `stage_name`).

## Decisiones de producto ya confirmadas por el usuario (no volver a preguntar)

- **Confirmar pedido** (Fase 3, botón final del carrito) = confirma la
  `sale.order` en el acto (`action_confirm`, reserva stock). La
  factura se genera después, en oficina, sin cambios ahí.
- **Cancelado** = solo cierra la visita con esa etapa, queda como
  nota. NO desactiva automáticamente al cliente de rutas futuras (v1).
- **Inventario (`stock`) está instalado** → usar `qty_available` real
  para el aviso de stock bajo en el catálogo.
- **Vendedores usan Android/Chrome** → escaneo de código de barras con
  `BarcodeDetector` nativo del navegador, sin librería JS externa.
- **Calendario semanal completo**: sí construirlo (ya hecho en Fase 0,
  `fsm.route.schedule`) en vez de simplificar a "solo mis rutas sin
  filtro de semana".
- El menú de administración vive dentro de Servicio de Campo, nunca
  como app aparte (ya aplicado en Fase 0, mantenerlo así en todo lo
  que sigue).

## Datos técnicos del servidor confirmados por SSH (no volver a asumir)

- `fieldservice.group_fsm_user` / `fieldservice.group_fsm_manager`:
  existen ("Usuario" / "Gerente").
- `fsm.route.fsm_person_id`: existe (vendedor asignado a la ruta).
- `fsm.person.user_id`: existe (vínculo con el usuario de Odoo).
- `fieldservice.fsm_stage_completed` / `fsm_stage_cancelled`: existen,
  `is_closed=True` ambas.
- `fsm.order.stage_name`: campo nativo, texto plano del nombre de la
  etapa actual — útil para `decoration-*` en vistas list/kanban sin
  tener que resolver el many2one.
- `product.product.qty_available` / `barcode`: existen.
- Etapas reales de `fsm.stage` (`stage_type='order'`) en producción:
  Cancelado (id 3, seq 0), New (id 7, seq 1), Completado (id 2, seq
  2), No quiso (nueva, seq 3). **No asumir IDs fijos nunca** — se
  descubrió un bug justamente por asumir 1/2/3.
- Módulos instalados relevantes: `stock`, `fieldservice`,
  `fieldservice_route`, `fieldservice_geoengine`, `base_geoengine`,
  `sale`, `shalom_location_map`. NO instalados (y no depender de
  ellos): `fieldservice_sale`, `fieldservice_crm`,
  `fieldservice_account`, `base_territory`.

## Cómo desplegar (flujo que funciona, aprendido en Fase 0)

- Contenedor Odoo: nombre rota en cada `docker service update
  --force` (formato `crm_odoo.1.<sufijo random>`). **Siempre** correr
  `docker ps --format '{{.Names}}' | grep crm_odoo` antes de cualquier
  comando para tener el nombre actual.
- Base de datos: `shalom`. La conexión (host/usuario/clave) llega por
  variables de entorno del contenedor, NO está en `/etc/odoo/odoo.conf`
  — por eso `odoo shell` u `odoo -u` directos fallan con
  `OperationalError`. Siempre anteponer `/entrypoint.sh` antes del
  comando `odoo` (ej: `docker exec -i <CONTENEDOR> /entrypoint.sh odoo
  shell -d shalom < archivo.py`).
- Rutas: dentro del contenedor el addons_path es `/mnt/extra-addons`;
  en el host (la VM) es `/root/odoo-addons/`. `/root/` es solo
  accesible por `root` — cualquier lectura/verificación desde la VM
  necesita `sudo` (`sudo cat`, `sudo grep`, `sudo python3 -c ...`).
- **Para 1-2 archivos**: pegar directo por SSH con
  `sudo tee /root/odoo-addons/shalom_location_map/<ruta> > /dev/null
  <<'EOF' ... EOF`. Nunca escribir el archivo dentro del contenedor
  con `docker exec ... cat > archivo` y después redirigir `<
  /ruta/al/archivo` desde el host en otro comando — el `<` se evalúa
  en el host, no adentro del contenedor, y el archivo no existe ahí
  (ya pasó dos veces).
- **Para cambios grandes** (muchos archivos nuevos/borrados): armar un
  zip local, mandarlo al usuario (tiene `filebrowser`), que lo suba
  arrastrando la carpeta. Filebrowser no puede sobrescribir archivos
  que ya son de otro dueño sin antes hacer `chown`+`chmod` sobre la
  carpeta existente (o falla con permission denied silencioso).
- Después de escribir cualquier archivo: en el host,
  `sudo chown 101:101 <archivo>` + `sudo chmod 644 <archivo>`
  (carpetas: `chmod 755`); adentro del contenedor,
  `docker exec -u root <CONTENEDOR> chown odoo:odoo <ruta bajo
  /mnt/extra-addons/...>`.
- Aplicar a la base: `docker exec <CONTENEDOR> /entrypoint.sh odoo -c
  /etc/odoo/odoo.conf -d shalom -u shalom_location_map
  --stop-after-init --no-http` — revisar que no haya
  `Traceback`/`ERROR`/`CRITICAL` en la salida.
- Recién con eso limpio, reiniciar: `docker service update --force
  crm_odoo` (esto genera un contenedor con nombre nuevo).
- Nunca saltar la verificación explícita del usuario ni comprimir los
  3 pasos (pegar código → verificar → permisos+actualizar). Nunca
  commitear/pushear sin confirmación explícita.
- Antes de la primera prueba de cada cambio grande nuevo, recordar el
  snapshot de disco de GCP como red de seguridad.

## Arquitectura aprobada para el frontend (Fases 1-4)

Client action Owl **nuevo**, registrado como `ir.actions.client` +
`menuitem` dentro de Servicio de Campo → Operaciones (igual que
"Programación de Rutas"). **No reemplaza ninguna vista nativa** — las
vistas admin de Fase 0 siguen existiendo para que oficina arme rutas,
clientes y planificación; esta app es exclusivamente para el flujo
diario del vendedor.

Archivos previstos (un componente por pantalla):
- `static/src/js/ruta_shalom/app.js` (shell + nav inferior)
- `static/src/js/ruta_shalom/rutas_hub.js` (pestaña Rutas: filtro
  semana/mes real contra `fsm.route.schedule`, usa
  `fsm.person.shalom_mis_rutas_programadas`)
- `static/src/js/ruta_shalom/ruta_detalle.js` (tabs Lista/Mapa; Mapa
  con Mapbox GL real, reusando el patrón de `mini_mapa_widget.js`)
- `static/src/js/ruta_shalom/visit_sheet.js` (hoja de visita: estado,
  `x_observaciones_visita`, acciones rápidas llamar/Maps/GPS/historial,
  editar cliente)
- `static/src/js/ruta_shalom/order_screen.js` (catálogo + carrito +
  `BarcodeDetector` + `shalom_confirmar_pedido`)
- `static/src/js/ruta_shalom/cotizaciones.js` /
  `static/src/js/ruta_shalom/clientes.js` (usan
  `shalom_mis_cotizaciones` / `shalom_mis_clientes` +
  `shalom_crear_cliente_rapido`)
- Plantillas en `static/src/xml/ruta_shalom/*.xml`, estilos en
  `static/src/scss/ruta_shalom.scss`.

El catálogo de productos (nombre, precio, categoría, barcode,
`qty_available`) no necesita método de backend nuevo: se pide directo
con `orm.searchRead` sobre `product.product` desde el frontend.

## Orden de implementación (sin cambios respecto al plan original)

1. **Fase 1**: shell de la app (nav inferior) + pestaña Rutas (hub con
   filtro semana/mes) + detalle de ruta (Lista + Mapa real).
2. **Fase 2**: hoja de visita (estado, observaciones, acciones
   rápidas, editar cliente).
3. **Fase 3**: catálogo + carrito + `shalom_confirmar_pedido` +
   escaneo de código de barras.
4. **Fase 4**: pestañas Cotizaciones y Clientes (con alta rápida).

Cada fase se entrega, se prueba en producción siguiendo el flujo de
arriba, y se commitea/pushea por separado — igual que Fase 0.
