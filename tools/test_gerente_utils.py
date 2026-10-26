"""Pruebas de los cálculos de la vista del gerente (funciones puras), sin Odoo.

    python3 tools/test_gerente_utils.py
"""
import importlib
import pathlib
import sys
import types
import unittest
from datetime import date

modelos = pathlib.Path(__file__).resolve().parent.parent / "shalom_location_map/models"
# gerente_utils importa juego_utils con un import relativo: se carga como
# parte de un paquete mínimo (sin pasar por el __init__ del módulo, que
# necesita Odoo).
paquete = types.ModuleType("shalom_models")
paquete.__path__ = [str(modelos)]
sys.modules["shalom_models"] = paquete
g = importlib.import_module("shalom_models.gerente_utils")


class TestProductos(unittest.TestCase):
    def test_clasifica_por_nombre(self):
        self.assertEqual(g.clasificar_producto("Tinte Rubio 8.0"), "tinte")
        self.assertEqual(g.clasificar_producto("TINTE NEGRO"), "tinte")
        self.assertEqual(g.clasificar_producto("Oxigenta 20 vol"), "oxigenta")
        self.assertEqual(g.clasificar_producto("OXIGENTA 30 VOL"), "oxigenta")
        self.assertEqual(g.clasificar_producto("Oxigentá crema"), "oxigenta")
        self.assertIsNone(g.clasificar_producto("Shampoo"))
        self.assertIsNone(g.clasificar_producto(""))
        self.assertIsNone(g.clasificar_producto(None))

    def test_kit_cuenta_como_oxigenta(self):
        self.assertEqual(g.clasificar_producto("Kit tinte + oxigenta"), "oxigenta")

    def test_oxigenta_por_100_tintes(self):
        pedidos = [
            [("Tinte 1", 100), ("Oxigenta 20", 16)],
            [("Tinte 2", 100), ("Shampoo", 50)],
        ]
        r = g.oxigenta_por_100_tintes(pedidos)
        self.assertEqual(r["tintes"], 200)
        self.assertEqual(r["oxigenta"], 16)
        self.assertEqual(r["por_100"], 8.0)
        self.assertEqual(r["pedidos_con_oxigenta"], 1)
        # mirando solo el pedido que la lleva: 16 por 100 tintes
        self.assertEqual(r["por_100_en_pedidos_con_oxigenta"], 16.0)

    def test_sin_tintes_no_hay_razon(self):
        r = g.oxigenta_por_100_tintes([[("Oxigenta", 5)], [("Shampoo", 2)]])
        self.assertIsNone(r["por_100"])
        self.assertIsNone(r["por_100_en_pedidos_con_oxigenta"])
        self.assertEqual(r["pedidos_con_oxigenta"], 1)
        r = g.oxigenta_por_100_tintes([])
        self.assertEqual((r["tintes"], r["oxigenta"], r["por_100"]), (0, 0, None))

    def test_numero_decimal(self):
        # 33 oxigentas por cada 100 tintes, con pedidos mezclados
        r = g.oxigenta_por_100_tintes([[("Tinte", 30), ("Oxigenta", 10)], [("Tinte", 70)]])
        self.assertEqual(r["por_100"], 10.0)
        r = g.oxigenta_por_100_tintes([[("Tinte", 3), ("Oxigenta", 1)]])
        self.assertEqual(r["por_100"], 33.3)


class TestMes(unittest.TestCase):
    def test_limites(self):
        self.assertEqual(g.limites_mes(date(2026, 10, 26)), (date(2026, 10, 1), date(2026, 11, 1)))
        self.assertEqual(g.limites_mes(date(2026, 12, 31)), (date(2026, 12, 1), date(2027, 1, 1)))
        self.assertEqual(g.limites_mes(date(2026, 2, 1)), (date(2026, 2, 1), date(2026, 3, 1)))

    def test_avance(self):
        a = g.avance_mes(41900, 60000, 80000)
        self.assertEqual(a["pct_piso"], 69.8)
        self.assertEqual(a["pct_meta"], 52.4)
        self.assertEqual(a["falta_piso"], 18100)
        self.assertEqual(a["falta_meta"], 38100)
        # ya pasó el piso: falta 0 y el % pasa de 100
        a = g.avance_mes(65000, 60000, 80000)
        self.assertEqual(a["falta_piso"], 0)
        self.assertGreater(a["pct_piso"], 100)
        # sin meta configurada no hay % (no divide por cero)
        self.assertIsNone(g.avance_mes(100, 0, 0)["pct_piso"])

    def test_margen(self):
        self.assertEqual(g.margen_pct(202, 1000), 20.2)
        self.assertIsNone(g.margen_pct(5, 0))
        self.assertEqual(g.margen_pct(-50, 1000), -5.0)

    def test_parametro(self):
        self.assertEqual(g.parametro_numero("75000", 60000), 75000.0)
        self.assertEqual(g.parametro_numero("75,000.50", 60000), 75000.5)
        self.assertEqual(g.parametro_numero(False, 60000), 60000.0)
        self.assertEqual(g.parametro_numero("", 60000), 60000.0)
        self.assertEqual(g.parametro_numero("abc", 80000), 80000.0)
        self.assertEqual(g.parametro_numero("-5", 80000), 80000.0)
        self.assertEqual(g.parametro_numero(None, 80000), 80000.0)


class TestReparto(unittest.TestCase):
    def rutas(self):
        return [
            {"id": 1, "name": "Darién", "person_id": 10, "person_name": "Andrés", "valor": 6000, "clientes": 5, "dias_ciclo": 7},
            {"id": 2, "name": "Colón", "person_id": 10, "person_name": "Andrés", "valor": 19300, "clientes": 20, "dias_ciclo": 3},
            {"id": 3, "name": "Chorrera", "person_id": 11, "person_name": "Luis", "valor": 27100, "clientes": 30, "dias_ciclo": 7},
            {"id": 4, "name": "Sin dueño", "person_id": False, "person_name": "", "valor": 800, "clientes": 2, "dias_ciclo": 7},
            {"id": 5, "name": "Sin ventas", "person_id": 11, "person_name": "Luis", "valor": 0, "clientes": 0, "dias_ciclo": 7},
        ]

    def test_dias_estimados(self):
        self.assertEqual(g.dias_estimados(25300), 12.7)
        self.assertEqual(g.dias_estimados(27100), 13.6)
        self.assertEqual(g.dias_estimados(0), 0.0)
        self.assertEqual(g.dias_estimados(1000, 500), 2.0)
        self.assertEqual(g.dias_estimados(1000, 0), 0.0)

    def test_por_vendedor(self):
        r = g.armar_reparto(self.rutas())
        v = {x["persona_nombre"]: x for x in r["vendedores"]}
        self.assertEqual(list(v), ["Andrés", "Luis"])
        self.assertEqual(v["Andrés"]["valor_mes"], 25300)
        self.assertEqual(v["Andrés"]["dias"], 12.7)
        self.assertEqual(v["Andrés"]["clientes"], 25)
        self.assertEqual(v["Andrés"]["dias_ciclo"], 10)
        # las rutas de cada vendedor salen de mayor a menor valor
        self.assertEqual([x["name"] for x in v["Andrés"]["rutas"]], ["Colón", "Darién"])
        self.assertEqual(v["Luis"]["valor_mes"], 27100)
        self.assertEqual(v["Luis"]["dias"], 13.6)
        self.assertEqual(r["total_mes"], 52400)

    def test_sin_dueno_o_sin_ventas(self):
        r = g.armar_reparto(self.rutas())
        motivos = {x["name"]: x["motivo"] for x in r["sin_dueno_o_ventas"]}
        self.assertEqual(motivos, {"Sin dueño": "sin_dueno", "Sin ventas": "sin_ventas"})
        # la ruta sin ventas de Luis no suma a su valor ni a sus rutas
        luis = [x for x in r["vendedores"] if x["persona_nombre"] == "Luis"][0]
        self.assertEqual([x["name"] for x in luis["rutas"]], ["Chorrera"])
        # y conserva quién es su dueño para mostrarlo
        self.assertEqual([x for x in r["sin_dueno_o_ventas"] if x["name"] == "Sin ventas"][0]["persona_nombre"], "Luis")

    def test_vacio(self):
        r = g.armar_reparto([])
        self.assertEqual(r, {"vendedores": [], "sin_dueno_o_ventas": [], "total_mes": 0})


class TestGps(unittest.TestCase):
    def test_cobertura(self):
        # 30 clientes de $100 y 70 de $10: los 30 primeros cubren 3000 de 3700
        valores = [100] * 30 + [10] * 70
        self.assertEqual(g.cobertura_primeros(valores, 30), 81.1)
        self.assertEqual(g.cobertura_primeros(valores, 1000), 100.0)
        self.assertEqual(g.cobertura_primeros([], 30), 0.0)
        self.assertEqual(g.cobertura_primeros([0, 0], 30), 0.0)

    def test_orden(self):
        filas = [
            {"id": 1, "name": "b", "valor": 100.0},
            {"id": 2, "name": "A", "valor": 100.0},
            {"id": 3, "name": "c", "valor": 500.0},
            {"id": 4, "name": "d", "valor": 5.0},
        ]
        self.assertEqual([f["id"] for f in g.ordenar_gps_prioritario(filas)], [3, 2, 1, 4])
        self.assertEqual([f["id"] for f in g.ordenar_gps_prioritario(filas, 2)], [3, 2])

    def test_cliente_bueno(self):
        for clase in ("A", "A2", "B", "B2"):
            self.assertTrue(g.es_cliente_bueno(clase), clase)
        for clase in ("C", "NUEVO", "", None):
            self.assertFalse(g.es_cliente_bueno(clase), clase)


if __name__ == "__main__":
    unittest.main()
