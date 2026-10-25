"""Pruebas de las reglas del juego (funciones puras), sin Odoo.

    python3 tools/test_juego_utils.py

Los números de Carnes Primium son los de los pedidos reales usados en el
prototipo aprobado (típico $4,064, bronce $3,048, récord $4,396).
"""
import importlib.util
import pathlib
import unittest

ruta = pathlib.Path(__file__).resolve().parent.parent / "shalom_location_map/models/juego_utils.py"
spec = importlib.util.spec_from_file_location("juego_utils", ruta)
j = importlib.util.module_from_spec(spec)
spec.loader.exec_module(j)

PRIMIUM = [4395.89, 3438.88, 4042.32, 198.0, 4378.38, 52.8]


class TestJuego(unittest.TestCase):
    def test_referencias_primium(self):
        r = j.referencias_estrellas(PRIMIUM)
        self.assertEqual(r["n"], 6)
        self.assertAlmostEqual(r["record"], 4395.89)
        self.assertAlmostEqual(r["tipico"], 4063.87, places=2)
        self.assertAlmostEqual(r["t75"], 3047.90, places=2)

    def test_sin_historial(self):
        r = j.referencias_estrellas([])
        self.assertEqual(r["n"], 0)
        self.assertEqual(j.estrellas(500, r, 30), 0)
        self.assertIsNone(j.siguiente_objetivo(500, r, 30))

    def test_estrellas(self):
        r = j.referencias_estrellas(PRIMIUM)
        self.assertEqual(j.estrellas(2000, r, 25), 0)
        self.assertEqual(j.estrellas(3100, r, 25), 1)
        self.assertEqual(j.estrellas(4378, r, 22), 2)
        self.assertEqual(j.estrellas(4500, r, 22), 3)
        # supera el récord pero con margen bajo: el oro no cuenta
        self.assertEqual(j.estrellas(4500, r, 15), 2)

    def test_siguiente(self):
        r = j.referencias_estrellas(PRIMIUM)
        s = j.siguiente_objetivo(4378, r, 22)
        self.assertEqual(s["estrellas"], 3)
        self.assertAlmostEqual(s["faltan"], 18.0, places=0)
        s = j.siguiente_objetivo(4500, r, 10)
        self.assertTrue(s["margen_bajo"])
        self.assertIsNone(j.siguiente_objetivo(5000, r, 30))

    def test_un_solo_pedido(self):
        r = j.referencias_estrellas([1000])
        self.assertEqual(j.estrellas(1000, r, 30), 2)
        self.assertEqual(j.estrellas(1001, r, 30), 3)

    def test_clase(self):
        self.assertEqual(j.clasificar(0, 0, 0, 0), "NUEVO")
        self.assertEqual(j.clasificar(5, 900, 25, 40), "A")
        self.assertEqual(j.clasificar(5, 900, 15, 40), "A2")
        self.assertEqual(j.clasificar(5, 90, 25, 40), "B")
        self.assertEqual(j.clasificar(5, 90, 10, 40), "B2")
        self.assertEqual(j.clasificar(5, 900, 25, 200), "C")

    def test_valor_esperado(self):
        self.assertAlmostEqual(j.valor_esperado("A", 1000), 810.0)
        self.assertAlmostEqual(j.valor_esperado("C", 1000), 140.0)

    def test_xp_y_nivel(self):
        # utilidad $900, plata, día 3 -> 900*1.5 + 60
        self.assertEqual(j.xp_pedido(900, 2, 3), 1410)
        self.assertEqual(j.xp_pedido(900, 2, 20), 960)
        self.assertEqual(j.xp_pedido(-50, 0, 20), 0)
        self.assertEqual(j.nivel_de_xp(0)[0], 1)
        self.assertEqual(j.nivel_de_xp(600)[0], 2)
        self.assertEqual(j.nivel_de_xp(999999)[3], None)


def _clientes(n, esperado=500.0, clase="A"):
    return [{"id": i, "orden": i, "clase": clase, "esperado": esperado} for i in range(1, n + 1)]


class TestCarteras(unittest.TestCase):
    def test_dos_vendedores_no_comparten(self):
        # 20 clientes de $500 = $10,000: alcanza para 2 vendedores
        cands = [
            {"id": i, "orden": i, "clase": "A" if i % 2 else "B", "esperado": 1000.0 if i % 2 else 150.0}
            for i in range(1, 25)
        ]
        carteras = j.repartir_carteras(cands, 2, minimo=2000, reserva_n=2)
        vistos = []
        for c in carteras:
            vistos += c["items"] + c["reservas"]
        self.assertEqual(len(vistos), len(set(vistos)))
        self.assertEqual({c["persona"] for c in carteras}, {0, 1})
        for c in carteras[:-1]:
            self.assertGreaterEqual(c["esperado"], 2000)
            self.assertTrue(c["completo"])
        # los dos turnos del día 0 son vecinos en la ruta
        self.assertEqual(carteras[0]["dia"], 0)
        self.assertEqual(carteras[1]["dia"], 0)
        self.assertEqual(max(carteras[0]["items"] + carteras[0]["reservas"]) + 1,
                         min(carteras[1]["items"] + carteras[1]["reservas"]))
        # llegan al mínimo SIN contar la reserva, y la reserva son los de menor valor
        self.assertTrue(all(c["completo"] for c in carteras))
        self.assertTrue(any(c["reservas"] for c in carteras))
        for c in carteras:
            for r in c["reservas"]:
                self.assertEqual(r % 2, 0)  # los B de $150

    def test_ruta_chica_usa_un_solo_vendedor(self):
        # $2,500 en total: no alcanza para dos carteras de $2,000
        carteras = j.repartir_carteras(_clientes(5), 2, minimo=2000, reserva_n=0)
        self.assertEqual({c["persona"] for c in carteras}, {0})

    def test_orden_a_antes_que_b(self):
        cands = [
            {"id": 1, "orden": 1, "clase": "B", "esperado": 1000},
            {"id": 2, "orden": 2, "clase": "A", "esperado": 1000},
            {"id": 3, "orden": 3, "clase": "A2", "esperado": 1000},
        ]
        c = j.repartir_carteras(cands, 1, minimo=2500, reserva_n=0)[0]
        self.assertEqual(c["items"], [2, 3, 1])

    def test_dormidos_y_nuevos_fuera(self):
        cands = _clientes(3, 1000) + [
            {"id": 9, "orden": 9, "clase": "C", "esperado": 140},
            {"id": 10, "orden": 10, "clase": "NUEVO", "esperado": 0},
        ]
        todos = [i for c in j.repartir_carteras(cands, 1, 2000, 0) for i in c["items"] + c["reservas"]]
        self.assertNotIn(9, todos)
        self.assertNotIn(10, todos)

    def test_reparto_parejo(self):
        # $5,000 y 2 vendedores: dos carteras de ~$2,500, ninguna bajo $2,000
        carteras = j.repartir_carteras(_clientes(10), 2, minimo=2000, reserva_n=0)
        self.assertEqual(len(carteras), 2)
        self.assertTrue(all(c["esperado"] >= 2000 for c in carteras))

    def test_reserva_no_baja_del_minimo(self):
        # 4 clientes de $500 = $2,000 justos: no se puede sacar reserva
        c = j.repartir_carteras(_clientes(4), 1, minimo=2000, reserva_n=3)[0]
        self.assertEqual(c["reservas"], [])
        self.assertTrue(c["completo"])

    def test_poco_valor_queda_incompleta(self):
        c = j.repartir_carteras(_clientes(2), 1, minimo=2000, reserva_n=0)[0]
        self.assertFalse(c["completo"])

    def test_vacio(self):
        self.assertEqual(j.repartir_carteras([], 2), [])


if __name__ == "__main__":
    unittest.main()
