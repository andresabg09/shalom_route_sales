# Arnés de pruebas con un Odoo 18 real (desechable)

Prueba el código **servidor** de `shalom_location_map` (métodos `shalom_*`,
juego, estrategias, carteras) dentro de un Odoo 18 de verdad, con datos
sintéticos. No toca producción ni usa credenciales (`ODOO_URL`, etc.).

    sudo tools/odoo_harness/run.sh              # prueba el árbol de trabajo
    sudo tools/odoo_harness/run.sh --limpiar    # reconstruye todo desde cero
    sudo tools/odoo_harness/run.sh --ref 502d9e8        # una revisión de git
    sudo tools/odoo_harness/run.sh --desde 502d9e8      # prueba de ACTUALIZACIÓN
    sudo tools/odoo_harness/run.sh --tags /shalom_harness_tests:TestCarteras

Primera corrida: ~5-10 min (clona Odoo y OCA/field-service 18.0 en
`/tmp/odoo_test`, crea un venv python3.12 y un PostgreSQL propio en el
puerto 5433 con el usuario `pgtest`). Las siguientes: ~3 min.

## Qué hay

- `stubs/` — `base_geoengine`, `fieldservice_geoengine` (necesitan PostGIS) y
  `stock_picking_sale_buttons` (módulo privado del cliente) reemplazados por
  stubs mínimos. El último aporta a `sale.order` los campos `custom_*`, el
  `PAYMENT_METHOD_SELECTION` y que `action_confirm` respete
  `skip_payment_method_check`.
- `sync_modulo.py` — copia fiel del módulo (verifica sha256 de cada `.py`/`.xml`)
  con el `__manifest__` recortado (sin las vistas geoengine ni `assets`). El
  código bajo prueba nunca se edita a mano.
- `tests_addon/shalom_harness_tests/` — los tests (`TransactionCase`, se
  revierten solos). Escenario en `tests/common.py`: 2 almacenes (`WH` y
  `ALBRK` de otra compañía), 5 vendedores/gerente, ruta de 20 clientes con
  ventas para todas las clases, ciclo con visitas abiertas.
- `scripts/sembrar_duplicados.py` — datos para la prueba de actualización.

Los tests corren como el **vendedor** (no admin) y como gerente.
`test_60` compara `shalom_mis_rutas_programadas` contra la versión previa
extraída de git (`119863d^`).

## Notas

- `fieldservice_sale` se agrega solo en el módulo de tests: el módulo usa
  `fsm.order.sale_id` (que viene de `fieldservice_sale`) sin declararlo en su
  manifest; en producción sí está instalado.
- Los tests marcados `INFO`/`H-n` solo escriben en el log (decisiones de
  negocio o hallazgos de baja severidad), no fallan.
- Contra una revisión anterior a las correcciones de la auditoría
  (`--ref 502d9e8`) fallan 18 tests: es esperado y demuestra que detectan
  los problemas corregidos.
