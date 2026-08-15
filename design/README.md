# Prototipos de diseño (mockups)

Esta carpeta guarda prototipos visuales del rediseño de UX para
`shalom_location_map`, hechos como exploración **antes** de escribir
código real contra Odoo. Ver el objetivo del proyecto y las reglas de
trabajo en `../CLAUDE.md`.

## `ruta-shalom-mockup.html`

Prototipo interactivo (HTML/CSS/JS autocontenido, sin dependencias) de
la app móvil/tablet para vendedores de ruta. Abrilo directo en un
navegador para probarlo.

También está publicado como Claude Artifact (vive fuera de este repo,
mismo contenido):
https://claude.ai/code/artifact/b05b9d84-98f2-4328-892e-e27d18c9ed2d

Pantallas cubiertas: Rutas (búsqueda + filtro de período semana/mes),
detalle de ruta (Lista/Mapa con navegación al cliente elegido por el
vendedor), Cotizaciones (con búsqueda), Clientes (directorio + alta
rápida). Decisiones de diseño confirmadas hasta ahora:

- 4 estados de visita: Pendiente / Completada / No quiso / Cancelado.
- El vendedor elige a qué cliente navegar (no es secuencial forzado).
  "Saltar cliente" no debe tocar `x_orden_ruta` (permanente) — necesita
  un concepto nuevo de "orden del día".
- Catálogo de productos: abrir el catálogo NO crea una cotización;
  recién se crea al agregar el primer producto ("sin compromiso"), con
  botón para ir directo a la cotización completa de Odoo y botón de
  escanear código de barras para consultar stock sin salir del módulo.
- Capacidad de ruta = valor total estimado de TODA la ruta (suma de
  últimas facturas de sus clientes), no promedio por cliente.

**Importante**: este archivo es solo un mockup de front-end con datos de
ejemplo hardcodeados — no está conectado a Odoo, no reemplaza ninguna
vista real, y no debe instalarse ni referenciarse desde
`shalom_location_map/`. Sirve como referencia visual para cuando se
planifique la implementación real (vistas/widgets Owl).
