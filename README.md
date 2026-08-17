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
- `ruta_shalom/` — la app del vendedor ("Ruta Shalom"): shell + nav
  inferior (`app.js`), pestaña Rutas (`rutas_hub.js`), detalle de ruta
  Lista/Mapa (`ruta_detalle.js`), hoja de visita (`visit_sheet.js`),
  catálogo + carrito + escaneo de código de barras (`order_screen.js`,
  Fase 3), y las pestañas Cotizaciones (`cotizaciones.js`, Fase 4) y
  Clientes (`clientes.js`, Fase 4, con alta rápida desde la calle).
  El catálogo pide sus datos directo con `orm.searchRead` sobre
  `product.product` (sin método de backend nuevo, incluye foto vía
  `image_1024` y categoría) y usa el `BarcodeDetector` nativo del
  navegador para escanear -- sin librería externa. Del carrito hay dos
  salidas: "Confirmar pedido" llama a
  `fsm.order.shalom_confirmar_pedido()` (venta real, reserva stock,
  cierra la visita); "Revisar cotización" llama a
  `shalom_guardar_borrador_pedido()` (deja la cotización en borrador y
  abre Ventas para que el vendedor ajuste precios/promociones ahí).
  `action_utils.js` normaliza las acciones `ir.actions.act_window` que
  devuelven los métodos de Python para `action.doAction()` desde JS.
  El cierre de pantallas (hoja de visita, catálogo) es siempre estado
  interno de Owl, sin tocar el historial del navegador -- se probó con
  `history.pushState`/`popstate` para que el botón Atrás de Android
  cerrara un nivel a la vez, pero choca con el router propio del web
  client de Odoo 18 (rompía la redirección de "Revisar cotización");
  se sacó por completo, ver `docs/plan_fase_1_a_4.md`.

## Convención

Los módulos OCA viven únicamente en el servidor y no se copian a este repo:
son dependencia de terceros, se actualizan por su cuenta (upstream OCA) y no
por cambios de este equipo. Solo se versiona aquí el código propio
(`shalom_*`).

## Estado del proyecto

Fases 0, 1, 2, 3 y 4 completas, desplegadas y probadas en producción.
Varias tuvieron rondas de ajustes de UX después de la primera prueba
real del usuario -- Fase 3: fotos/categorías en el catálogo, botón
Atrás de Android, arrastrar para cerrar la hoja de visita, fix del
escáner, "Revisar cotización" antes de confirmar; Fase 4: ficha de
cliente ampliada (RUC, celular, correo, foto del local, ruta + orden,
GPS) en un componente compartido (`ClienteForm`) entre "Editar
cliente" y "Alta rápida". Ver el detalle completo en
`docs/plan_fase_1_a_4.md`, que también tiene las decisiones de
producto ya confirmadas y los datos técnicos del servidor ya
verificados.

## Cómo desplegar cambios a producción

Este es el único flujo válido para llevar un cambio de este repo al
servidor. **Nunca saltar pasos ni asumir que uno funcionó sin
verificarlo explícitamente.** Antes de la primera prueba de cada
cambio grande, recordar el snapshot del disco de datos en GCP como red
de seguridad.

### 0. Datos fijos del servidor

- VM `traspastras2-east` (GCP, IP `104.196.114.160`), acceso por SSH
  como `andresabg09` (no hay login directo de `root`; usar `sudo` para
  todo lo que necesita permisos de root).
- Addons en `/root/odoo-addons/`, owned por `root` — **cualquier
  lectura/verificación desde la VM necesita `sudo`**, incluso un `ls`
  o `find` simple. Un "Permission denied" en un comando sin `sudo` NO
  significa que el archivo no exista.
- Contenedor Odoo: el nombre rota en cada `docker service update
  --force` (formato `crm_odoo.1.<sufijo random>`). Conseguirlo con:
  ```bash
  docker ps --format '{{.Names}}' | grep -E '^crm_odoo\.'
  ```
  El `^crm_odoo\.` (con el punto) es obligatorio: un `grep crm_odoo`
  sin anclar también matchea el contenedor de la base de datos
  (`crm_odoo-db.1...`), y eso rompe silenciosamente cualquier comando
  que use `$CONTAINER` después (falla con "page not found" sin
  explicación clara).
- Base de datos: `shalom`. Siempre anteponer `/entrypoint.sh` antes de
  `odoo` dentro del contenedor (la conexión a la DB llega por
  variables de entorno del contenedor, no por `/etc/odoo/odoo.conf`).

### 1. Escribir el/los archivo(s) en el servidor

- **1-2 archivos chicos** (hasta ~300 líneas en total): pegar directo
  por SSH con `sudo tee <ruta> > /dev/null <<'EOF' ... EOF`.
- **Varios archivos o algo grande**: armar un script bash local que
  escriba todos los archivos con `sudo tee` (uno por archivo, cada uno
  con su propio heredoc), mandárselo al usuario como archivo
  descargable (no pegado en el chat), y que lo suba por `scp` +
  ejecute por SSH. Bloques enormes pegados directo en la terminal
  pueden colgar o desconectar algunos clientes SSH.
  - **El `scp` (y el `ssh` que lo sigue) se corren desde la
    computadora del usuario, nunca desde una sesión que ya está
    conectada adentro del servidor.** Confundir esto es el error más
    común: intentar `scp archivo.sh usuario@servidor:/tmp/` estando ya
    logueado en `servidor` falla (`Permission denied (publickey)` o
    similar) porque el archivo no existe ahí.
  - `ssh usuario@servidor` y el comando que lo sigue (`bash
    /tmp/script.sh`) hay que correrlos como **pasos separados**, no
    pegados juntos de una: si se pegan en el mismo bloque, el segundo
    comando puede perderse en medio del banner de bienvenida de SSH y
    nunca ejecutarse (sin ningún error visible).
- Filebrowser (subida por navegador) es una alternativa, pero puede
  fallar en silencio si intenta sobrescribir archivos que ya son de
  otro dueño sin `chown`/`chmod` previo sobre la carpeta destino — en
  la práctica, `scp` + `sudo tee` fue más confiable en este proyecto.

### 2. Verificar que llegó íntegro

```bash
sudo sha256sum <ruta completa de cada archivo escrito>
```

Comparar contra el hash calculado localmente del mismo archivo antes
de darlo por bueno. Para XML, validar sintaxis:

```bash
sudo python3 -c "import xml.dom.minidom as m; m.parse('<ruta>')"
```

No seguir al paso 3 hasta que esto esté confirmado.

### 3. Permisos, actualizar el módulo y reiniciar

```bash
sudo chown -R 101:101 /root/odoo-addons/shalom_location_map
sudo find /root/odoo-addons/shalom_location_map -type d -exec chmod 755 {} \;
sudo find /root/odoo-addons/shalom_location_map -type f -exec chmod 644 {} \;

CONTAINER=$(docker ps --format '{{.Names}}' | grep -E '^crm_odoo\.')
docker exec -u root "$CONTAINER" chown -R odoo:odoo /mnt/extra-addons/shalom_location_map

docker exec -i "$CONTAINER" /entrypoint.sh odoo -c /etc/odoo/odoo.conf \
  -d shalom -u shalom_location_map --stop-after-init --no-http
```

Revisar esa salida **entera** (no solo el final) por `Traceback`,
`ERROR` o `CRITICAL`. Recién si está limpia:

```bash
docker service update --force crm_odoo
docker ps --format '{{.Names}}' | grep -E '^crm_odoo\.'
```

(el nombre del contenedor tiene que cambiar respecto al anterior).
Verificación final: recargar fuerte el navegador y probar el cambio
real ahí, no solo confirmar que el reinicio "salió bien" — un
reinicio limpio no garantiza que la funcionalidad ande.

### Bugs nativos ya encontrados (para no volver a pisarlos)

- **`fieldservice` bloquea escribir `stage_id` directo a la etapa
  "Completado"** salvo que el contexto de la llamada tenga
  `bypass_order_completed_stage=True` (pensado para que nadie la
  mueva ahí arrastrando una tarjeta en el Kanban nativo sin pasar por
  un flujo controlado). Aplica tanto a escrituras desde Python
  (`self.with_context(bypass_order_completed_stage=True).write(...)`)
  como desde JS (`orm.write(model, ids, vals, {context:
  {bypass_order_completed_stage: true}}))`).
- **Un dict de acción devuelto por un método Python** (ej.
  `{"type": "ir.actions.act_window", "view_mode": "list,form", ...}`)
  necesita el campo `views` ya armado como lista de `[false, tipo]`
  antes de pasarlo a `action.doAction()` desde JS. Cuando la acción la
  dispara un botón nativo del formulario, Odoo completa ese campo
  solo; en una llamada directa vía `orm.call` + `doAction()` hay que
  armarlo a mano o revienta con `Cannot read properties of undefined
  (reading 'map')`.
- **`fsm.person.user_id` existe en el modelo** (sin restricción de
  grupos) **pero no está en la vista de formulario nativa**
  (`fieldservice.fsm_person_form`) — por eso oficina no podía vincular
  una Persona con su cuenta de login de Odoo desde la pantalla. Se
  expone vía `views/fsm_person_views.xml` (heredando esa vista),
  reetiquetado "Usuario de Odoo (login)" para no confundirlo con el
  campo "Vendedor" que ya existe en otro lado.
