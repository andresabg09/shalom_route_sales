# -*- coding: utf-8 -*-
"""Rutas libres: cualquiera ve todas, la marca de quién la trabaja y el
estado en vivo para que dos vendedores no atiendan al mismo cliente."""
from datetime import timedelta

from odoo import fields
from odoo.exceptions import AccessError
from odoo.tests import tagged

from .common import ShalomCommon


@tagged("post_install", "-at_install", "shalom_harness")
class TestRutasLibres(ShalomCommon):
    def setUp(self):
        super().setUp()
        self.ciclo.write({"date_start": self.hoy, "date_end": self.hoy + timedelta(days=6)})
        self.ds = str(self.hoy - timedelta(days=10))
        self.de = str(self.hoy + timedelta(days=20))

    def _rutas(self, user):
        return self.env["fsm.person"].with_user(user).shalom_mis_rutas_programadas(self.ds, self.de)

    def _mia(self, user):
        return next(r for r in self._rutas(user) if r["id"] == self.ciclo.id)

    def test_otro_vendedor_ve_la_ruta_y_sus_visitas(self):
        # la ruta es de A, pero B la ve igual y puede leer sus visitas
        self.assertFalse(self._mia(self.u_b)["es_mia"])
        self.assertTrue(self._mia(self.u_a)["es_mia"])
        visitas = self.env["fsm.order"].with_user(self.u_b).search_read(
            [("x_route_schedule_id", "=", self.ciclo.id)], ["stage_id", "location_id"])
        self.assertTrue(visitas)

    def test_atender_marca_la_ruta_y_actualiza_al_otro(self):
        self.assertEqual(self._mia(self.u_b)["tomada_por"], [])
        orden = self.env["fsm.order"].search([("x_route_schedule_id", "=", self.ciclo.id)], limit=1)
        antes = self.env["fsm.route.schedule"].with_user(self.u_b).shalom_estado_ruta(self.ciclo.id)
        etapa = self.env["fsm.stage"].search([("stage_type", "=", "order"), ("is_closed", "=", True),
                                              ("id", "!=", self.env.ref("shalom_location_map.shalom_fsm_stage_no_atendido").id)], limit=1)
        orden.with_user(self.u_a).sudo(False).write({"stage_id": etapa.id})
        despues = self.env["fsm.route.schedule"].with_user(self.u_b).shalom_estado_ruta(self.ciclo.id)
        self.assertNotEqual(antes["visitas"][orden.id], despues["visitas"][orden.id])
        self.assertEqual(despues["visitas"][orden.id], etapa.name)
        tomada = self._mia(self.u_b)["tomada_por"]
        self.assertEqual([t["person_id"] for t in tomada], [self.per_a.id])
        self.assertFalse(tomada[0]["es_yo"])
        self.assertTrue(self._mia(self.u_a)["tomada_por"][0]["es_yo"])

    def test_tomar_soltar_y_vigencia(self):
        S = self.env["fsm.route.schedule"]
        S.with_user(self.u_b).shalom_tomar_ruta(self.ciclo.id)
        self.assertEqual(len(self._mia(self.u_a)["tomada_por"]), 1)
        # dos vendedores pueden compartirla
        S.with_user(self.u_a).shalom_tomar_ruta(self.ciclo.id)
        self.assertEqual(len(self._mia(self.u_a)["tomada_por"]), 2)
        # a los 3 días sin actividad se suelta sola
        self.env["shalom.ruta.toma"].sudo().search([("person_id", "=", self.per_b.id)]).write(
            {"ultima_actividad": fields.Datetime.now() - timedelta(days=4)})
        self.assertEqual([t["person_id"] for t in self._mia(self.u_a)["tomada_por"]], [self.per_a.id])
        S.with_user(self.u_a).shalom_soltar_ruta(self.ciclo.id)
        self.assertEqual(self._mia(self.u_a)["tomada_por"], [])

    def test_exprés_sigue_siendo_solo_de_su_vendedor(self):
        exp = self.env["fsm.route"].create({"name": "Exprés libre", "fsm_person_id": self.per_a.id, "x_es_visita_express": True})
        sch = self.env["fsm.route.schedule"].create({"route_id": exp.id, "date_start": self.hoy, "date_end": self.hoy})
        self.env["fsm.order"].create({"name": "e", "location_id": self.clientes["B1"].id, "x_route_schedule_id": sch.id,
                                      "stage_id": self.env.ref("shalom_location_map.shalom_fsm_stage_order_new").id})
        self.assertIn(sch.id, [r["id"] for r in self._rutas(self.u_a)])
        self.assertNotIn(sch.id, [r["id"] for r in self._rutas(self.u_b)])

    def test_buscar_clientes_en_todas_las_rutas(self):
        P = self.env["fsm.person"]
        cli = self.clientes["A1"]
        cli.name = "UEFA Mini Super"
        res = P.with_user(self.u_b).shalom_buscar("uefa")
        self.assertEqual([r["location_id"] for r in res], [cli.id])
        r = res[0]
        self.assertEqual(r["route_id"], self.ruta.id)
        self.assertTrue(r["schedule"] and r["schedule"]["id"] == self.ciclo.id)
        self.assertFalse(r["cerrada"])
        self.assertEqual(P.with_user(self.u_b).shalom_buscar("u"), [])  # mínimo 2 letras
        self.assertEqual(P.with_user(self.u_b).shalom_buscar("zzzz-no-existe"), [])
        # si otro vendedor la resuelve, la búsqueda lo dice
        orden = self.env["fsm.order"].search([("x_route_schedule_id", "=", self.ciclo.id), ("location_id", "=", cli.id)], limit=1)
        etapa = self.env["fsm.stage"].search([("stage_type", "=", "order"), ("is_closed", "=", True),
                                              ("id", "!=", self.env.ref("shalom_location_map.shalom_fsm_stage_no_atendido").id)], limit=1)
        orden.with_user(self.u_a).write({"stage_id": etapa.id})
        r = P.with_user(self.u_b).shalom_buscar("uefa")[0]
        self.assertTrue(r["cerrada"])
        self.assertEqual(r["atendido_por"], "Persona A")
        self.assertTrue(r["atendido_hoy"])
