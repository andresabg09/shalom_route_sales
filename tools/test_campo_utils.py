"""Pruebas de las reglas de campo (avisos por WhatsApp, teléfonos): funciones
puras, sin Odoo.

    python3 tools/test_campo_utils.py
"""
import importlib.util
import pathlib
import unittest
from datetime import date

ruta = pathlib.Path(__file__).resolve().parent.parent / "shalom_location_map/models/campo_utils.py"
spec = importlib.util.spec_from_file_location("campo_utils", ruta)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class TestTelefonos(unittest.TestCase):
    def test_ocho_digitos_locales(self):
        self.assertEqual(c.normalizar_telefono("66781234"), "50766781234")
        self.assertEqual(c.normalizar_telefono("233-4455"), "")  # 7 dígitos: no sirve
        self.assertEqual(c.normalizar_telefono("2334455"), "")

    def test_guiones_espacios_parentesis_puntos(self):
        for crudo in ("6678-1234", "6678 1234", "(6678) 1234", "6678.1234", " 66 78 12 34 "):
            self.assertEqual(c.normalizar_telefono(crudo), "50766781234", crudo)

    def test_con_codigo_de_pais(self):
        self.assertEqual(c.normalizar_telefono("+507 6678-1234"), "50766781234")
        self.assertEqual(c.normalizar_telefono("+50766781234"), "50766781234")
        self.assertEqual(c.normalizar_telefono("00507 6678 1234"), "50766781234")
        self.assertEqual(c.normalizar_telefono("507-6678-1234"), "50766781234")
        # otro país se respeta
        self.assertEqual(c.normalizar_telefono("+57 300 123 4567"), "573001234567")

    def test_vacios_y_basura(self):
        for crudo in ("", None, False, "   ", "n/a", "---", "123", "+12", "6678-123"):
            self.assertEqual(c.normalizar_telefono(crudo), "", repr(crudo))
        # demasiado largo
        self.assertEqual(c.normalizar_telefono("+1234567890123456789"), "")

    def test_varios_numeros_en_un_campo(self):
        self.assertEqual(c.normalizar_telefono("233-4455 / 6678-1234"), "50766781234")
        self.assertEqual(c.normalizar_telefono("6678-1234 / 6000-0000"), "50766781234")
        self.assertEqual(c.normalizar_telefono("6678-1234, 6000-0000"), "50766781234")

    def test_extension_no_cuenta(self):
        self.assertEqual(c.normalizar_telefono("6678-1234 ext. 12"), "50766781234")

    def test_elegir_prefiere_el_primero_que_sirve(self):
        self.assertEqual(c.elegir_telefono("66781234", "60001111"), "50766781234")
        self.assertEqual(c.elegir_telefono("", "60001111"), "50760001111")
        self.assertEqual(c.elegir_telefono("abc", False, "6000-1111"), "50760001111")
        self.assertEqual(c.elegir_telefono(False, ""), "")

    def test_legible(self):
        self.assertEqual(c.telefono_legible("50766781234"), "+507 6678-1234")
        self.assertEqual(c.telefono_legible("573001234567"), "+573001234567")
        self.assertEqual(c.telefono_legible(""), "")


class TestMensaje(unittest.TestCase):
    def test_fecha_larga(self):
        self.assertEqual(c.fecha_larga_es(date(2026, 10, 28)), "miércoles 28 de octubre")
        self.assertEqual(c.fecha_larga_es(date(2026, 1, 5)), "lunes 5 de enero")

    def test_marcadores(self):
        m = c.armar_mensaje("Hola {cliente}, soy {vendedor}: paso el {fecha}.", "Carnes Primium", "martes 27 de octubre", "Andrés")
        self.assertEqual(m, "Hola Carnes Primium, soy Andrés: paso el martes 27 de octubre.")

    def test_plantilla_vacia_usa_la_de_defecto(self):
        for vacia in ("", None, "   "):
            m = c.armar_mensaje(vacia, "X", "martes 27 de octubre", "Andrés")
            self.assertIn("martes 27 de octubre", m)
            self.assertIn("Andrés", m)
            self.assertNotIn("{", m)

    def test_llaves_desconocidas_no_rompen(self):
        m = c.armar_mensaje("Hola {cliente} {otra} {", "X", "f", "v")
        self.assertEqual(m, "Hola X {otra} {")

    def test_url(self):
        u = c.url_whatsapp("50766781234", "Hola, ¿qué tal? 50% & más")
        self.assertTrue(u.startswith("https://wa.me/50766781234?text="))
        self.assertNotIn(" ", u)
        self.assertIn("%26", u)  # & codificado
        self.assertIn("%C2%BF", u)  # ¿
        self.assertEqual(c.url_whatsapp("", "x"), "")


class TestVentana(unittest.TestCase):
    HOY = date(2026, 10, 26)

    def test_ventana(self):
        d = lambda n: date(2026, 10, 26 + n)  # noqa: E731
        self.assertFalse(c.en_ventana_aviso(d(-1), self.HOY))
        self.assertFalse(c.en_ventana_aviso(d(0), self.HOY))  # hoy ya no se avisa
        self.assertTrue(c.en_ventana_aviso(d(1), self.HOY))   # mañana
        self.assertTrue(c.en_ventana_aviso(d(3), self.HOY))   # dentro de 3 días
        self.assertFalse(c.en_ventana_aviso(d(4), self.HOY))
        self.assertFalse(c.en_ventana_aviso(None, self.HOY))

    def test_cruce_de_mes(self):
        self.assertTrue(c.en_ventana_aviso(date(2026, 11, 1), date(2026, 10, 30)))
        self.assertFalse(c.en_ventana_aviso(date(2026, 11, 3), date(2026, 10, 30)))


class TestGrandes(unittest.TestCase):
    def test_clases(self):
        self.assertTrue(c.es_cliente_grande("A", 0))
        self.assertTrue(c.es_cliente_grande("A2", 10))
        self.assertFalse(c.es_cliente_grande("B", 499.99))
        self.assertTrue(c.es_cliente_grande("B", 500))
        self.assertFalse(c.es_cliente_grande("C", 0))
        self.assertFalse(c.es_cliente_grande("NUEVO", None))

    def test_umbral_propio(self):
        self.assertTrue(c.es_cliente_grande("B", 300, umbral=250))
        self.assertFalse(c.es_cliente_grande("B", 300, umbral=1000))

    def test_umbral_del_parametro(self):
        self.assertEqual(c.umbral_valido("750"), 750.0)
        self.assertEqual(c.umbral_valido(" 1200,50 "), 1200.5)
        self.assertEqual(c.umbral_valido(""), c.UMBRAL_ESPERADO_DEFECTO)
        self.assertEqual(c.umbral_valido(False), c.UMBRAL_ESPERADO_DEFECTO)
        self.assertEqual(c.umbral_valido("abc"), c.UMBRAL_ESPERADO_DEFECTO)
        self.assertEqual(c.umbral_valido("-5"), c.UMBRAL_ESPERADO_DEFECTO)


if __name__ == "__main__":
    unittest.main()
