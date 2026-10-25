# Plan de implementación: el juego de ventas sobre Ruta Shalom

> Borrador para aprobación del usuario. No hay código de producción
> escrito todavía. Regla de oro de este plan: **no se reescribe nada que
> ya funciona.** Cada pieza del juego se monta encima de lo que existe,
> en fases chicas, cada una con su `sudo shalom-deploy` y su
> `--rollback`.

Mockup de referencia (Claude Design, navegable):
https://claude.ai/artifact/Ez3gSTXkeiMfcqDSpCCYEa

## 0. Principios

1. **Solo cambia la pestaña Rutas.** El menú inferior real es
   `Rutas · Cotizaciones · Clientes` (`app.xml`). Cotizaciones y
   Clientes no se tocan.
2. **Aditivo, no sustitutivo.** Cada fase agrega capas y deja intacto el
   flujo anterior. Si algo falla, el vendedor puede seguir vendiendo
   como hoy.
3. **Todo con las variables de color de la app** (`--shalom-*` en
   `ruta_shalom.scss`), no con los colores sueltos del mockup. La app ya
   trae tema claro por defecto y selector Claro / Dispositivo / Oscuro:
   el mockup solo mostró el oscuro. Bajo el sol se usa el claro.
4. **Lo que se calcula con ventas históricas se calcula en el servidor y
   se guarda** (tarea programada), no al abrir cada pantalla: son más de
   1,000 clientes.
5. **El repo es público**: nunca se suben datos reales de clientes,
   ventas ni credenciales. Las pruebas usan datos anonimizados.

## 1. Inventario: lo que YA existe y qué hacemos con cada cosa

Leyenda: **MANTENER** (no se toca), **MEJORAR** (se le agrega algo),
**REUSAR** (se usa como base de algo nuevo), **NUEVO**.

### A. Estructura y navegación
| Lo que existe | Dónde | Veredicto |
|---|---|---|
| Shell con menú inferior Rutas / Cotizaciones / Clientes | `app.js`, `app.xml` | **MANTENER** |
| Historial propio del botón Atrás de Android (pila en `history.state` + `sessionStorage`, reconstrucción en cascada) | `back_stack.js` (278 líneas, rediseñado dos veces) | **MANTENER.** Toda pantalla nueva debe registrarse ahí. Es la pieza más delicada de la app. |
| Selector de tema Claro / Dispositivo / Oscuro | `tema_selector.js` | **MANTENER**; el diseño nuevo hereda las variables |
| Animaciones de entrada/salida de hojas | `animacion_utils.js` | **MANTENER** y reusar en las hojas nuevas |

### B. Rutas, mapa y navegación (lo que más te preocupaba perder)
| Lo que existe | Veredicto |
|---|---|
| Pestaña Rutas: lista por periodo y semanas, buscador (`rutas_hub.js`) | **MEJORAR.** Pasa a ser la vista "Lista" de la pantalla nueva. El mapa de rutas se suma como otra vista (interruptor Mapa / Lista). |
| Detalle de ruta con **Lista / Mapa** de clientes (`ruta_detalle.js`, 1,750 líneas) | **MANTENER entero.** Pines numerados por estado, tu punto GPS pulsante, trazado real guardado, paletita direccional hacia el siguiente pendiente, "ir al siguiente pendiente", zoom, centrar en mí. Se le suma encima: etiqueta de cliente (A/A2/B), valor esperado, estrellas y filtro "Mi cartera / Toda la ruta". |
| **Navegación en vivo "Trazar ruta aquí"** estilo Waze: recálculo a 45 m de desvío, llegada a 35 m, cámara que sigue, bloqueo de pantalla apagada (wake lock), línea animada, posición extrapolada | **MANTENER intacto. No se toca.** Es lo más trabajado del módulo. |
| Ir a Waze/Maps externo, llamar al teléfono/celular, `street2` | **MANTENER** |
| Ciclos por ruta (`fsm.route.schedule`): fechas, duración, estado, "Generar próximo ciclo", capacidad | **MANTENER** |
| Reposición automática de ciclos (tarea diaria; cuenta la periodicidad desde que llega la mercancía, con los 4 días hábiles de bodega) | **MANTENER.** Cualquier cosa nueva debe convivir con esta tarea. |
| **Visita Exprés**: una ruta por vendedor con un lote de clientes fuera de ciclo, fechas propias, aparece y desaparece sola | **REUSAR** como una de las dos opciones para las carteras (ver Fase 4) |
| Mapa propio de Administración (`dibujarMapaAdmin`) | **MANTENER** |

### C. Visita y cliente
| Lo que existe | Veredicto |
|---|---|
| Hoja de visita: estados Pendiente / Completado / No quiso / Cancelado, candados si faltan datos del cliente, nota obligatoria al cancelar, capturar GPS, historial, arrastrar para cerrar (`visit_sheet.js`) | **MANTENER**; se le suma la escalera de estrellas y "cómo venderle más" |
| Ficha de cliente completa (RUC, celular, foto del local, ruta, orden, GPS) y alta rápida (`cliente_form.js`, `clientes.js`) | **MANTENER** |
| Cotizaciones (`cotizaciones.js`) | **MANTENER** |
| `x_venta_mas_alta` por cliente (ya es el "récord") y `capacidad` por ciclo | **REUSAR** para las estrellas |

### D. Pedido (catálogo y carrito, `order_screen.js`, 1,603 líneas)
| Lo que existe | Veredicto |
|---|---|
| Catálogo con fotos, categorías, búsqueda, paginación, escáner de código de barras | **MANTENER** |
| Carrito con borrador respaldado en el servidor, varias sesiones a la vez, tarea que limpia carritos viejos | **MANTENER.** La precarga escribe en este mismo carrito, para que el respaldo siga funcionando. |
| Existencia libre y reservados, etiqueta "Quedan N / Disponible N", interruptor "solo con stock" (apagado por defecto: **no bloquea nada**) | **MEJORAR**: las dos bodegas a la vez (Dianke verde, Nevada amarillo) |
| Estado de promos 12+1 por producto | **MANTENER** |
| Recompensas vía el módulo nativo de lealtad (el vendedor elige el producto gratis) | **MANTENER** |
| Pop-up de Forma de pago, ITBMS, fecha especial de entrega | **MANTENER** |
| Aviso (no bloqueante) de datos faltantes del cliente | **MANTENER** |
| "Confirmar pedido" (venta real) y "Revisar cotización" (abre Ventas) | **MANTENER.** Ojo: `OrderScreen` debe estar desmontado antes del `doAction()` que sigue (bug ya arreglado una vez). |
| Precarga, medidor de estrellas, margen del pedido, sugerencias | **NUEVO** (aditivo) |

### E. Administración (`admin_gestion.js`, 1,256 líneas)
| Lo que existe | Veredicto |
|---|---|
| Seguimiento de Visitas, Rutas de mis vendedores con mapa, Visita Exprés, "En vivo" y carritos pendientes | **MANTENER** |
| Asistente "Buscar GPS por nombre" (Google Places, 3 opciones, distancia, cola de clientes sin GPS) y la herramienta `tools/gps_matching` | **REUSAR** para el GPS prioritario: solo se ordena su cola por valor, no se crea otro |
| Pestañas nuevas: Estrategias, reparto de rutas, vista del gerente | **NUEVO** |

### F. Servidor
- Métodos `shalom_*` en `fsm_order.py`, `fsm_person.py`, `fsm_route.py`,
  `fsm_location.py`: **se mantienen sus contratos.** Los cambios
  agregan claves a lo que devuelven, nunca quitan ni renombran.
- Despliegue con `sudo shalom-deploy` (respaldo + verificación + reversa):
  **se mantiene.**
- Hallazgo importante: hoy "quién ve qué" lo decide la **ruta**
  (`fsm.route.fsm_person_id`), no la visita. `shalom_mis_rutas_programadas`
  filtra por el vendedor de la ruta. Eso hace falta cambiarlo para que dos
  vendedores compartan una ruta (Fase 4).

## 2. Lo que se agrega (todo nuevo, pequeño)

| Pieza | Dónde vive |
|---|---|
| Existencias por bodega (Dianke = "My Company", Nevada = "Bodega Greenpeak"), parámetro configurable | método nuevo en `fsm_order.py` |
| Pedidos anteriores de un cliente (por pedido y por producto) | método nuevo |
| Referencias de estrellas por cliente: típico, 75%, récord | método nuevo + campos guardados en `fsm.location` |
| Margen del pedido calculado **en el servidor** (el vendedor no debe ver costos) | método nuevo |
| `shalom.estrategia` (qué ofrecer / qué no, vigencia) | modelo nuevo |
| XP, estrellas y logros (libro de eventos) | modelos nuevos |
| Clase de cliente (A, A2, B, C, D), probabilidad de compra, distribuidora (sí/no) | campos guardados + tarea programada |
| Carteras diarias por vendedor | ver Fase 4 |

## 3. Fases

Cada fase: se entrega, se despliega con un solo comando, la pruebas tú
en vivo con una lista corta, y si algo falla se revierte. Orden de
menor a mayor riesgo y de mayor a menor uso diario.

### Fase 0: preparación y datos (sin tocar el código de la app)
- Yo: congelar un punto de retorno (etiqueta de git), escribir las
  funciones de cálculo (estrellas, clases, reparto de carteras) como
  funciones puras y probarlas con los datos reales, sin tocar Odoo.
- Tú: **tareas de datos** (ver sección 5). Sin ellas la Fase 4 no
  funciona bien.
- Recordatorio: antes de la primera prueba de un cambio grande, snapshot
  del disco de datos en GCP.

### Fase 1: el pedido (la más usada, la menos riesgosa)
Qué ves: al tomar un pedido, cada producto muestra **Dianke en verde y
Nevada en amarillo** a la vez, nada se bloquea; un botón **Precargar de
pedidos anteriores** (un pedido completo, varios, o productos sueltos);
arriba, el total con las **estrellas y el margen** en vivo.
- Se mantiene todo lo de la sección D.
- Se agrega: existencias por bodega, precarga, medidor, margen (servidor).
- Riesgo: `order_screen.js` es grande y delicado → solo cambios aditivos,
  y la precarga usa las funciones que ya existen (`agregarProducto`,
  `cambiarCantidad`) para que el borrador, las promos y las recompensas
  sigan funcionando.
- Reversa: `sudo shalom-deploy --rollback`.

### Fase 2: estrategias (botón flotante + editor tuyo)
Qué ves: un botón flotante arriba a la derecha en Rutas; abre "Qué
empujar hoy" y "No ofrezcas". Tú la cambias cuando quieras desde
Administración.
- Modelo `shalom.estrategia`; pestaña nueva en Administración; el
  catálogo marca "NO OFRECER" (sin bloquear).
- Riesgo bajo: no toca ningún flujo existente.

### Fase 3: estrellas, XP y resultado
Qué ves: al confirmar un pedido, una pantalla de resultado con estrellas
y XP. La ficha muestra la escalera (75% / 100% / récord).
- Se amplía lo que devuelve `shalom_confirmar_pedido` (claves nuevas).
- Ficha de cliente de la hoja de visita: solo se le agrega contenido.
- Riesgo medio: el resultado se muestra *después* de cerrar el catálogo
  (respetar la regla del desmontaje).

### Fase 4: carteras por vendedor (el corazón)
Requisito previo: rutas reasignadas, 28 clientes con ruta, distribuidoras
marcadas.
- **Decisión técnica a confirmar antes de programar** (dos caminos):
  - **A (recomendado):** campos nuevos en la visita (vendedor de la
    cartera, fecha, orden, reserva) y un filtro "Mi cartera / Toda la
    ruta". Los dos ven la misma ruta; el sistema reparte los clientes. No
    se archiva nada.
  - **B:** usar Visita Exprés (un lote por vendedor por día). Ya existe,
    pero **archiva** la visita normal del cliente y chocaría con la tarea
    de reposición de ciclos (visitas duplicadas).
- Cambia `shalom_mis_rutas_programadas`: hoy filtra por el vendedor de la
  ruta; debe incluir las rutas donde tengo clientes en mi cartera.
- Reparto: se cierra por clase de cliente y cercanía (GPS), con valor
  esperado mínimo de $2,000 por vendedor, y reserva por cartera.
- Riesgo alto: toca quién ve qué. Se prueba primero con un solo ciclo.

### Fase 5: mapa de rutas y cartera en el mapa
Qué ves: la pestaña Rutas abre en el mapa para elegir ruta (con el
interruptor Lista / Mapa); dentro de la ruta sigue el mapa de clientes de
siempre, con tu cartera resaltada.
- `RutaDetalle` y la navegación en vivo no se tocan.
- Primera versión sobre el mapa real de Mapbox; el estilo "Mario" se afina
  después (es decoración, no función).

### Fase 6: el juego completo
Tutorial en 3 pasos, equipo cooperativo, logros, temporada, **avisos con 3
días de antelación** (enlace de WhatsApp con el mensaje armado; no hay
integración con WhatsApp), distribuidoras por mensaje y **modo conducción**
(la velocidad sale de la misma lectura de GPS que ya usa la navegación;
interruptor "voy de copiloto").

### Fase 7: Administración y gerente
Reparto de rutas entre vendedores, vista del gerente (pedidos del mes,
margen, oxigenta por cada 100 tintes, salud de datos).

## 4. Riesgos transversales

| Riesgo | Cómo se maneja |
|---|---|
| Atrás de Android | Cada nivel nuevo se registra en `back_stack.js` y se prueba con Atrás real |
| Tarea de reposición de ciclos | Ninguna fase la reemplaza; la Fase 4 se diseña para convivir con ella |
| Bloqueo nativo de `stage_id` a "Completado" | Se sigue usando el contexto `bypass_order_completed_stage` |
| `fsm.location` hereda de `res.partner` | Archivar una ubicación apaga el contacto: no se archiva nada en masa |
| Costos visibles al vendedor | El margen se calcula en el servidor |
| Existencias poco fiables hasta que el proveedor las cargue | Etiqueta "según el sistema" + fecha; nunca bloquear |
| Sin entorno local con los módulos OCA | Cálculos como funciones puras probadas con datos anonimizados; el resto se prueba en producción por fases, con reversa |
| Rendimiento (1,000+ clientes, historial grande) | Clases y referencias guardadas por tarea programada |

## 5. Lo que necesito de ti

**Tareas de datos (en Odoo):**
1. Reasignar las rutas de Milciades a Andrés y Luis (y revisar las visitas
   abiertas que quedaron a su nombre).
2. Asignar ruta a los 28 clientes buenos sin ruta (CSV entregado).
3. Cargar el GPS de los clientes de la lista corta (CSV entregado).
4. Marcar las distribuidoras.
5. Decidir cómo te llega el stock de Dianke y Nevada, y si un pedido de
   Nevada también se envía a Dianke.

**Decisiones:** camino A o B de la Fase 4; premios reales de la
temporada; meta del camión; si el mapa de rutas arranca sobre Mapbox y el
estilo Mario se deja para después.

## 6. Qué recomiendo NO hacer todavía
- Reescribir `RutaDetalle` o la navegación en vivo.
- Tocar Cotizaciones y Clientes.
- Atender rutas sin ventas o clientes dormidos antes de que el piso esté
  asegurado.
- Integrar cobros y entregas en Odoo: se espera a la unificación de empresas.
