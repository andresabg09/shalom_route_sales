# Plan: Modo offline de Ruta Shalom + Registro de cotizaciones en Administración

## Estado: IMPLEMENTADO (fases 0 a 4)

Todo lo de abajo está hecho, con estos cambios respecto al plan original:
- **Fotos de las tarjetas:** `image_512`, no `image_256`, porque las tarjetas
  miden hasta 200 px.
- **Latido del catálogo:** sigue en 1 s con buena señal. El servidor da por
  cerrado un catálogo que pasa 3 s sin latido.
- **Sin endpoints HTTP nuevos para la cola:** son métodos de modelo llamados por
  ORM (`shalom.sync.evento.shalom_procesar_lote` / `shalom_ping`) y
  `fsm.route.schedule.shalom_paquete_offline`.
- **Sin mockup previo:** el usuario pidió hacerlo todo junto. Se usaron las clases
  `adm-*` y las variables `--shalom-*` existentes.

## Context

Los vendedores trabajan en la calle con datos móviles débiles o sin señal. Hoy **casi
todo en la app necesita la red en el momento**. Si no hay señal, la venta se detiene.
Objetivo del usuario: **que la venta nunca se detenga ni se sienta lenta**, sin importar
el internet.

Segundo pedido: en Administración, un **registro de los carritos que se cerraron**,
sobre todo los descartados con "Salir y perder el carrito". Así, si alguien descartó un
pedido grande por accidente, el admin se entera y lo puede restaurar.

Decisiones del usuario (ya respondidas):
- **Qué se registra:** "Salir y perder el carrito". Hoy borra el carrito **sin dejar
  rastro**: `confirmarSalirSinGuardar` → `shalom_limpiar_carrito` →
  `_shalom_limpiar_carrito_borrador`, en `fsm_order.py:1523-1551`.
- **Precio de un pedido tomado sin señal:** el **de la visita**. Si el precio actual es
  distinto, se marca para que oficina lo revise.
- **Confirmar sin señal:** "**Avisar y esperar**". El pedido se guarda en el teléfono y el
  vendedor puede seguir a la próxima parada. Cada pedido pendiente muestra un aviso
  fuerte de "Pendiente de enviar" hasta que haya señal y Odoo lo confirme.
- **Retención del registro:** **una semana** (7 días), con limpieza automática por cron.

### Lo que encontré en el código (diagnóstico)

- **El carrito ya vive en el navegador.** Se guarda en memoria y en `localStorage`
  (30 min). El `sale.order` solo se crea al final:
  - `shalom_confirmar_pedido` en `fsm_order.py:676`
  - `shalom_guardar_borrador_pedido` en `fsm_order.py:516`

  Es una buena base.
- **La app genera mucho tráfico continuo, y con mala señal ese tráfico es lo que la vuelve lenta:**
  - Con el catálogo abierto, cada **1 s**:
    - `shalom_marcar_catalogo_abierto` (escribe en BD)
    - además, `shalom_actualizar_carrito` o `shalom_leer_carrito`

    Ver `order_screen.js:624-698`.
  - Hoja de visita: cada **2 s** (`visit_sheet.js:24`).
  - Detalle de ruta: cada **8 s** (`ruta_detalle.js:49`).
  - Hub: cada **30 s** (`rutas_hub.js:192`).
  - Las llamadas no tienen timeout. El `rpc()` de Odoo 18 no lo trae, y con "señal
    fantasma" una llamada puede quedar colgada indefinidamente.
- **Las fotos del catálogo se piden en `image_1024`** (`order_screen.js:1422-1429`), sin
  `loading="lazy"` ni `unique=`. Son 80 fotos grandes por página. En 3G esto solo ya
  explica gran parte de la lentitud.
- **Las cachés existentes viven solo en memoria:**
  - `CACHE_CATALOGO`, de 15 min
  - `CACHE_RUTAS`, de 10 min

  Se pierden al recargar la página. No hay IndexedDB, service worker ni chequeo de
  conectividad.
- **Escrituras que hoy son directas y fallan sin red:**
  - cambio de etapa de la visita, con `orm.write` y validaciones que pueden lanzar
    `UserError` (`fsm_order.py:1735-1799`)
  - observaciones
  - GPS
  - confirmar pedido
  - revisar cotización (que además abre el formulario nativo de Ventas)

### Límites honestos (coaching)

1. **Abrir la app desde cero sin señal no es realista en Odoo.** Ni el POS de Odoo lo
   hace. La página `/odoo` se arma por sesión (sesión, menús, assets con hash).
   El modelo correcto, igual al del POS de Odoo, es:
   - **abrir la app con señal al inicio del día**;
   - tocar **"Preparar mi día"**;
   - **no cerrar la pestaña**, y desde ahí trabajar offline todo el día.
2. **Instalar la app en la pantalla de inicio (PWA)** es casi obligatorio en iPhone.
   Safari borra los datos de sitios no instalados. Ya se puede, porque Odoo 18 trae
   manifest y service worker propios.
3. **Lo que seguirá necesitando señal:**
   - Mapa Mapbox y navegación paso a paso. Offline se cae a la vista lista.
   - Crear cliente nuevo desde la calle. Es un caso ocasional, se bloquea offline con
     un aviso.
   - "Ver en vivo" entre dos dispositivos.
   - "Revisar cotización" con apertura del formulario nativo de Ventas. Offline se
     guarda como borrador en cola y no abre el formulario.
   - Promociones y estrellas exactas. Offline se muestra "se calculan al enviar", con
     el último estado conocido.
4. **El stock mostrado offline es una foto** de la hora de la descarga. Se muestra
   "stock de hace X h".

---

## Arquitectura recomendada (patrón del POS de Odoo 18)

```
Pantallas ──lee──▶ Almacén local (IndexedDB)  ◀──refresca── Sincronizador ──▶ Odoo
    │                                                    ▲
    └──escribe──▶ Cola de salida (outbox, IndexedDB) ────┘  (lote idempotente por UUID)
```

- **Lectura local primero.** Cada pantalla dibuja **al instante** lo que hay en
  IndexedDB y refresca en segundo plano (stale-while-revalidate).
- **Escritura local primero.** Cada acción del vendedor se guarda primero en la cola
  local con un **UUID generado en el teléfono**, y la pantalla avanza sin esperar.
- **Sincronizador único**, con estas reglas:
  - Un solo envío a la vez (mutex).
  - Timeout de 5 s para el ping y de 15 s para lotes.
  - Reintento exponencial con jitter, de 2 s hasta un tope de 5 min.
  - Se dispara al guardar algo, al volver la conexión (`online`), al volver a la
    pestaña (`visibilitychange`) y cada 30-60 s.
- **En el servidor, idempotencia sin tocar el esquema de `sale.order`:**
  - Se usa una tabla propia nueva, `shalom.sync.evento`, con `uuid` único.
  - Si llega dos veces el mismo UUID, se devuelve el resultado guardado y no se
    duplica el pedido.
  - Cada evento se procesa en su propio savepoint, así que uno con error no tumba a
    los demás.
- **Errores:**
  - Error de red: el evento queda en cola y se reintenta.
  - Error de negocio (`UserError`, ej. falta la nota en Cancelado): el evento queda
    como **"Necesita atención"**, visible para el vendedor y para el admin. **Nunca
    se borra en silencio.**

---

## Fases (cada una es su propio deploy, de menor a mayor riesgo)

### Fase 0 — Velocidad inmediata

Bajo riesgo y alto impacto. Se puede hacer antes que todo lo demás.

- **Fotos del catálogo:** pasar a `image_256` con `?unique=<write_date>` y
  `loading="lazy"`.
  - Archivos: `order_screen.js:1422-1429` y `order_screen.xml:166,263`.
  - El zoom sigue usando `image_1920`, solo bajo demanda.
  - Efecto esperado: de unos 8 MB por página a menos de 1,5 MB, y el navegador
    cachea las fotos de forma inmutable.
- **Timeouts en llamadas:** un helper nuevo `red_utils.js` con
  `llamarConTimeout(promesa, ms)`, que usa `.abort()` del `rpc` de Odoo 18. Se aplica
  a todos los polls.
- **Polls adaptativos con candado de "uno en vuelo":**
  - El tick de 1 s del catálogo pasa a 3 s en reposo; queda en 1 s solo si hay otra
    sesión "Ver en vivo".
  - Si falla, sube con backoff: 5 → 10 → 30 s.
  - Archivos: `order_screen.js:624-698`.
  - El mismo tratamiento va en `visit_sheet.js` (2 s), `ruta_detalle.js` (8 s) y
    `rutas_hub.js` (30 s).
  - Sin señal (`navigator.onLine === false`), los polls se **pausan**.

### Fase 1 — Registro de carritos descartados en Administración

Es lo que pidió directamente. Es independiente del offline.

- **Modelo nuevo `shalom.cotizacion.registro`**, en
  `models/shalom_cotizacion_registro.py`. Campos:
  - `tipo`: `descartado` (ampliable a futuro)
  - `order_id` (visita), `location_id`, `person_id` (vendedor), `user_id`
  - `fecha`
  - `lineas_json`: snapshot completo del carrito, con precio de la visita
  - `cantidad_items`, `total`
  - `restaurado` (bool), `restaurado_por`, `restaurado_en`
  - `uuid` (único; sirve para la Fase 3)
- **Engancharlo antes de borrar.** `shalom_limpiar_carrito` (`fsm_order.py:1542`)
  primero lee `_shalom_carrito_dict()`; si no está vacío, crea el registro con
  `sudo()`, y recién después limpia.
  - El cliente envía además su copia local del carrito como argumento opcional.
  - Así no se pierde aunque el servidor tuviera una copia vieja por mala señal.
- **Aviso al admin:**
  - Si `total >= umbral`, se publica un mensaje en el chatter de la visita y se marca
    con badge en la pestaña nueva.
  - El umbral es el parámetro `shalom.registro_umbral_aviso`, con default **$100**
    (a confirmar).
- **Restaurar** (`shalom_admin_restaurar_registro`, protegido con
  `_shalom_verificar_admin`):
  - Si la visita sigue abierta y su carrito está vacío, devuelve las líneas a
    `x_carrito_borrador`. El vendedor lo ve al reabrir el catálogo.
  - Si no, crea una **cotización en borrador** (`sale.order` draft) para el cliente,
    con los precios del snapshot, y la abre.
- **Cron** `data/cotizacion_registro_cron.xml`: diario, borra registros de más de
  **7 días**.
- **Seguridad:** en `ir.model.access.csv`, solo `fieldservice.group_fsm_manager`. El
  vendedor escribe vía `sudo()`, el mismo patrón que `shalom.ruta.toma`.
- **UI:** pestaña nueva **"Registro"** en `admin_gestion.xml` (líneas 32-53), con estas
  piezas:
  - Clases `adm-*` existentes: `adm-row`, `adm-chip`, `adm-pill`, `adm-actbtn`.
  - El layout copia la pestaña Seguimiento (xml:280-394).
  - Carga diferida en `cambiarTab` (`admin_gestion.js:256`).
  - Filtros por vendedor y por hoy / 7 días.
  - Cada fila: cliente, vendedor, hora, ítems, total. Botones "Ver líneas" y
    "Restaurar".
  - Revisar el ancho de tabs en móvil (`admin_gerente.scss:6`).
- **Mockup en Claude Design antes de codear** (regla de CLAUDE.md), con las variables
  `--shalom-*`.

### Fase 2 — Almacén local + "Preparar mi día" (lectura offline)

- **`static/src/js/ruta_shalom/almacen_local.js`:** wrapper propio de IndexedDB, de unas
  100 líneas, al estilo de `point_of_sale/.../indexed_db.js`. Sin librerías.
  - Stores: `catalogo`, `stock`, `estrategias`, `rutas`, `visitas`, `clientes`,
    `historial`, `formas_pago`, `outbox`, `meta`.
  - Se pide `navigator.storage.persist()`.
  - Se maneja el error conocido de iOS "Connection to Indexed Database server lost":
    se reabre la conexión y, si no se puede, se pide recargar.
- **Endpoint `/shalom/preparar_dia`**, en un controller nuevo
  `controllers/sync.py` (`type='json'`, `auth='user'`). Devuelve en una sola llamada:
  - Las rutas del vendedor: lo de `shalom_mis_rutas_programadas`.
  - Las visitas y clientes de esas rutas: lo de `RutaDetalle.cargar` y
    `VisitSheet.cargar`, más `shalom_perfiles_ruta` y `shalom_ficha_juego`.
  - Catálogo y stock: lo de `searchRead product.product` y
    `shalom_existencias_bodegas`.
  - `shalom_pedidos_anteriores` de cada cliente de la ruta.
  - Formas de pago, y última forma de pago e ITBMS por cliente.
  - Estrategias vigentes.

  Se **reusan** esos métodos existentes; no se reimplementa su lógica.
- **Delta por `write_date`** en `/shalom/delta?desde=…`, con 3 min de solape. El stock va
  en una llamada aparte (no mueve `write_date`), y la lista de ids sirve para detectar
  bajas.
- **Precarga de fotos `image_256` en Cache Storage**, en lotes de 15 y en segundo plano.
  Son unos 700 productos × ~15 KB ≈ 10 MB.
- **Las pantallas leen local primero:**
  - `rutas_hub.js` (reemplaza `CACHE_RUTAS`)
  - `ruta_detalle.js`
  - `visit_sheet.js`
  - `order_screen.js` (reemplaza `CACHE_CATALOGO`)
  - `cotizaciones.js`
- **UI nueva (va al mockup):**
  - Botón **"Preparar mi día"** con barra de progreso.
  - **Indicador de conexión** en el header: "En línea" / "Señal débil" /
    "Sin señal · N por enviar".
  - "Datos de hace X h".

### Fase 3 — Cola de salida (escrituras offline)

Es la fase de mayor riesgo.

- **Modelo `shalom.sync.evento`:** `uuid` (único), `tipo`, `payload_json`, `user_id`,
  `estado` (ok/error), `resultado_json`, `error`, `recibido_en`. Cron de 30 días.
- **Endpoint `/shalom/sync`:**
  - Recibe un lote ordenado y procesa cada evento en un savepoint.
  - Si el UUID ya existe, devuelve el resultado guardado.
  - Tipos de evento y método que llama cada uno:

  | Tipo | Llama a | Detalle |
  |---|---|---|
  | `confirmar_pedido` | `shalom_confirmar_pedido` | Con **precios de la visita**: tras crear las líneas, fija `price_unit` del snapshot. Si difiere del precio vigente, marca `x_precio_revisar` en la visita y deja una nota en el chatter. Las recompensas de lealtad las sigue calculando el servidor. |
  | `guardar_borrador` | `shalom_guardar_borrador_pedido` | Sin devolver acción de ventana. |
  | `cambiar_etapa` | El mismo `write` con el contexto `shalom_validar_cierre_visita` | |
  | `observacion` | | |
  | `gps` | `action_capturar_gps` | |
  | `descartar_carrito` | Fase 1 | Así el registro llega aunque se descarte sin señal. |
- **Cliente, `sincronizador.js`:**
  - Mutex y backoff.
  - Ping a `/shalom/ping` con 5 s de timeout.
  - Marca "señal débil" tras 2 timeouts seguidos.
  - Orden FIFO por cliente.
- **"Avisar y esperar":**
  - Al confirmar sin señal, la visita queda localmente como **"Pendiente de
    enviar"**, con banner fuerte en la hoja y badge en la lista de la ruta.
  - El vendedor puede seguir a la siguiente parada.
  - Al sincronizar, sale el aviso "Pedido de X enviado ✓ +N XP" (el XP real que
    devuelve el servidor).
  - Si da error, la visita queda en "Necesita atención" con el motivo.
- **Pausas sin señal:**
  - Se pausan el heartbeat de "Ver en vivo" y `shalom_marcar_catalogo_abierto`.
  - Las promos y la evaluación muestran el último estado y el texto "se calculan al
    enviar".
- **Bloqueado offline, con aviso:**
  - Crear o editar cliente (`cliente_form.js`)
  - "Examinar cotización" y el historial nativo
  - Navegación Mapbox

### Fase 4 — PWA / instalación (opcional)

- Extender el service worker de Odoo 18 vía `WebManifest._get_service_worker_content()`,
  el mismo mecanismo que usa `mail`, **solo** para una página offline amigable: "Abrí
  la app con señal; tus pedidos están guardados".
- Guía para vendedores:
  - Instalar en la pantalla de inicio.
  - Abrir con señal y tocar "Preparar mi día".
  - No cerrar la app.

---

## Archivos críticos

- **Python nuevos:**
  - `models/shalom_cotizacion_registro.py`
  - `models/shalom_sync_evento.py`
  - `controllers/sync.py`
  - `data/cotizacion_registro_cron.xml`
- **Python modificados:**
  - `models/fsm_order.py`: hook en `shalom_limpiar_carrito`, parámetro opcional de
    precios en `shalom_confirmar_pedido` / `_crear_lineas_pedido` (`:590`), y
    `x_precio_revisar`.
  - `__manifest__.py`: versión, data y assets.
  - `security/ir.model.access.csv`
  - `models/__init__.py`, `controllers/__init__.py`
- **JS nuevos:**
  - `static/src/js/ruta_shalom/red_utils.js`
  - `almacen_local.js`
  - `sincronizador.js`
  - componente `indicador_conexion`, con su XML
- **JS modificados:**
  - `order_screen.js`, `visit_sheet.js`, `ruta_detalle.js`, `rutas_hub.js`,
    `cotizaciones.js`
  - `admin_gestion.js` / `admin_gestion.xml`
  - `ruta_shalom.scss`
- **Reutilizar, no reimplementar:**
  - `shalom_confirmar_pedido`, `shalom_guardar_borrador_pedido`,
    `shalom_pedidos_anteriores`, `shalom_existencias_bodegas`,
    `shalom_mis_rutas_programadas`, `shalom_perfiles_ruta`, `action_capturar_gps`
  - `_shalom_verificar_admin`, `_shalom_vendedor_nombre`
  - `stage_utils.js` (ids de etapa)

## Riesgos de producción (explícitos)

- **Fase 3 crea pedidos reales de forma diferida.** Un bug de idempotencia
  significaría pedidos duplicados. La tabla `shalom.sync.evento` con UUID único lo
  mitiga. **Antes de desplegarla hay que tomar un snapshot del disco de datos en GCP.**
- **El precio de la visita sobrescribe `price_unit`.** Afecta facturas reales. Se
  limita a los pedidos enviados por la cola y se deja marca de revisión.
- **Una validación del servidor (`UserError`) puede llegar horas después.** El vendedor
  tiene que ver el problema; por eso existe el estado "Necesita atención".
- **Tablas nuevas, sin cambios de esquema en `sale.order`.** Riesgo bajo de migración.
- **iOS sin instalar la app:** Safari puede borrar los datos tras 7 días sin uso.
  Mitigación: instalar la app y sincronizar todos los días.

## Verificación

- **Python:**
  - Helpers puros (snapshot, diferencia de precio, retención) en un
    `tools/test_sync_utils.py` nuevo, al estilo de `tools/test_juego_utils.py`.
  - Tests en `tools/odoo_harness`, sobre un Odoo 18 real desechable:
    - descartar → registro → restaurar
    - mismo UUID dos veces → un solo `sale.order`
    - `UserError` → evento en error
    - precio de visita ≠ vigente → marca de revisión
    - cron de 7 días
- **JS:**
  - `tools/owl_check/ejecutar_todo.sh`: compila las plantillas y `clases_css.py`
    verifica las clases `adm-*` nuevas.
  - Escenarios nuevos en `simular.js` con `fake-indexeddb`: catálogo offline,
    confirmar offline → cola → sync, y Registro en admin.
- **XML:** `xml.dom.minidom`.
- **Prueba en vivo del usuario, por fase:**
  - Fase 0: comparar la carga del catálogo con 3G simulado (DevTools → Network →
    Slow 3G).
  - Fase 1: descartar un carrito y verlo en Administración → Registro; restaurarlo.
  - Fases 2-3: con el teléfono en **modo avión**, recorrer ruta → visita → pedido →
    confirmar. Ver "Pendiente de enviar". Quitar el modo avión y ver
    "Enviado ✓ +XP". Verificar en Ventas que hay **un solo** pedido, con los precios
    de la visita.
- **Flujo de deploy, por cada fase (CLAUDE.md):**
  1. Mockup aprobado, si toca UI.
  2. Implementar y validar.
  3. Commit y push a `master`.
  4. `sudo shalom-deploy`.
  5. Si algo falla: `sudo shalom-deploy --rollback`.

## Prompts listos (para pedir cada fase en un chat nuevo)

1. «Implementa la **Fase 0** del plan de offline (fotos `image_256` + lazy, timeouts,
   polls adaptativos con backoff y pausa sin señal). Sin cambios visuales salvo el
   tamaño de foto.»
2. «Implementa la **Fase 1**: registro de carritos descartados (modelo
   `shalom.cotizacion.registro`, hook en `shalom_limpiar_carrito`, aviso si supera $100,
   restaurar, retención 7 días) y la pestaña "Registro" en Administración. Primero el
   mockup en Claude Design.»
3. «Implementa la **Fase 2**: IndexedDB (`almacen_local.js`), `/shalom/preparar_dia`,
   delta, precarga de fotos, pantallas leyendo local primero, indicador de conexión.
   Primero el mockup.»
4. «Implementa la **Fase 3**: outbox con UUID, `/shalom/sync` idempotente
   (`shalom.sync.evento`), precio de la visita con marca de revisión, "Avisar y
   esperar", "Necesita atención". Recuérdame el snapshot del disco antes de
   desplegar.»
