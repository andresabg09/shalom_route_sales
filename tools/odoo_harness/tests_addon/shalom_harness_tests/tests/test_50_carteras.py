# -*- coding: utf-8 -*-
from datetime import timedelta

from odoo import fields
from odoo.exceptions import AccessError, UserError
from odoo.tests import tagged

from odoo.addons.shalom_location_map.models import juego_utils as ju

from .common import ShalomCommon

NO_ENTRAN = ("DIST", "C1", "C2", "N1", "N2")


@tagged("post_install", "-at_install", "shalom_harness")
class TestCarteras(ShalomCommon):
    def _repartir(self, personas=None, user=None, **kw):
        personas = personas or [self.per_a, self.per_b]
        return self.env["fsm.route.schedule"].with_user(user or self.u_mgr).shalom_admin_repartir_cartera(
            self.ciclo.id, [p.id for p in personas], **kw)

    def _estado(self):
        return {c: (v.x_cartera_person_id.id, v.x_cartera_fecha, v.x_cartera_orden, v.x_cartera_reserva)
                for c, v in self.visitas.items()}

    def _todas_visitas(self):
        return self.env["fsm.order"].with_context(active_test=False).search([("x_route_schedule_id", "=", self.ciclo.id)])

    # ------------------------------------------------------------------
    def test_permisos(self):
        S = self.env["fsm.route.schedule"]
        for user in (self.u_a, self.u_b, self.u_min, self.u_own):
            with self.assertRaises(AccessError, msg=user.login):
                S.with_user(user).shalom_admin_repartir_cartera(self.ciclo.id, [self.per_a.id])
            with self.assertRaises(AccessError):
                S.with_user(user).shalom_admin_limpiar_cartera(self.ciclo.id)
        for v in self.visitas.values():
            self.assertFalse(v.x_cartera_person_id)

    def test_reparto_basico(self):
        antes = len(self._todas_visitas())
        res = self._repartir()
        self.assertEqual(set(res), {"ciclo", "personas", "sin_cartera", "minimo"})
        self.assertEqual(res["minimo"], 2000.0)
        # entran las clases A/A2/B/B2 (15 clientes); salen 5
        self.visitas = {c: v.invalidate_recordset() or v for c, v in self.visitas.items()}
        con = {c for c, v in self.visitas.items() if v.x_cartera_person_id}
        sin = set(self.visitas) - con
        self.assertEqual(sin, set(NO_ENTRAN))
        self.assertEqual(res["sin_cartera"], 5)
        # solo vendedores pedidos
        self.assertLessEqual({v.x_cartera_person_id for v in self.visitas.values() if v.x_cartera_person_id},
                             {self.per_a, self.per_b})
        # nada se archiva ni cierra ni se crea/borra
        self.assertEqual(len(self._todas_visitas()), antes)
        self.assertTrue(all(v.active and not v.stage_id.is_closed for v in self.visitas.values()))
        # el dueño de la ruta (A) recibe la primera cartera
        primera = min((v for v in self.visitas.values() if v.x_cartera_person_id), key=lambda v: (v.x_cartera_fecha, v.x_cartera_orden))
        self.assertEqual(primera.x_cartera_person_id, self.per_a)
        # resumen coherente con lo escrito
        total_clientes = sum(p["clientes"] + p["reservas"] for p in res["personas"])
        self.assertEqual(total_clientes, len(con))
        for p in res["personas"]:
            n = len([v for v in self.visitas.values() if v.x_cartera_person_id.id == p["persona_id"]])
            self.assertEqual(n, p["clientes"] + p["reservas"], p["persona_nombre"])
            self.assertEqual(len(p["carteras"]), len({v.x_cartera_fecha for v in self.visitas.values()
                                                      if v.x_cartera_person_id.id == p["persona_id"]}))

    def test_fechas_solo_lunes_a_viernes(self):
        hoy = fields.Date.context_today(self.env["fsm.route"])
        # ciclo que arranca un sábado futuro: la primera cartera cae en lunes
        sab = hoy + timedelta(days=(5 - hoy.weekday()) % 7 or 7)
        self.ciclo.write({"date_start": sab, "date_end": sab + timedelta(days=20)})
        self._repartir(minimo=500)         # más carteras -> más días
        fechas = sorted({v.x_cartera_fecha for v in self.visitas.values() if v.x_cartera_fecha})
        self.assertGreaterEqual(len(fechas), 3)
        for f in fechas:
            self.assertLess(f.weekday(), 5, f)
            self.assertGreaterEqual(f, sab)
        self.assertEqual(fechas[0], sab + timedelta(days=2))   # lunes

    def test_fechas_no_antes_de_hoy(self):
        hoy = fields.Date.context_today(self.env["fsm.route"])
        self.ciclo.write({"date_start": hoy - timedelta(days=30), "date_end": hoy + timedelta(days=5)})
        self._repartir(minimo=500)
        for v in self.visitas.values():
            if v.x_cartera_fecha:
                self.assertGreaterEqual(v.x_cartera_fecha, hoy)
                self.assertLess(v.x_cartera_fecha.weekday(), 5)

    def test_orden_y_reservas_dentro_de_cada_cartera(self):
        res = self._repartir(minimo=1000, reserva=2)
        grupos = {}
        for c, v in self.visitas.items():
            if v.x_cartera_person_id:
                grupos.setdefault((v.x_cartera_person_id.id, v.x_cartera_fecha), []).append((c, v))
        self.assertTrue(grupos)
        prioridad = {"A": 0, "A2": 1, "B": 2, "B2": 3}
        perfiles = self.env["fsm.order"].shalom_perfiles_ruta([l.id for l in self.clientes.values()])
        for (_p, _f), miembros in grupos.items():
            miembros.sort(key=lambda m: m[1].x_cartera_orden)
            self.assertEqual([m[1].x_cartera_orden for m in miembros], list(range(1, len(miembros) + 1)))
            normales = [m for m in miembros if not m[1].x_cartera_reserva]
            reservas = [m for m in miembros if m[1].x_cartera_reserva]
            self.assertLessEqual(len(reservas), 2)
            self.assertEqual(miembros[:len(normales)], normales, "las reservas van al final")
            clases = [prioridad[perfiles[self.clientes[m[0]].id]["clase"]] for m in normales]
            self.assertEqual(clases, sorted(clases), "A primero, luego A2, luego B")
        # un cliente pertenece a UNA sola cartera
        self.assertEqual(sum(len(m) for m in grupos.values()), len([v for v in self.visitas.values() if v.x_cartera_person_id]))

    def test_resobrescribe_y_es_determinista(self):
        self._repartir([self.per_a, self.per_b])
        e1 = self._estado()
        self._repartir([self.per_a, self.per_b])
        self.visitas = {c: v.invalidate_recordset() or v for c, v in self.visitas.items()}
        self.assertEqual(self._estado(), e1, "repartir dos veces da lo mismo")
        # re-repartir con otro par de vendedores pisa el anterior
        self._repartir([self.per_a, self.per_c])
        quienes = {v.x_cartera_person_id for v in self.visitas.values() if v.x_cartera_person_id}
        self.assertEqual(quienes, {self.per_a, self.per_c})
        # un solo vendedor: todas las carteras son suyas, en días distintos
        self._repartir([self.per_c])
        quienes = {v.x_cartera_person_id for v in self.visitas.values() if v.x_cartera_person_id}
        self.assertEqual(quienes, {self.per_c})

    def test_duplicados_y_orden_de_personas(self):
        self._repartir([self.per_b, self.per_b, self.per_a])      # duplicado + dueño no es el primero
        quienes = {v.x_cartera_person_id for v in self.visitas.values() if v.x_cartera_person_id}
        self.assertEqual(quienes, {self.per_a, self.per_b})
        primera = min((v for v in self.visitas.values() if v.x_cartera_person_id), key=lambda v: (v.x_cartera_fecha, v.x_cartera_orden))
        self.assertEqual(primera.x_cartera_person_id, self.per_a, "el dueño de la ruta tiene prioridad")

    def test_visitas_cerradas_no_se_tocan(self):
        cerrada = self.visitas["A1"]
        cerrada.write({"x_cartera_person_id": self.per_c.id, "x_cartera_orden": 77})
        cerrada.with_context(bypass_order_completed_stage=True).write(
            {"stage_id": self.env.ref("fieldservice.fsm_stage_completed").id})
        self._repartir()
        cerrada.invalidate_recordset()
        self.assertEqual((cerrada.x_cartera_person_id, cerrada.x_cartera_orden), (self.per_c, 77))
        self.assertTrue(cerrada.stage_id.is_closed)
        # y limpiar tampoco
        n = self.env["fsm.route.schedule"].with_user(self.u_mgr).shalom_admin_limpiar_cartera(self.ciclo.id)
        cerrada.invalidate_recordset()
        self.assertEqual(cerrada.x_cartera_person_id, self.per_c)
        self.assertEqual(n, 19)

    def test_limpiar(self):
        self._repartir()
        n = self.env["fsm.route.schedule"].with_user(self.u_mgr).shalom_admin_limpiar_cartera(self.ciclo.id)
        self.assertEqual(n, 20)
        self.visitas = {c: v.invalidate_recordset() or v for c, v in self.visitas.items()}
        for v in self.visitas.values():
            self.assertEqual((v.x_cartera_person_id.id, v.x_cartera_fecha, v.x_cartera_orden, v.x_cartera_reserva),
                             (False, False, 0, False))
        # ciclo inexistente: no revienta con el gerente
        self.assertEqual(self.env["fsm.route.schedule"].with_user(self.u_mgr).shalom_admin_limpiar_cartera(99999999), 0)

    def test_validaciones_sin_borrar_reparto_previo(self):
        S = self.env["fsm.route.schedule"].with_user(self.u_mgr)
        self._repartir()
        previo = self._estado()
        for ids in ([], [99999999], [0]):
            with self.assertRaises(UserError, msg=str(ids)):
                S.shalom_admin_repartir_cartera(self.ciclo.id, ids)
        with self.assertRaises(UserError):
            S.shalom_admin_repartir_cartera(99999999, [self.per_a.id])
        self.visitas = {c: v.invalidate_recordset() or v for c, v in self.visitas.items()}
        self.assertEqual(self._estado(), previo, "los errores de validación no borran el reparto")
        # nadie califica (todos distribuidoras): error y reparto anterior intacto
        for loc in self.clientes.values():
            loc.x_es_distribuidora = True
        with self.assertRaises(UserError):
            S.shalom_admin_repartir_cartera(self.ciclo.id, [self.per_a.id, self.per_b.id])
        self.visitas = {c: v.invalidate_recordset() or v for c, v in self.visitas.items()}
        self.assertEqual(self._estado(), previo, "sin candidatos no se borra el reparto previo")

    def test_ciclo_sin_visitas_abiertas(self):
        for v in self.visitas.values():
            v.with_context(bypass_order_completed_stage=True).write(
                {"stage_id": self.env.ref("fieldservice.fsm_stage_completed").id})
        with self.assertRaises(UserError):
            self._repartir()

    def test_parametros_minimo_y_reserva(self):
        res = self._repartir(minimo=100000)       # ninguna cartera llega al mínimo
        self.assertTrue(res["personas"])
        self.assertTrue(all(not c["completo"] for p in res["personas"] for c in p["carteras"]))
        res = self._repartir(minimo=500, reserva=0)
        self.assertEqual(sum(p["reservas"] for p in res["personas"]), 0)
        self.assertFalse(any(v.x_cartera_reserva for v in self.visitas.values()))

    def test_expectativas_juego_utils_vs_orm(self):
        """Los 'esperado' que usa el reparto son los de shalom_perfiles_ruta."""
        res = self._repartir()
        perf = self.env["fsm.order"].shalom_perfiles_ruta([l.id for l in self.clientes.values()])
        total = sum(perf[self.clientes[c].id]["esperado"] for c, v in self.visitas.items()
                    if v.x_cartera_person_id and not v.x_cartera_reserva)
        suma_res = sum(c["esperado"] for p in res["personas"] for c in p["carteras"])
        self.assertAlmostEqual(total, suma_res, places=1)
