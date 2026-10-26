# -*- coding: utf-8 -*-
import logging
from datetime import date, datetime, timedelta
from unittest import mock

from odoo import fields
from odoo.exceptions import AccessError, UserError
from odoo.tests import tagged

from .common import ShalomCommon

_logger = logging.getLogger(__name__)


@tagged("post_install", "-at_install", "shalom_harness")
class TestEstrategias(ShalomCommon):
    def _crear(self, titulo, tipo, productos, **kw):
        datos = {"titulo": titulo, "tipo": tipo, "texto": "t", "product_ids": [p.id for p in productos]}
        datos.update(kw)
        return self.env["shalom.estrategia"].with_user(self.u_mgr).shalom_admin_guardar_estrategia(False, datos)

    def _vigentes(self, user=None):
        return self.env["shalom.estrategia"].with_user(user or self.u_a).shalom_estrategias_vigentes()

    def test_admin_gerente_ok_y_vendedor_accesserror(self):
        Est = self.env["shalom.estrategia"]
        eid = self._crear("Empujar tinte", "empujar", [self.p_tinte])
        self.assertTrue(eid)
        lista = Est.with_user(self.u_mgr).shalom_admin_estrategias()
        self.assertEqual([e["titulo"] for e in lista], ["Empujar tinte"])
        self.assertEqual(lista[0]["productos"], [{"id": self.p_tinte.id, "nombre": self.p_tinte.display_name}])
        for user in (self.u_a, self.u_min, self.u_own):
            with self.assertRaises(AccessError, msg=user.login):
                Est.with_user(user).shalom_admin_estrategias()
            with self.assertRaises(AccessError):
                Est.with_user(user).shalom_admin_guardar_estrategia(False, {"titulo": "x"})
            with self.assertRaises(AccessError):
                Est.with_user(user).shalom_admin_guardar_estrategia(eid, {"titulo": "x"})
            with self.assertRaises(AccessError):
                Est.with_user(user).shalom_admin_borrar_estrategia(eid)
        self.assertTrue(Est.browse(eid).exists(), "el vendedor no pudo borrarla")

    def test_vendedor_ve_vigentes_sin_permisos_de_modelo(self):
        self._crear("Empujar", "empujar", [self.p_tinte])
        # el vendedor tiene solo lectura del modelo; aun así la llamada usa sudo
        v = self._vigentes()
        self.assertEqual(len(v["empujar"]), 1)
        self.assertEqual(v["productos"], {self.p_tinte.id: "empujar"})
        self.assertEqual(set(v), {"empujar", "no_ofrecer", "productos"})
        self.assertEqual(set(v["empujar"][0]), {"id", "titulo", "texto", "productos"})

    def test_vigencia_por_fechas(self):
        hoy = fields.Date.context_today(self.env["shalom.estrategia"])
        d = lambda n: fields.Date.to_string(hoy + timedelta(days=n))   # noqa: E731
        self._crear("sin fechas", "empujar", [self.p_tinte])
        self._crear("empieza hoy", "empujar", [self.p_crema], date_from=d(0))
        self._crear("termina hoy", "empujar", [self.p_barato], date_to=d(0))
        self._crear("futura", "empujar", [self.p_oxi], date_from=d(1))
        self._crear("vencida", "no_ofrecer", [self.p_oxi], date_to=d(-1))
        self._crear("inactiva", "no_ofrecer", [self.p_nosale], activa=False)
        v = self._vigentes()
        self.assertEqual(sorted(e["titulo"] for e in v["empujar"]), ["empieza hoy", "sin fechas", "termina hoy"])
        self.assertEqual(v["no_ofrecer"], [])
        self.assertNotIn(self.p_oxi.id, v["productos"])
        self.assertNotIn(self.p_nosale.id, v["productos"])
        # el admin las ve todas (también la inactiva)
        todas = self.env["shalom.estrategia"].with_user(self.u_mgr).shalom_admin_estrategias()
        self.assertEqual(len(todas), 6)
        inactiva = [e for e in todas if e["titulo"] == "inactiva"][0]
        self.assertFalse(inactiva["activa"])
        futura = [e for e in todas if e["titulo"] == "futura"][0]
        self.assertEqual(futura["date_from"], d(1))
        self.assertFalse(futura["date_to"])

    def test_no_ofrecer_gana_sobre_empujar(self):
        # en cualquier orden de creación / secuencia
        for orden in ("empujar_primero", "no_ofrecer_primero"):
            self.env["shalom.estrategia"].sudo().search([]).unlink()
            seqs = (1, 2) if orden == "empujar_primero" else (2, 1)
            self.env["shalom.estrategia"].sudo().create(
                {"name": "e", "tipo": "empujar", "product_ids": [(6, 0, [self.p_tinte.id, self.p_crema.id])], "sequence": seqs[0]})
            self.env["shalom.estrategia"].sudo().create(
                {"name": "n", "tipo": "no_ofrecer", "product_ids": [(6, 0, [self.p_tinte.id])], "sequence": seqs[1]})
            v = self._vigentes()
            self.assertEqual(v["productos"][self.p_tinte.id], "no_ofrecer", orden)
            self.assertEqual(v["productos"][self.p_crema.id], "empujar", orden)

    def test_guardar_editar_borrar(self):
        Est = self.env["shalom.estrategia"].with_user(self.u_mgr)
        eid = self._crear("A", "empujar", [self.p_tinte], activa=False)
        # editar una inactiva (active_test=False) y reactivar
        r = Est.shalom_admin_guardar_estrategia(eid, {"titulo": "  B  ", "tipo": "no_ofrecer", "activa": True,
                                                       "product_ids": [self.p_crema.id], "date_to": "2099-01-01"})
        self.assertEqual(r, eid)
        rec = self.env["shalom.estrategia"].browse(eid)
        self.assertEqual((rec.name, rec.tipo, rec.active, rec.product_ids), ("B", "no_ofrecer", True, self.p_crema))
        self.assertEqual(str(rec.date_to), "2099-01-01")
        with self.assertRaises(UserError):
            Est.shalom_admin_guardar_estrategia(False, {"titulo": "   "})
        with self.assertRaises(UserError):
            Est.shalom_admin_guardar_estrategia(False, {})
        # borrar una inactiva también
        rec.active = False
        self.assertTrue(Est.shalom_admin_borrar_estrategia(eid))
        self.assertFalse(self.env["shalom.estrategia"].with_context(active_test=False).browse(eid).exists())

    def test_admin_con_fsm_manager_via_gerente_implicito(self):
        """El gerente (fsm_manager) NO necesita tener ventas para usar
        esto, pero sí es group_fsm_manager exacto (no dispatcher)."""
        disp = self.env["res.users"].with_context(no_reset_password=True).create({
            "name": "disp", "login": "disp", "company_id": self.company1.id,
            "company_ids": [(6, 0, [self.company1.id])],
            "groups_id": [(6, 0, [self.env.ref("base.group_user").id, self.env.ref("fieldservice.group_fsm_dispatcher").id])],
        })
        with self.assertRaises(AccessError):
            self.env["shalom.estrategia"].with_user(disp).shalom_admin_estrategias()

    def test_vigencia_hora_panama(self):
        """A las 20:30 del 15-oct en Panamá (= 01:30 UTC del 16) una
        estrategia "hasta 15-oct" debe seguir vigente para un vendedor de
        Panamá. shalom_estrategias_vigentes usa Date.context_today: con
        zona horaria del usuario = America/Panama funciona; con usuario
        SIN zona cae a UTC y la da por vencida 5 h antes (HALLAZGO H-1:
        solo se REGISTRA en el log, no falla el test)."""
        self._crear("hasta el 15", "empujar", [self.p_tinte], date_to="2026-10-15")

        class FakeDT(datetime):
            @classmethod
            def now(cls, tz=None):
                return datetime(2026, 10, 16, 1, 30) if tz is None else datetime(2026, 10, 16, 1, 30, tzinfo=tz)

        self.u_a.tz = "America/Panama"
        with mock.patch("odoo.fields.datetime", FakeDT):
            v = self._vigentes(self.u_a)
        self.assertEqual([e["titulo"] for e in v["empujar"]], ["hasta el 15"])
        self.u_a.tz = False
        with mock.patch("odoo.fields.datetime", FakeDT):
            v = self._vigentes(self.u_a)
        if v["empujar"]:
            _logger.warning("H-1 CORREGIDO: la estrategia sigue vigente para usuario sin zona horaria")
        else:
            _logger.warning("H-1 PRESENTE: usuario sin tz -> estrategia 'hasta 15-oct' vencida a las 20:30 hora Panamá")
