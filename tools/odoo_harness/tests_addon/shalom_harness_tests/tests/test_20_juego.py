# -*- coding: utf-8 -*-
import importlib.util
import os
import pathlib
import random
import unittest
from datetime import datetime, timedelta

from odoo import fields
from odoo.exceptions import AccessError
from odoo.tests import tagged
from odoo.tests.common import BaseCase

from odoo.addons.shalom_location_map.models import juego_utils as ju_odoo

from .common import ShalomCommon

REPO = pathlib.Path(os.environ.get("SHALOM_REPO", "/home/user/shalom_route_sales"))


def _cargar(ruta, nombre):
    spec = importlib.util.spec_from_file_location(nombre, ruta)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@tagged("post_install", "-at_install", "shalom_harness")
class TestJuegoUtilsDentroDeOdoo(BaseCase):
    """juego_utils.py se comporta igual importado como módulo de Odoo que
    en `python3 tools/test_juego_utils.py` (mismas 16 pruebas + fuzz
    diferencial contra la copia suelta del repo)."""

    def test_suite_oficial_con_el_modulo_de_odoo(self):
        suite_mod = _cargar(REPO / "tools/test_juego_utils.py", "suite_juego_utils")
        suite_mod.j = ju_odoo  # la suite usa el global `j`: se le inyecta el de Odoo
        suite = unittest.defaultTestLoader.loadTestsFromModule(suite_mod)
        resultado = unittest.TextTestRunner(verbosity=0).run(suite)
        self.assertGreaterEqual(resultado.testsRun, 16)
        self.assertEqual(len(resultado.failures) + len(resultado.errors), 0, resultado.failures + resultado.errors)

    def test_fuzz_diferencial(self):
        suelto = _cargar(REPO / "shalom_location_map/models/juego_utils.py", "ju_suelto")
        rnd = random.Random(42)
        for _ in range(300):
            totales = [round(rnd.uniform(0, 5000), 2) for _ in range(rnd.randint(0, 8))]
            a, b = ju_odoo.referencias_estrellas(totales), suelto.referencias_estrellas(totales)
            self.assertEqual(a, b)
            total, margen = rnd.uniform(0, 7000), rnd.uniform(-10, 60)
            self.assertEqual(ju_odoo.estrellas(total, a, margen), suelto.estrellas(total, b, margen))
            self.assertEqual(ju_odoo.siguiente_objetivo(total, a, margen), suelto.siguiente_objetivo(total, b, margen))
            est, dia = rnd.randint(0, 3), rnd.randint(1, 31)
            self.assertEqual(ju_odoo.xp_pedido(total, est, dia), suelto.xp_pedido(total, est, dia))
            self.assertEqual(ju_odoo.nivel_de_xp(int(total * 3)), suelto.nivel_de_xp(int(total * 3)))
            cl = rnd.choice(["A", "A2", "B", "B2", "C", "NUEVO"])
            self.assertEqual(ju_odoo.valor_esperado(cl, total), suelto.valor_esperado(cl, total))
            self.assertEqual(ju_odoo.clasificar(rnd.randint(0, 3), total / 10, margen, rnd.randint(0, 400)) in
                             ("A", "A2", "B", "B2", "C", "NUEVO"), True)
        cands = [{"id": i, "orden": i, "clase": rnd.choice(["A", "A2", "B", "B2", "C"]),
                  "esperado": rnd.uniform(50, 900)} for i in range(40)]
        for n in (1, 2, 3):
            self.assertEqual(ju_odoo.repartir_carteras(cands, n), suelto.repartir_carteras(cands, n))


@tagged("post_install", "-at_install", "shalom_harness")
class TestMiProgreso(ShalomCommon):
    def _evento(self, persona, xp, dias_atras=0, total=100.0, estrellas=1):
        return self.env["shalom.juego.evento"].sudo().create({
            "person_id": persona.id, "xp": xp, "total": total, "estrellas": estrellas,
            "fecha": datetime.now() - timedelta(days=dias_atras),
        })

    def test_mi_progreso_vendedor_sin_escritura(self):
        """El vendedor (solo lectura sobre el modelo) obtiene su progreso."""
        Evento = self.env["shalom.juego.evento"].with_user(self.u_a)
        # sin eventos
        p = Evento.shalom_mi_progreso()
        self.assertEqual((p["xp_total"], p["nivel"], p["nivel_nombre"]), (0, 1, "Novato"))
        self.assertEqual((p["pedidos_mes"], p["ventas_mes"], p["estrellas_mes"]), (0, 0, 0))
        self.assertEqual((p["xp_nivel"], p["xp_siguiente"]), (0, 600))
        # eventos: 2 de este mes y 1 de hace ~80 días (otro mes)
        self._evento(self.per_a, 400, 0, 1000.0, 2)
        self._evento(self.per_a, 250, 0, 500.55, 3)
        self._evento(self.per_a, 100, 80, 999.0, 1)
        self._evento(self.per_b, 5000, 0, 1.0, 3)   # de otro vendedor: no cuenta
        p = Evento.shalom_mi_progreso()
        self.assertEqual(p["xp_total"], 750)
        self.assertEqual((p["nivel"], p["nivel_nombre"]), (2, "Explorador"))
        self.assertEqual((p["xp_nivel"], p["xp_siguiente"]), (600, 1800))
        hoy = fields.Date.context_today(Evento)
        esperados_mes = 2 if hoy.day > 0 else 0
        self.assertEqual(p["pedidos_mes"], esperados_mes)
        self.assertEqual(p["ventas_mes"], 1500.55)
        self.assertEqual(p["estrellas_mes"], 5)

    def test_mi_progreso_sin_persona_y_permisos(self):
        # admin/OdooBot sin fsm.person -> None
        self.assertIsNone(self.env["shalom.juego.evento"].shalom_mi_progreso())
        # el vendedor NO puede escribir ni crear eventos directamente
        with self.assertRaises(AccessError):
            self.env["shalom.juego.evento"].with_user(self.u_a).create({"person_id": self.per_a.id, "xp": 999})
        ev = self._evento(self.per_a, 10)
        with self.assertRaises(AccessError):
            ev.with_user(self.u_a).write({"xp": 99999})
        with self.assertRaises(AccessError):
            ev.with_user(self.u_a).unlink()
        # fix 6410c72: el vendedor ya NO puede LEER el libro (trae utilidad)
        with self.assertRaises(AccessError):
            ev.with_user(self.u_a).read(["utilidad"])
        with self.assertRaises(AccessError):
            self.env["shalom.juego.evento"].with_user(self.u_a).search([])
        ev.with_user(self.u_mgr).write({"xp": 11})
        # vendedor con fsm_user pero sin grupo de ventas también obtiene progreso
        self._evento(self.per_min, 700)
        p = self.env["shalom.juego.evento"].with_user(self.u_min).shalom_mi_progreso()
        self.assertEqual(p["nivel"], 2)

    def test_nivel_nunca_baja_y_umbrales(self):
        for xp, nivel in ((0, 1), (599, 1), (600, 2), (1799, 2), (1800, 3), (18000, 8), (99999, 8)):
            self.assertEqual(ju_odoo.nivel_de_xp(xp)[0], nivel, xp)
