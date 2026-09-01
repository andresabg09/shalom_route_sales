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
stack, pero este módulo no los toca). Agrega comportamiento vía herencia
(`_inherit`) sobre tres modelos nativos de `fieldservice`, más un
controller HTTP, widgets Owl en el frontend, y un wizard de administración
con modelos transitorios propios (ver más abajo) — el primer modelo
propio que define el módulo en vez de solo extender los nativos.

### `models/fsm_location.py` — hereda `fsm.location`
- `x_orden_ruta` (Integer): posición del cliente dentro de su ruta (1 =
  primero a visitar). Editable a mano; se usa al generar visitas.
- `x_venta_mas_alta` (Monetary, calculado): la venta CONFIRMADA de
  mayor monto (no la última, la más alta) que se le haya hecho alguna
  vez al contacto de este cliente — mismo criterio que `capacidad` en
  `fsm_route_schedule.py` (que suma la ÚLTIMA venta de cada cliente de
  la ruta para estimar el potencial de la ruta completa), pero acá por
  MÁXIMO y a nivel de un solo cliente. Se muestra en el listado de
  clientes de una ruta puntual, dentro de la app del vendedor (ver
  `ruta_detalle.js`/`.xml` más abajo), como meta concreta: "a este
  cliente ya se le vendió hasta $X".
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
- `x_duracion_dias` (Integer, default 7): cuántos días dura típicamente
  un recorrido completo de esta ruta (no todas duran una semana). Solo
  se usa para SUGERIR la fecha de fin al crear/renovar una
  `fsm.route.schedule` de esta ruta (ver abajo) — la fecha real de cada
  ciclo concreto siempre es editable a mano.

### `models/fsm_route_schedule.py` — modelo propio (no `_inherit`)
Una "ocurrencia" de una `fsm.route` para un ciclo concreto (`date_start`
– `date_end`), separada de la ruta en sí (que solo es la lista ordenada
de clientes). Es lo que alimenta la pestaña "Rutas" de la app del
vendedor, agrupada/filtrada por ciclo o mes — el vendedor solo la lee,
nunca la edita.
- `date_start`/`date_end`: ambos editables a mano — `date_end` **no**
  es un cálculo fijo a +6 días (no todas las rutas son semanales).
  `date_end` se sugiere solo, vía `_onchange_date_start_sugerir_fin`,
  a partir de `route_id.x_duracion_dias`, y solo si venía vacío (nunca
  pisa un valor ya cargado).
- `capacidad` (Monetary, calculado): suma del último `sale.order`
  CONFIRMADO de cada cliente de la ruta — estimación de cuánto puede
  vender el vendedor si visita a todos.
- `estado` (calculado): `por_iniciar` / `en_curso` / `completada` según
  cuántas de las visitas generadas (`fsm_order_ids`) ya están en una
  etapa cerrada.
- `action_generar_visitas()`: igual que
  `action_generar_visitas_ruta()`, pero taggeando cada `fsm.order`
  creada con esta ocurrencia (`x_route_schedule_id`).
- `action_generar_proximo_ciclo()`: arranca el ciclo siguiente de la
  misma ruta en un solo paso — pensado para el caso típico de un mismo
  vendedor recorriendo la misma ruta muchas veces al año (ej. mensual).
  Cierra como "No atendido" **todas** las visitas abiertas de la RUTA
  (no solo las de esta ocurrencia puntual — cualquier visita vieja de
  la ruta que haya quedado sin cerrar, venga o no de un ciclo generado
  por este sistema; si solo mirara esta ocurrencia, `action_generar_
  visitas_ruta` seguiría viendo esas otras como "orden abierta" del
  cliente y saltaría a esos clientes en el ciclo nuevo — el bug
  reportado de "tengo 37 clientes pero solo se generan 9"), archiva las
  cerradas de la ruta, crea la `fsm.route.schedule` siguiente
  (`date_start` = `date_end` de esta + 1 día, `date_end` sugerido por
  `x_duracion_dias`) y le genera las visitas a los 37 clientes, no solo
  a los que ya tenían visita antes. Criterio explícito: si un cliente
  fue o no atendido el ciclo pasado no decide si le toca visita nueva —
  siempre le toca, a todos los clientes de la ruta, cada ciclo.

### `wizards/shalom_buscar_gps_wizard.py` — "Buscar GPS por nombre"
Wizard de administración (solo `fieldservice.group_fsm_manager`), menú
"Operaciones" de Field Service. Ayuda a completar el GPS de clientes
buscando por **nombre** en **Google Places API (Text Search)** — el mismo
truco que ya se usa a mano en Waze/Google Maps para encontrar un comercio
sin tener la dirección exacta (es literalmente el mismo motor). Requiere
`GOOGLE_PLACES_API_KEY` como variable de entorno del servidor (nunca
hardcodeada) — cargada desde EasyPanel, igual que `MAPBOX_ACCESS_TOKEN`.
Se probó primero con Mapbox Geocoding, pero su cobertura de comercios
chicos en Panamá resultó floja; Google Places la reemplazó por decisión
explícita del usuario. `MAPBOX_ACCESS_TOKEN` sigue existiendo para el
trazado de rutas en `fsm_route.py`, sin relación con este wizard.

La búsqueda es **por cliente, a pedido** — no hay un botón que busque
todo de una (para no disparar más llamadas a Google de las necesarias).
La lista principal (`ShalomBuscarGpsWizardLine`) tiene, por fila, 3
botones:
- **"Buscar opciones en Google"** (`action_buscar_opciones`): busca EN EL
  MOMENTO, solo para ese cliente, y abre un popup
  (`shalom.buscar.gps.wizard.opcion` / `.candidato`) con hasta
  `TOPE_OPCIONES_POR_CLIENTE` (3) resultados — Google no siempre acierta
  con el primero. Cada opción tiene su propio botón "Ver mapa"
  (`action_ver_mapa`, abre Google Maps en pestaña nueva) y "Usar esta
  opción" (`action_usar_esta`, guarda esa coordenada vía
  `fsm.location.shalom_actualizar_gps()`). Si ya se capturó "mi
  ubicación" (ver abajo), cada opción también muestra a cuántos km está
  (`distancia_km`, calculado con la fórmula de Haversine en
  `_distancia_km()`, sin depender de ninguna API paga extra).
- **"Dejar como está"** (`action_dejar_como_esta`): no busca ni cambia
  nada, pero saca al cliente de la cola para siempre.
- **"Borrar coordenada actual"** (`action_borrar_coordenada`): vacía el
  GPS del cliente pero lo DEJA en la cola — a diferencia de "Dejar como
  está", acá la intención es seguir buscándole una coordenada real más
  adelante, no abandonarlo.

La cola de "a quién mostrar" se basa en `fsm.location.x_gps_wizard_revisado`
(campo interno, no pensado para tocarse a mano fuera de este wizard): un
cliente sale de la cola cuando se le guarda una coordenada real o se
elige "Dejar como está" — "Borrar coordenada actual" es la única decisión
que NO lo saca de la cola. Se puede abrir desde el menú (carga las
ubicaciones no revisadas, con tope de `LIMITE_UBICACIONES_POR_CORRIDA` =
200) o desde una selección hecha a mano en la lista de Ubicaciones de
Servicio (acción del menú "Acción", vía `binding_model_id`, que ignora si
ya estaban revisadas). También tiene un selector de **Ruta** opcional
(`route_id`) con el botón "Cargar ubicaciones de esta ruta"
(`action_cargar_ubicaciones`), para atender ruta por ruta en el orden que
se prefiera.

**El popup de opciones ya NO saca al usuario del wizard principal al
manejar un cliente** (usar una coordenada, dejar como está, borrar
coordenada, o "Cerrar sin elegir") -- se reportó que con 100+ clientes en
una ruta, tener que reabrir el wizard y volver a elegir Ruta + "Capturar
mi ubicación" por cada cliente hacía la tarea impracticable.
`_volver_al_wizard_o_cerrar()` (en `.opcion`, reusado por `.candidato` vía
`opcion_id`) responde con un `next` que reabre el MISMO
`shalom.buscar.gps.wizard` (mismo `wizard_id`, ya guardado en `.opcion`
para esto) en vez de cerrar todo -- y saca de la lista la línea del
cliente ya manejado (o la deja, si fue "Borrar coordenada"/"Cerrar sin
elegir", donde no se decidió nada definitivo). El botón "Dejar como
está" de la lista principal (`ShalomBuscarGpsWizardLine`, sin popup de
por medio) hace lo mismo con `self.unlink()` directo. "Cerrar sin
elegir" dejó de ser un botón nativo `special="cancel"` -- por cómo Odoo
NO apila diálogos `target="new"` abiertos desde dentro de otro diálogo,
ese botón nativo cerraba TODO en vez de solo el popup; ahora es
`action_cerrar_popup()`, un botón `type="object"` normal que pasa por el
mismo mecanismo de "volver al wizard". Importante para cualquier acción
que reabra un wizard vía el `next` de una notificación (no vía el
return directo de un botón): **el dict de la acción necesita
`"views": [[False, "form"]]` explícito** -- sin eso, el cliente web tira
`TypeError: Cannot read properties of undefined (reading 'map')` en
`_preprocessAction`. Un botón `type="object"` que devuelve el action
DIRECTO (no envuelto en un `next`) no lo necesita porque Odoo lo
completa solo camino a `doActionButton`, pero se agregó por las dudas en
todos los act_window que devuelve este wizard.

El popup de opciones también muestra la **coordenada YA GUARDADA en
Odoo** para el cliente (`location_lat`/`location_lng`, `related` a
`fsm.location`) con su propio botón "Ver en mapa la coordenada actual"
(`action_ver_mapa_actual`), al lado de las opciones de Google -- para
poder comparar antes de elegir.

**La cola del wizard ya NO se basa en "revisado"**: antes, tanto
`default_get` como "Cargar ubicaciones de esta ruta" filtraban por
`x_gps_wizard_revisado = False`, lo que sacaba de la lista a clientes
que seguían sin GPS real solo porque ya se habían "revisado" antes.
Ahora el filtro por defecto es **clientes sin coordenadas** (`
partner_latitude`/`partner_longitude` vacíos o en 0) -- un cliente sale
de la lista únicamente cuando de verdad tiene una coordenada guardada.
Dos campos nuevos en el header dan control manual sobre ese filtro:
`mostrar_solo_sin_gps` (Boolean, default True -- "Solo sin GPS", como
el toggle de stock del catálogo) y `busqueda_nombre` (Char -- busca por
nombre SIN IMPORTAR el toggle, para encontrar y corregir un cliente
puntual al que se le puso una coordenada mal). `_dominio_ubicaciones()`
arma el domain combinando Ruta + toggle + búsqueda; el botón se
renombró a "Buscar / recargar lista" (antes "Cargar ubicaciones de esta
ruta", ahora también aplica el toggle y la búsqueda).

El popup de opciones (`shalom.buscar.gps.wizard.opcion`) tiene además un
campo editable **"Buscar en Google Maps"** (`query_busqueda`, precargado
con el nombre guardado del cliente) + botón "Buscar"
(`action_buscar_de_nuevo`): si el nombre tal cual está guardado no
encuentra el local correcto (typo, alias, local que cambió de nombre), se
puede reescribir la búsqueda a mano — agregar una calle, una referencia,
otro nombre — y volver a consultar Google sin salir del popup ni depender
de un solo intento automático. Reemplaza `candidato_ids` con los
resultados nuevos (recalculando `distancia_km` si ya se capturó "mi
ubicación").

**"Capturar mi ubicación"** (ícono `fa-crosshairs`) (`action_abrir_captura_mi_ubicacion` +
`static/src/js/shalom_capturar_mi_ubicacion_button.js`): pide el GPS del
navegador (sin confirmación, a diferencia de
`fsm_order_gps_button.js` — acá es de solo lectura, nunca sobreescribe
nada de un cliente) y lo guarda en `mi_lat`/`mi_lng` del wizard, para que
las próximas búsquedas de opciones muestren la distancia.

### `models/fsm_location.py` — `action_eliminar_ubicacion()` ("Eliminar esta Ubicación")
Botón en el formulario de Ubicación (solo `fieldservice.group_fsm_manager`,
con confirmación obligatoria antes de ejecutar) que borra **únicamente**
ese registro de `fsm.location` — nunca el contacto. Existe por un bug de
datos real encontrado en producción: `fsm.location` usa `_inherits` sobre
`res.partner` vía `partner_id` (`delegate=True`), así que `name`, `street`,
`active`, GPS, etc. son en realidad campos del contacto delegado, no de la
Ubicación. Eso significa que **archivar** una Ubicación (`active=False`,
lo que hacía antes el botón nativo "Archivar") apaga el `active` del
contacto — y si ese contacto tiene más de una Ubicación apuntándolo (pasó
con ~261 clientes de la importación original: dos o tres `fsm.location`
distintas comparten el mismo `partner_id`), las demás Ubicaciones del
mismo contacto se ven archivadas también, aunque no se hayan tocado, y el
cliente queda bloqueado para facturar. `action_eliminar_ubicacion()` en
cambio usa `unlink()`: por cómo funciona `_inherits` en Odoo, borrar la
fila de `fsm.location` NO borra ni toca el contacto delegado
(`partner_id`/`owner_id`), que sigue existiendo y activo. Si la Ubicación
tiene visitas y es la única del contacto, no se borra (se perdería ese
historial) y avisa en vez de bloquear en silencio; si hay otra Ubicación
del mismo contacto, las visitas se reasignan ahí antes de borrar.

(El wizard "Fusionar ubicaciones duplicadas" que hubo en una versión
anterior de este documento se descartó: los duplicados reales resultaron
ser casi todos este mismo patrón -- mismo contacto, Ubicación de más --,
resuelto con este botón más una limpieza puntual por script, no con un
wizard de fusión manual grupo por grupo.)

### `models/res_partner.py` -- hereda `res.partner`, botón "Crear Ubicación de Servicio"
Caso inverso al de `action_eliminar_ubicacion()`: un contacto viejo
(activo, con historial) que nunca tuvo ninguna `fsm.location` asociada.
El formulario nativo de "Nuevo" en Ubicaciones de Servicio no sirve
para este caso -- por cómo funciona `_inherits` (`fsm.location`
delegando en `res.partner` vía `partner_id`), ese formulario SIEMPRE
crea un Contacto nuevo al guardar; el campo "Contacto Relacionado"
queda de solo lectura ahí a propósito y no hay forma de elegir uno ya
existente. `action_crear_ubicacion_servicio()` agrega un botón
(`fieldservice.group_fsm_manager`, con confirmación) en la ficha
nativa de Contactos que crea la `fsm.location` pasando `partner_id`/
`owner_id` = el contacto YA EXISTENTE (nunca crea un Contacto nuevo) y
abre esa Ubicación recién creada para completar el resto (Ruta, Orden
de Ruta, GPS) a mano.

### `controllers/mapbox_token.py`
Endpoint JSON (`/shalom_location_map/mapbox_public_token`, `auth="user"`)
que expone el mismo token público de Mapbox al JS del navegador para
pintar el mapa base.

### Frontend (`static/src/`)
Widgets Owl inyectados en `web.assets_backend`:
- `fsm_order_gps_button.js` — botón de captura de GPS con confirmación.
- `shalom_capturar_mi_ubicacion_button.js` — mismo patrón que el
  anterior pero SIN confirmación (de solo lectura, nunca sobreescribe
  un cliente): usado por "Capturar mi ubicación" en el wizard
  "Buscar GPS por nombre", para calcular distancias.
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
  Lista/Mapa (`ruta_detalle.js` -- cada tarjeta de cliente muestra
  también `x_venta_mas_alta` (ícono `fa-flag`) en una columna propia a
  la derecha (`.stop-right`), apilada arriba del estado de la visita --
  NO comparte espacio con el nombre/dirección del cliente (se probó
  antes en la misma fila que la dirección; se reportó que así apretaba
  demasiado y el nombre se veía casi vertical), leído junto con
  `phone`/`street` en el mismo `orm.read` de `fsm.location`), hoja de
  visita (`visit_sheet.js`),
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
  `animacion_utils.js` (`cerrarConAnimacion()` + `DURACION_CIERRE_MS`) da
  la animación de salida a los 3 popups/pantallas principales (hoja de
  visita, ficha de cliente, catálogo+carrito): marca `state.cerrando`
  (la vista suma la clase `closing`, con la keyframe `-out` que le toca
  en `ruta_shalom.scss`) y recién después del delay llama al cierre real
  -- si no, Owl saca el nodo del DOM al instante y la animación nunca se
  ve. Los 5 overlays custom de la app (`sheet-overlay`, `edit-overlay`,
  `order-overlay`, `confirm-overlay`, `scan-overlay`) tienen animación de
  ENTRADA pareja (fondo con fade, contenido con la curva `cubic-bezier
  (0.32, 0.72, 0, 1)` de iOS -- rápida, sin rebote); de los 5, solo los 3
  de arriba también animan la SALIDA por JS -- `confirm-overlay` (avisos
  chicos de "¿salir sin guardar?") y `scan-overlay` (cámara del
  escáner) se cierran sin ese delay a propósito, porque
  `order_screen.js` ya tenía una advertencia de que `OrderScreen` tiene
  que estar REALMENTE desmontado antes de un `doAction()` que le sigue
  en dos de sus salidas (confirmar pedido, revisar cotización) -- meter
  un delay ahí reintroduciría un bug ya arreglado. `intentarSalir()`/
  `confirmarSalirSinGuardar()` (las salidas donde no hay ningún
  `doAction()` inmediatamente después) sí animan.

  El CIERRE de la hoja de visita en particular NO usa una keyframe
  nueva: reusa el mecanismo que ya existía para el gesto de arrastre
  (`transition: transform 0.2s ease` en `.sheet`, empujando
  `state.arrastreY` hasta abajo del todo en `cerrar()`) -- se probó con
  una keyframe de salida propia y se reportó que se sentía entrecortada
  ("como que se rompe") comparada con el deslizamiento que ya tenía el
  arrastre, así que se volvió a ese mecanismo tal cual estaba. El
  destino de `arrastreY` es `window.innerHeight + 200` (NO el
  `offsetHeight` propio de la hoja, que se probó primero): con hojas de
  contenido corto `offsetHeight` da un número chico y el recorrido se
  sentía "casi no se mueve" -- con el alto de la pantalla como destino,
  el recorrido es siempre grande y notorio sin importar cuánto
  contenido tenga la hoja. Las entradas (`shalom-hoja-in`,
  `shalom-tarjeta-in`, `shalom-pantalla-in`) se hicieron más
  largas/notorias (0.3-0.32s, con más recorrido) que la primera
  versión, que se reportó "casi imperceptible".

  Los emoji de botones/atajos de toda la app (y de los formularios
  nativos de `fsm.order`/el wizard de GPS) se reemplazaron por íconos
  Font Awesome (ya vienen con Odoo, sin assets nuevos) monocromos, cada
  uno con un solo significado fijo -- antes 🧭 y 📍 se usaban para varias
  cosas distintas a la vez (ir a Google Maps, ver el mapa interno,
  capturar GPS, trazar ruta), lo que confundía. Mapeo:
  `fa-location-arrow` = ir a Google Maps (externo); `fa-map-o` = ver
  mapa interno/Mapbox; `fa-crosshairs` = capturar/centrar en mi GPS;
  `fa-map-pin` = trazar ruta aquí (mapa interno); `fa-flag` = meta de
  venta; `fa-map-marker` = ver un punto puntual en un mapa (ya se usaba
  así en el popup de opciones de GPS). El resto (`fa-phone`, `fa-user`,
  `fa-shopping-cart`, `fa-file-text-o`, `fa-camera`, `fa-search`,
  `fa-trash-o`, `fa-gift`, `fa-history`, `fa-pencil`, `fa-long-arrow-up`)
  son swaps 1:1 sin ambigüedad. Fuera de este cambio, a propósito: las
  etiquetas de promo "✅ Tienes.../⏳ Faltan..." que arma
  `fsm_order.py` (`shalom_estado_promociones_carrito`) siguen con emoji
  porque `order_screen.js` matchea ese texto literal
  (`.includes("✅")`) para decidir el color del badge -- cambiarlo es un
  refactor aparte, no un swap de ícono.
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
