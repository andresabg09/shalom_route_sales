# -*- coding: utf-8 -*-
from odoo.tests import tagged

from .common import ShalomCommon


@tagged("post_install", "-at_install", "shalom_harness")
class TestInstalacion(ShalomCommon):
    def test_escenario(self):
        """El escenario sintético quedó como se diseñó."""
        env = self.env
        self.assertEqual(len(self.clientes), 20)
        self.assertEqual(len(self.visitas), len(self.clientes))
        for clave, v in self.visitas.items():
            self.assertEqual(len(v), 1, clave)
            self.assertFalse(v.stage_id.is_closed)
        for m in ("shalom.estrategia", "shalom.juego.evento"):
            self.assertIn(m, env)
        # payment constant importada del stub (no el fallback)
        from odoo.addons.shalom_location_map.models import fsm_order
        import odoo.addons.stock_picking_sale_buttons.models.sale_order as stub
        self.assertIs(fsm_order.PAYMENT_METHOD_SELECTION, stub.PAYMENT_METHOD_SELECTION)
        # cron de reposición desactivado
        cron = env.ref("shalom_location_map.shalom_cron_reponer_rutas_vencidas", raise_if_not_found=False)
        self.assertTrue(cron)
        self.assertTrue(cron.active)  # reactivado el 27/10/2026
