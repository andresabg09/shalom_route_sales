# -*- coding: utf-8 -*-
"""Cron de reposición de ciclos, corrido como lo corre producción (OdooBot)."""
from datetime import timedelta

from odoo import SUPERUSER_ID
from odoo.tests import tagged

from .common import ShalomCommon


@tagged("post_install", "-at_install", "shalom_harness")
class TestCronReposicion(ShalomCommon):
    def test_cron_genera_ciclo_como_odoobot(self):
        ruta = self.ciclo.route_id
        ruta.x_periodicidad_dias = 30
        self.ciclo.write({"date_start": self.hoy - timedelta(days=45),
                          "date_end": self.hoy - timedelta(days=43)})
        env = self.env(user=SUPERUSER_ID)
        antes = env["fsm.route.schedule"].search_count([("route_id", "=", ruta.id)])
        env["fsm.route.schedule"]._shalom_reponer_rutas_vencidas()
        despues = env["fsm.route.schedule"].search_count([("route_id", "=", ruta.id)])
        self.assertEqual(despues, antes + 1)


@tagged("post_install", "-at_install", "shalom_harness")
class TestRutasSinVentas(ShalomCommon):
    def test_clientes_con_ventas_en_las_rutas(self):
        """Cada ruta informa cuántos clientes ya compraron (la app oculta las de 0)."""
        self.ciclo.write({"date_start": self.hoy, "date_end": self.hoy + timedelta(days=6)})
        rutas = self.env["fsm.person"].with_user(self.u_a).shalom_mis_rutas_programadas(
            str(self.hoy - timedelta(days=30)), str(self.hoy + timedelta(days=30)))
        mia = [r for r in rutas if r["id"] == self.ciclo.id]
        self.assertTrue(mia)
        con = mia[0]["clientes_con_ventas"]
        self.assertIsInstance(con, int)
        self.assertGreater(con, 0)
        self.assertLess(con, mia[0]["cantidad_clientes"])  # hay clientes NUEVO sin compras
