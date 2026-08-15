# Sistema de servicio de campo (Field Service)

Este repo documenta y versiona los módulos custom del sistema de servicio de
campo / ventas de ruta. La base funcional corre sobre el stack **OCA
Field Service**, instalado en el servidor `traspastras2-east`
(`/root/odoo-addons/`) y **no se toca ni se reorganiza** — se trata como
dependencia externa de solo lectura.

## Stack OCA (no tocar)

Módulos base del ecosistema, en orden de dependencia:

- **`base_territory`** — divisiones territoriales genéricas (zonas,
  regiones) usadas para segmentar clientes y rutas.
- **`base_geoengine`** — capa de geolocalización/GIS sobre `res.partner` y
  otros modelos (geometrías, mapas).
- **`fieldservice`** — módulo raíz: órdenes de servicio de campo (`fsm.order`),
  ubicaciones de servicio (`fsm.location`), personas/equipos (`fsm.person`,
  `fsm.team`).
- **`fieldservice_route`** — rutas y planificación de recorridos sobre
  `fieldservice` (`fsm.route`, secuenciación de órdenes por ruta y día).
- **`fieldservice_sale`** — integración con `sale.order`: generación de
  órdenes de servicio desde ventas.
- **`fieldservice_crm`** — integración con `crm.lead` / oportunidades.
- **`fieldservice_account`** — integración con facturación (`account.move`)
  desde órdenes de servicio.
- **`fieldservice_geoengine`** — puente entre `fieldservice` y
  `base_geoengine`: visualización de órdenes/rutas en mapa.

## Módulo custom (este repo)

- **`shalom_location_map`** — capa de mapa, GPS y ruteo sobre Field
  Service (ver detalle abajo). Traído desde
  `traspastras2-east:/root/odoo-addons/shalom_location_map`. Único módulo
  del repo (la exploración inicial `shalom_route_sales/` se descartó).

## `shalom_location_map`: arquitectura real

Depende de `fieldservice`, `fieldservice_geoengine`, `fieldservice_route` y
`base_geoengine` (declarado en su `__manifest__.py`; **no** depende de
`fieldservice_sale`, `fieldservice_crm`, `fieldservice_account` ni
`base_territory` — esos quedan disponibles en el servidor por el resto del
stack, pero este módulo no los toca). Solo agrega comportamiento vía
herencia (`_inherit`) sobre tres modelos nativos de `fieldservice`, más un
controller HTTP y widgets Owl en el frontend. No define modelos propios.

### `models/fsm_location.py` — hereda `fsm.location`
- `x_orden_ruta` (Integer): posición del cliente dentro de su ruta (1 =
  primero a visitar). Editable a mano; se usa al generar visitas.
- `geo_localize()` sobrescrito: `fieldservice_geoengine` llama a un
  geocoder externo al crear una ubicación sin coordenadas, y si ese
  servicio falla, la excepción original interrumpe la creación/importación
  completa. Acá el override atrapa esa excepción, deja el registro creado
  sin coordenadas y solo loguea el warning — nunca inventa datos.
- `action_abrir_maps()`: abre Google Maps (app externa) con la ruta hacia
  las coordenadas guardadas del cliente.
- `action_migrar_orden_ruta_desde_notas()`: migración de una sola vez para
  rescatar el "Orden de ruta original: N" que antes vivía como texto en
  `notes` y volcarlo al campo `x_orden_ruta` real.

### `models/fsm_order.py` — hereda `fsm.order` (la visita/tarea)
- `x_cliente_orden_ruta`: related **store=True** a
  `location_id.x_orden_ruta` — es el mismo dato visto desde la visita;
  editar en un lado actualiza el otro.
- `x_jornada`: día de trabajo dentro de la ruta (jornada 1, 2, ...), no
  atado a un día calendario. Se recalcula solo cuando la escritura mueve
  `stage_id` a una etapa cerrada que no sea "Cancelled" y el usuario no
  mandó ya un valor manual en el mismo `write()`: compara `write_date` de
  la última orden completada de la misma `fsm_route_id`, y si pasaron más
  de `HORAS_INACTIVIDAD_NUEVA_JORNADA` (6h), suma una jornada nueva.
- `x_gps_capturado_lat/lng/fecha`: punto GPS leído del dispositivo del
  vendedor (botón separado, con confirmación explícita del lado JS antes
  de llamar a `action_capturar_gps()`), que además sobrescribe
  `partner_latitude/longitude` en la `fsm.location` del cliente — el botón
  existe justamente para corregir una ubicación imprecisa.
- `action_crear_cotizacion()`: crea (o reabre si ya existe, releyendo
  `sale_id` directo de la BD para evitar duplicados por doble click) una
  `sale.order` vinculada a la visita. Es el flujo inverso al nativo de
  `fieldservice_sale` (que genera la visita desde una venta ya hecha):
  acá primero se visita, y solo si el cliente compra se genera la venta.
- `action_ver_historial_cotizaciones()` / `get_datos_grafico_compras()`:
  historial y gráfico (widget Owl + Chart.js) de compras confirmadas
  (`state in ('sale', 'done')`) del cliente, con detección de productos
  "olvidados" (sin compra en `MESES_SIN_COMPRA_PARA_ALERTA` = 3 meses).

### `models/fsm_route.py` — hereda `fsm.route`
- `x_ruta_trazado` (`GeoLine`, srid 4326): geometría real (siguiendo
  calles) de la ruta.
- `action_generar_visitas_ruta()`: crea una `fsm.order` por cada
  `fsm.location` de la ruta ordenada por `x_orden_ruta`, sin duplicar si
  el cliente ya tiene una orden abierta (no cerrada).
- `action_archivar_visitas_cerradas()`: archiva (`active=False`) las
  visitas cerradas de la ruta para poder generar el ciclo siguiente sin
  perder historial.
- `action_calcular_trazado_ruta()`: llama a Mapbox Directions API con las
  coordenadas de los clientes en orden de `x_orden_ruta` y guarda el WKT
  resultante en `x_ruta_trazado`. Límite duro de
  `MAPBOX_MAX_WAYPOINTS = 25` clientes por ruta (dividir en tramos no está
  implementado); requiere `MAPBOX_ACCESS_TOKEN` como variable de entorno
  del servidor (nunca hardcodeado).

### `controllers/mapbox_token.py`
Endpoint JSON (`/shalom_location_map/mapbox_public_token`, `auth="user"`)
que expone el mismo token público de Mapbox al JS del navegador para
pintar el mapa base.

### Frontend (`static/src/`)
Widgets Owl inyectados en `web.assets_backend`:
- `fsm_order_gps_button.js` — botón de captura de GPS con confirmación.
- `mapbox_background_layer.js` — capa de tiles Mapbox sobre las vistas
  geoengine nativas.
- `mini_mapa_widget.js`/`.xml` — mini-mapa embebido en la tarjeta de
  visita: pide el GPS del navegador automáticamente al abrir (solo lee,
  no escribe, por eso sin confirmación) y traza en vivo con Mapbox
  Directions + Mapbox GL JS la ruta hasta el cliente.
- `resumen_compras_widget.js`/`.xml` — gráfico de línea de tiempo de
  compras/productos olvidados sobre `get_datos_grafico_compras()`.

## Convención

Los módulos OCA viven únicamente en el servidor y no se copian a este repo:
son dependencia de terceros, se actualizan por su cuenta (upstream OCA) y no
por cambios de este equipo. Solo se versiona aquí el código propio
(`shalom_*`).
