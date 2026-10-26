# tools/owl_check

Verificaciones del frontend Owl 2 de Ruta Shalom **sin navegador ni Odoo**.
No modifican el módulo ni tocan producción.

- `ejecutar_todo.sh` - corre todo (instala dependencias en `/tmp/owl_check`,
  baja el `owl.js` real de Odoo 18).
- `compilar_plantillas.js` - compila cada `<t t-name>` de todos los XML con el
  compilador de Owl en modo `dev: true` (errores de expresión, `t-key`
  faltante, modificadores de evento inválidos, etc.).
- `clases_css.py` - clases de los XML sin regla en el CSS compilado y
  variables `--shalom-*` no definidas (ruido de `fa-*` esperado).
- `build_bundle.js` + `stubs/` - empaqueta los componentes con stubs mínimos
  de `@web/*` para poder montarlos en Node.
- `simular.js [escenario...]` - monta OrderScreen, RutasHub, RutaDetalle,
  VisitSheet, AdminGestion y la app completa (Atrás de Android) con jsdom,
  ORM falso y datos sintéticos. Escenarios: `order`, `order_dup_key`,
  `order_sin_juego`, `order_eval_reabrir`, `order_eval_vs_cierre`,
  `order_eval_carrera`, `hub`, `detalle`, `visita`, `admin`, `back`.
  Variables: `OWL_DEV=0` (como Odoo sin `?debug`), `SHALOM_MOD=<ruta>`
  (probar una copia parchada), `PARCHE_MAPA=1`.
  (NO aplicados; `git apply --check` pasa). Validados con `simular.js`.

Límites: jsdom no hace layout (no detecta CSS cortado/solapado), y "Odoo
recarga la app en un Atrás" se modela destruyendo y volviendo a montar
`ShalomRutaApp` (comportamiento documentado en `back_stack.js`).
