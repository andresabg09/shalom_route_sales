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

1. **Fase 1** ✅ COMPLETA: shell de la app (nav inferior) + pestaña
   Rutas (hub con filtro semana/mes) + detalle de ruta (Lista + Mapa
   real con Mapbox GL). La raíz del menú "Servicio de Campo"
   (`fieldservice.root`) redirige directo a Ruta Shalom para
   cualquier rol (decisión de producto: reemplaza el tablero nativo
   como punto de entrada de la app entera, no solo para vendedores).
2. **Fase 2** ✅ COMPLETA: hoja de visita (estado, observaciones,
   acciones rápidas: llamar/Maps/GPS/historial, editar cliente).
3. **Fase 3** ✅ COMPLETA (código commiteado, **todavía sin probar en
   producción** — es la más riesgosa, confirma ventas reales y reserva
   stock, probarla sola antes de sumarle Fase 4 encima): catálogo
   (`orm.searchRead` sobre `product.product`, sin método de backend
   nuevo) + carrito + escaneo de código de barras con `BarcodeDetector`
   nativo + `shalom_confirmar_pedido`. Se abre de pantalla completa
   desde el botón "Tomar pedido" de la hoja de visita.
4. **Fase 4** ⬜ PENDIENTE: pestañas Cotizaciones y Clientes (con alta
   rápida vía `shalom_crear_cliente_rapido`).

Cada fase se entrega, se prueba en producción siguiendo el flujo
documentado en `README.md` ("Cómo desplegar cambios a producción"), y
se commitea/pushea por separado — igual que Fase 0.

## Archivos ya creados (Fases 1 y 2)

- `views/ruta_shalom_action.xml` — `ir.actions.client` +
  `menuitem` + override de la acción de `fieldservice.root`.
- `views/fsm_person_views.xml` — expone `fsm.person.user_id`
  ("Usuario de Odoo (login)") en el formulario de Persona; existía en
  el modelo pero no en la vista nativa (bug nativo encontrado
  durante Fase 1, ver `README.md`).
- `models/fsm_order.py` — `shalom_confirmar_pedido()` ajustado con
  `bypass_order_completed_stage=True` (bug nativo de `fieldservice`,
  ver `README.md`).
- `static/src/js/ruta_shalom/`: `app.js` (shell), `rutas_hub.js`,
  `ruta_detalle.js`, `visit_sheet.js` (hoja de visita, Fase 2),
  `stage_utils.js` (resuelve etapas por nombre, compartido),
  `mapbox_utils.js` (token + parseo de WKT, compartido).
- `static/src/xml/ruta_shalom/`: `app.xml`, `rutas_hub.xml`,
  `ruta_detalle.xml`, `visit_sheet.xml`.
- `static/src/scss/ruta_shalom.scss` — todos los estilos de la app,
  escopeados bajo `.o_shalom_ruta_app`.

## Archivos ya creados (Fase 3)

- `static/src/js/ruta_shalom/order_screen.js` /
  `static/src/xml/ruta_shalom/order_screen.xml` — catálogo (búsqueda +
  aviso de stock bajo con `qty_available`) + carrito + escaneo de
  código de barras (`BarcodeDetector` nativo, `getUserMedia` con
  `facingMode: "environment"`) + confirmar pedido
  (`fsm.order.shalom_confirmar_pedido`). Pantalla completa, con
  confirmación explícita (`window.confirm`) antes de mandar el pedido,
  mismo criterio que `capturarGps()` en `visit_sheet.js`.
- `visit_sheet.js`/`.xml`: botón "Tomar pedido" ahora abre
  `OrderScreen`; `pedidoConfirmado()` recarga la propia tarjeta
  (la visita queda Completada del lado del servidor) y avisa al padre
  (`onCambio`) para refrescar la lista/mapa de la ruta por debajo.
- `ruta_shalom.scss`: estilos de catálogo/carrito/escáner (`.order-overlay`,
  `.product-card`, `.qty-stepper`, `.cart-footer`, `.scan-overlay`, ...).
- `__manifest__.py`: `order_screen.js`/`.xml` agregados a
  `web.assets_backend`; versión `18.0.6.0.0`.

Fase 3 desplegada y probada en producción (`docker exec ... -u shalom_location_map --stop-after-init` limpio, contenedor reiniciado, flujo Tomar pedido → catálogo → carrito → Confirmar pedido probado por el usuario).

## Ronda de feedback post-Fase 3 (probado en producción, decisiones de usuario)

El usuario probó Fase 3 en producción y pidió estos ajustes, ya
implementados (pendiente de desplegar/probar de nuevo):

- **Botón Atrás de Android saltaba hasta el listado de rutas** en vez
  de cerrar solo la ventana abierta (hoja de visita u OrderScreen).
  Causa: no había ningún manejo de `history` -- el navegador hacía su
  Atrás por defecto. Se agregó `nav_historial.js`: cada nivel (rutas →
  ruta-detalle → hoja de visita → catálogo/carrito) empuja un
  `history.pushState` al abrirse y SOLO se cierra con
  `history.back()` (nunca llamando al callback de cierre directo), con
  un único listener de `popstate` global que desapila y cierra el nivel
  de arriba. **Riesgo a validar en producción**: el router propio del
  web client de Odoo 18 también escucha `popstate` para su navegación
  de acciones/breadcrumbs -- no se pudo probar en un dispositivo real
  todavía si interfieren entre sí (ej. que haga falta un Atrás de más,
  o que cierre de más). Probar con cuidado y avisar si el
  comportamiento no es "un Atrás = cierra un nivel".
- **La barrita de arriba de la hoja de visita era decorativa**, sin
  ningún listener: ahora se puede arrastrar hacia abajo (`touchstart`/
  `touchmove`/`touchend` en `visit_sheet.js`) y soltar pasado un umbral
  cierra la hoja (`UMBRAL_ARRASTRE_CIERRE = 90px`).
- **Fotos de producto** en el catálogo (`imagenUrl()`, campo nativo
  `image_128` de `product.product` vía `/web/image/...`). La
  resolución final depende de la foto subida en la ficha del producto
  en Odoo, no de este ancho -- pedido del usuario de subirlas en
  1080×1280px queda como tarea de carga de datos, no de código.
- **Categorías** (`categ_id`, ya existentes en Odoo): chips de
  filtro horizontales arriba del catálogo (`categ-row`/`categ-chip`).
- **Escáner de código de barras**: 1) enganchar la cámara al `<video>`
  necesitaba varios toques en algunos dispositivos -- causa probable,
  un `setTimeout(0)` fijo que no siempre alcanzaba a esperar el render
  de Owl; se reemplazó por un `useEffect` que engancha el stream recién
  cuando el `<video>` ya existe en el DOM. 2) el botón "Cancelar" se
  veía desplazado -- `.btn` trae `flex: 1` (pensado para pares de
  botones lado a lado en el modal de editar cliente) que, siendo hijo
  suelto de un contenedor flex en columna, lo estiraba; se corrigió con
  `flex: 0 0 auto` específico para `.scan-cancel`.
- **El carrito no crea ninguna cotización mientras se navega el
  catálogo** (confirmado como comportamiento deseado por el usuario --
  nada se guarda hasta tocar Confirmar pedido o Revisar cotización, así
  un toque accidental del cliente no ensucia Ventas con cotizaciones
  vacías).
- **Nuevo botón "Revisar cotización"** en el carrito, antes de
  confirmar: guarda las líneas como cotización en BORRADOR
  (`fsm.order.shalom_guardar_borrador_pedido`, nuevo método, sin
  `action_confirm` ni cierre de visita) y abre esa `sale.order` nativa
  para que el vendedor ajuste precios/promociones/descuentos ahí (esa
  funcionalidad ya existe en Ventas, decisión de producto: no
  duplicarla en el carrito). Una vez que la visita tiene una cotización
  vinculada (`sale_id`), el CTA de la hoja de visita cambia de "🛒 Tomar
  pedido" a "📋 Examinar cotización" (reusa `action_crear_cotizacion`,
  que ya sabe abrir la existente en vez de crear una nueva).

Archivos nuevos de esta ronda: `nav_historial.js`, `action_utils.js`
(normaliza acciones `ir.actions.act_window` devueltas por Python para
`action.doAction()`, antes duplicado en 2-3 lugares).

## Segunda ronda de feedback (después de probar la primera en producción)

El usuario probó la primera ronda y confirmó que la barrita de arrastre
ya cerraba la hoja, PERO además saltaba hasta el listado de rutas
(mismo síntoma reportado también al volver atrás desde el carrito).
Causa real encontrada: un solo gesto de arrastre podía disparar
`cerrar()` dos veces -- una desde `touchend`, y otra desde el click
"fantasma" sintético que el navegador dispara sobre el backdrop
(`sheet-overlay`, que tiene `t-on-click.self="cerrar"`) después de un
touch. Cada llamada a `cerrar()` hacía un `history.back()` completo,
así que un solo gesto consumía DOS niveles de `nav_historial` en vez de
uno. Arreglado con: `ev.preventDefault()` en el `touchend` cuando el
arrastre cierra, más (como respaldo real, por si el navegador ignora
el preventDefault) una guarda de idempotencia (`this._cerrando`/
`this._cerrado`) en `cerrar()` de `visit_sheet.js` y en
`cerrarDeVerdad()` de `order_screen.js` -- una segunda invocación no
vuelve a tocar el historial.

Otros pedidos de esta ronda, ya implementados:

- **Fotos**: `image_128` → `image_1024` (un escalón abajo del
  original, mejor resolución sin pesar tanto en datos móviles/
  satelitales); tamaño en pantalla 120×180px (`.product-thumb-wrap`).
  Fallback con ícono 📦 si la imagen no carga (`onImagenError`, oculta
  el `<img>` roto en vez de mostrar el ícono roto del navegador).
  También se agregó la foto a las líneas del carrito (más chica,
  56×84px, mismo recorte 2:3).
- **Nombres cortados**: tanto el nombre del cliente en la lista de
  paradas (`stop-info .name`, sin abrir la hoja) como el del producto
  en catálogo/carrito ahora pasan a una segunda línea en vez de
  truncar con "…".
- **Categorías**: de una fila de chips a desplegar horizontalmente, a
  un solo botón (`categ-selector-btn`) que abre un panel con buscador
  de texto (`categ-menu-search`) y la lista filtrada. Al lado, un
  toggle "Solo con stock" (`state.soloConStock`, default apagado =
  muestra todo, igual que antes) que filtra por `qty_available > 0`.
- **Botones del carrito**: "Revisar cotización" (sigue siendo la
  opción principal hacia Ventas) ahora con su propio estilo más chico
  en vez del bloque grande; "Confirmar pedido" sin el emoji ✅.
- **Botón X eliminado**: el header de OrderScreen ya no tiene un botón
  de "cerrar todo" separado -- solo queda "←", que en el carrito vuelve
  al catálogo (no pierde nada) y en el catálogo intenta salir de la
  pantalla completa (mismo camino que el Atrás de Android, vía
  `cerrarNivel()`).
- **Aviso propio al perder el carrito**: si hay productos sin guardar
  como cotización y se intenta salir de OrderScreen (por el botón "←"
  o por el Atrás de Android), no cierra directo -- muestra un modal
  propio (`.confirm-overlay`/`.confirm-card`, no `window.confirm()`)
  y solo cierra si el vendedor confirma "Salir y perder el carrito".
  Implementado re-empujando un nivel de `nav_historial` cuando se
  intercepta el intento de cierre (`alIntentarCerrarPorHistorial()`),
  para no dejar la profundidad del historial del navegador
  desbalanceada si el vendedor cancela.

**Todavía sin confirmar por el usuario en un dispositivo real**: si el
fix de idempotencia resuelve del todo el comportamiento del botón
Atrás (tanto el de Android como el de la hoja/carrito) -- probar de
nuevo con atención después de desplegar esta ronda.

## Bug crítico encontrado al probar la 2da ronda: rompía el CSS de TODO el backend

Al desplegar, apareció "Error de estilo: no se pudo realizar la
compilación de estilos" en TODA la interfaz de Odoo (no solo Ruta
Shalom) -- el banner de abajo decía "using an old style to render this
page". Causa: `width: min(320px, 86vw);` en `.categ-menu`. El
compilador de Sass que usa Odoo interpreta `min()`/`max()` como sus
propias funciones (no como funciones CSS nativas de paso directo), y
al mezclar unidades incompatibles para evaluar en tiempo de
compilación (`px` y `vw`) tira error y rompe la compilación de **todo**
el bundle `web.assets_backend` -- de ahí que se viera roto hasta el
listado de Rutas, que no tiene nada que ver con este cambio. Localmente
compilaba bien con `dart-sass` (versión más nueva/permisiva) -- por
eso no se detectó antes de desplegar. Arreglado reemplazando por
`width: 320px; max-width: 86vw;` (mismo efecto visual, sin función
`min()`). **Lección para no repetir**: no usar `min()`/`max()`/`clamp()`
en este SCSS, aunque compilen bien en local.

Aprovechando el mismo despliegue, se sacó el ícono de respaldo 📦 del
catálogo/carrito (pedido explícito del usuario -- `/web/image/...` ya
devuelve el placeholder propio de Odoo cuando el producto no tiene
foto, igual que el catálogo nativo de Ventas; el ícono propio solo
sumaba confusión) y el toggle "Solo con stock" pasó de checkbox a un
botón completo que se ilumina/opaca al tocarlo (`stock-toggle-btn`).

## nav_historial se sacó por completo: chocaba con el router de Odoo

El usuario reportó que, después del hotfix del CSS, el botón Atrás
seguía sin respetar el nivel (siempre terminaba en el listado de
Rutas, sin importar desde dónde) Y ADEMÁS "Revisar cotización" creaba
bien el borrador pero nunca redirigía al formulario de la cotización.
Los dos síntomas tenían la misma causa: el mecanismo de
`history.pushState`/`popstate` (`nav_historial.js`) que se armó para
que el botón Atrás de Android cerrara un nivel a la vez choca con el
router propio del web client de Odoo 18, que también reacciona a
`popstate` -- cualquier `history.back()` disparado por esta app
interfería con la navegación de Odoo (el caso de "Revisar cotización"
lo probó de forma contundente: el `history.back()` antes del
`action.doAction()` se comía esa navegación).

**Se sacó `nav_historial.js` por completo** (archivo borrado, sin
referencias en ningún componente ni en el manifest). El cierre de la
hoja de visita y de OrderScreen ahora es 100% estado interno de Owl
(`props.onCerrar()` directo), sin tocar el historial del navegador en
absoluto -- eso hace que el botón "←" del header, el backdrop y la
barrita de arrastre sean confiables y den la continuidad que pidió el
usuario (ruta → clientes → cliente → catálogo → volver por el mismo
camino, sin saltar a Rutas). El costo aceptado: el botón/gesto físico
Atrás de Android ya no se intenta interceptar -- queda con el
comportamiento por defecto del web client de Odoo (igual que cualquier
otra pantalla nativa), en vez de romper la navegación de toda la app
como pasaba antes.

También se corrigió el layout de las tarjetas de producto/carrito: los
controles (Agregar/stepper, subtotal/quitar) pasaron de ser hermanos
de la columna de texto a vivir DENTRO de ella, apilados debajo del
nombre -- antes lo apretaban tanto que los nombres largos partían
letra por letra ("sopa de letras", reportado). La foto del carrito
ahora es 120x180px, igual que en el catálogo (antes era más chica).
