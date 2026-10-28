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
