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


if __name__ == "__main__":
    unittest.main()
