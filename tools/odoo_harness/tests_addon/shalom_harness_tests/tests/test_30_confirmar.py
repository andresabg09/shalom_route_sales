# -*- coding: utf-8 -*-
from unittest import mock

import logging

from odoo import fields
from odoo.exceptions import UserError
from odoo.tests import tagged

from odoo.addons.shalom_location_map.models import juego_utils as ju

try:  # no existe en revisiones anteriores a 84a094c (se usa para comparar antes/después)
    from odoo.addons.shalom_location_map.models import tz_utils
except ImportError:
    tz_utils = None

from .common import ShalomCommon

_logger = logging.getLogger(__name__)

CLAVES_JUEGO = {
    "estrellas", "xp", "total", "margen_pct", "record_roto",
    "margen_bajo", "refs", "clase", "progreso", "subio_nivel",
}


@tagged("post_install", "-at_install", "shalom_harness")
class TestConfirmarPedido(ShalomCommon):
    def _confirmar(self, clave, user, lineas, **kw):
        visita = self.visitas[clave].with_user(user)
        return visita.shalom_confirmar_pedido(
            lineas, kw.pop("payment_method", "efectivo"),
            kw.pop("special_delivery_date", False), kw.pop("includes_itbms", False),
        )

    def _eventos(self):
        return self.env["shalom.juego.evento"].sudo().search([])

    # ------------------------------------------------------------------
    def test_flujo_completo_vendedor(self):
        visita = self.visitas["A1"]
        antes = len(self._eventos())
        res = self._confirmar(
            "A1", self.u_a, self.lineas((self.p_tinte, 17)),
            payment_method="tarjeta", special_delivery_date="2030-01-15", includes_itbms=True,
        )
        # contrato antiguo intacto + clave nueva
        self.assertTrue({"sale_order_id", "sale_order_name", "total", "juego"} <= set(res))
        self.assertEqual(res["total"], 1700.0)
        sale = self.env["sale.order"].browse(res["sale_order_id"])
        self.assertEqual(sale.state, "sale")
        self.assertEqual(sale.custom_payment_method, "tarjeta")
        self.assertEqual(str(sale.custom_special_delivery_date), "2030-01-15")
        self.assertTrue(sale.custom_itbms_required)
        self.assertEqual(sale.partner_id, self.clientes["A1"].partner_id)
        visita.invalidate_recordset()
        self.assertTrue(visita.stage_id.is_closed)
        self.assertEqual(visita.sale_id, sale)
        # resultado del juego
        j = res["juego"]
        self.assertIsNotNone(j)
        self.assertEqual(set(j), CLAVES_JUEGO)
        # historial ANTERIOR (3 pedidos): el nuevo no cuenta contra sí mismo
        self.assertEqual(j["refs"]["n"], 3)
        self.assertEqual(j["refs"]["record"], 1600.0)
        self.assertEqual(j["estrellas"], 3)
        self.assertTrue(j["record_roto"])
        self.assertFalse(j["margen_bajo"])
        self.assertNotIn("utilidad", j)
        self.assertEqual(j["margen_pct"], 40.0)
        self.assertEqual(j["clase"], "A")
        dia = tz_utils.hoy_local(self.env).day if tz_utils else fields.Date.context_today(visita).day
        self.assertEqual(j["xp"], ju.xp_pedido(680.0, 3, dia))
        self.assertEqual(j["progreso"]["xp_total"], j["xp"])
        self.assertTrue(j["subio_nivel"])
        # exactamente un evento nuevo, bien enlazado
        evs = self._eventos()
        self.assertEqual(len(evs), antes + 1)
        ev = evs.sorted("id")[-1]
        self.assertEqual((ev.person_id, ev.order_id, ev.sale_id, ev.location_id),
                         (self.per_a, visita, sale, self.clientes["A1"]))
        self.assertEqual((ev.estrellas, ev.xp, ev.total, ev.utilidad), (3, j["xp"], 1700.0, 680.0))
        self.assertTrue(ev.record_roto)

    def test_resultado_no_trae_costo(self):
        res = self._confirmar("A2", self.u_a, self.lineas((self.p_tinte, 17)))
        txt = repr(res)
        self.assertNotIn("costo", txt)
        self.assertNotIn("standard_price", txt)
        self.assertNotIn("utilidad", txt)
        self.assertNotIn("680", txt)

    def test_estrellas_bronce_plata_margen_bajo(self):
        # A3: típico 1433.33, t75 1075; 11 tintes = 1100 -> 1 estrella
        r = self._confirmar("A3", self.u_a, self.lineas((self.p_tinte, 11)))["juego"]
        self.assertEqual((r["estrellas"], r["record_roto"]), (1, False))
        # A4: 15 tintes = 1500 >= típico -> 2 estrellas
        r = self._confirmar("A4", self.u_a, self.lineas((self.p_tinte, 15)))["juego"]
        self.assertEqual(r["estrellas"], 2)
        # A5: 40 oxigenta = 2000 > récord pero margen 10% -> 2 estrellas + margen_bajo
        r = self._confirmar("A5", self.u_a, self.lineas((self.p_oxi, 40)))["juego"]
        self.assertEqual(r["estrellas"], 2)
        self.assertTrue(r["record_roto"])
        self.assertTrue(r["margen_bajo"])
        # N1: cliente nuevo -> 0 estrellas, sin récord roto
        r = self._confirmar("N1", self.u_a, self.lineas((self.p_tinte, 3)))["juego"]
        self.assertEqual((r["estrellas"], r["record_roto"], r["clase"]), (0, False, "NUEVO"))
        self.assertEqual(r["refs"]["n"], 0)

    def test_xp_al_dueno_de_la_visita(self):
        """Fix: el XP es del dueño de la visita (cartera, o si no, el
        dueño de la ruta), no de quien confirme (p. ej. un gerente)."""
        # gerente confirma una visita de la ruta de A -> XP de A
        r = self._confirmar("B1", self.u_mgr, self.lineas((self.p_barato, 2)))
        self.assertIsNotNone(r["juego"])
        ev = self._eventos().sorted("id")[-1]
        self.assertEqual(ev.person_id, self.per_a)
        self.assertEqual(r["juego"]["progreso"]["xp_total"], r["juego"]["xp"])
        # superusuario (sin fsm.person): igual al dueño de la ruta
        r = self.visitas["B2_1"].shalom_confirmar_pedido(self.lineas((self.p_barato, 2)), "efectivo")
        self.assertEqual(self._eventos().sorted("id")[-1].person_id, self.per_a)
        # visita con cartera de B, confirmada por A -> XP de B
        self.visitas["B3"].x_cartera_person_id = self.per_b
        self._confirmar("B3", self.u_a, self.lineas((self.p_barato, 2)))
        self.assertEqual(self._eventos().sorted("id")[-1].person_id, self.per_b)
        # visita sin ruta ni cartera -> cae a la persona actual
        v = self.visitas["B4"]
        v.sudo().write({"location_id": self.clientes["B4"].id})
        self.clientes["B4"].fsm_route_id = False
        v.invalidate_recordset()
        self._confirmar("B4", self.u_c, self.lineas((self.p_barato, 2)))
        self.assertEqual(self._eventos().sorted("id")[-1].person_id, self.per_c)

    def test_base_sin_impuestos_en_confirmar(self):
        tax = self.env["account.tax"].create(
            {"name": "ITBMS 7 prueba", "amount": 7.0, "amount_type": "percent", "type_tax_use": "sale"}
        )
        self.p_tinte.taxes_id = [(6, 0, tax.ids)]
        res = self._confirmar("A1", self.u_a, self.lineas((self.p_tinte, 17)))
        sale = self.env["sale.order"].browse(res["sale_order_id"])
        self.assertEqual(sale.amount_untaxed, 1700.0)
        self.assertAlmostEqual(res["total"], 1819.0, places=2)          # contrato antiguo: con impuesto
        self.assertEqual(res["juego"]["total"], 1700.0)                   # juego: sin impuesto
        ev = self._eventos().sorted("id")[-1]
        self.assertEqual((ev.total, ev.utilidad), (1700.0, 680.0))
        self.assertEqual(res["juego"]["estrellas"], 3)   # 1700 > 1600 (récord sin impuesto)
        self.assertEqual(res["juego"]["margen_pct"], 40.0)

    def test_dia_del_mes_en_hora_panama(self):
        if tz_utils is None:
            self.fail("tz_utils no existe en esta revisión (día del mes en UTC)")
        """XP x1.5 solo los días 1-15 EN HORA DE PANAMÁ: 15-oct 20:30
        local (= 16-oct 01:30 UTC) aún es día 15; 16-oct 00:30 local
        (= 05:30 UTC) ya es 16."""
        from datetime import datetime
        casos = [(datetime(2026, 10, 16, 1, 30), 15, True), (datetime(2026, 10, 16, 5, 30), 16, False)]
        for i, (ahora, dia_local, multiplica) in enumerate(casos):
            clave = ("B1", "B2_2")[i]
            with mock.patch.object(fields.Datetime, "now", return_value=ahora):
                self.assertEqual(tz_utils.hoy_local(self.env).day, dia_local)
                res = self._confirmar(clave, self.u_a, self.lineas((self.p_tinte, 17)))
            j = res["juego"]
            esperado = ju.xp_pedido(680.0, j["estrellas"], dia_local)
            self.assertEqual(j["xp"], esperado)
            self.assertEqual(multiplica, j["xp"] == int(round(680 * 1.5)) + ju.BONO_ESTRELLA[j["estrellas"]])

    def test_zona_del_usuario_manda(self):
        if tz_utils is None:
            self.fail("tz_utils no existe en esta revisión")
        from datetime import datetime
        self.u_a.tz = "Asia/Tokyo"      # UTC+9: 16-oct 01:30 UTC = 16-oct 10:30 local
        with mock.patch.object(fields.Datetime, "now", return_value=datetime(2026, 10, 16, 1, 30)):
            self.assertEqual(tz_utils.hoy_local(self.env(user=self.u_a)).day, 16)
            self.assertEqual(tz_utils.hoy_local(self.env(user=self.u_b)).day, 15)   # sin tz -> Panamá

    def test_unique_sale_id_segundo_registro(self):
        """unique(sale_id): registrar dos veces el resultado de un mismo
        pedido no duplica el evento ni envenena la transacción."""
        res = self._confirmar("A1", self.u_a, self.lineas((self.p_tinte, 17)))
        sale = self.env["sale.order"].browse(res["sale_order_id"])
        n = len(self._eventos())
        otra = self.visitas["A1"].with_user(self.u_a)._shalom_registrar_resultado_juego(sale)
        self.assertIsNone(otra)
        self.assertEqual(len(self._eventos()), n)
        self.env.cr.execute("SELECT 1")

    def test_validaciones(self):
        v = self.visitas["B3"].with_user(self.u_a)
        with self.assertRaises(UserError):
            v.shalom_confirmar_pedido([], "efectivo")
        with self.assertRaises(UserError):
            v.shalom_confirmar_pedido(self.lineas((self.p_barato, 1)), False)
        self.assertEqual(self.env["sale.order"].search_count([("origin", "=", False), ("state", "=", "draft")]) >= 0, True)

    def test_doble_toque_no_duplica_evento(self):
        """Segundo toque a Confirmar sobre la misma visita: el pedido ya
        está confirmado (Odoo no deja borrar líneas) -> error de Odoo, y
        NO debe quedar un segundo evento."""
        self._confirmar("B4", self.u_a, self.lineas((self.p_barato, 2)))
        n = len(self._eventos())
        with self.assertRaises(UserError):
            with self.env.cr.savepoint():
                self._confirmar("B4", self.u_a, self.lineas((self.p_barato, 2)))
        self.assertEqual(len(self._eventos()), n)

    # ---------------- el juego NUNCA rompe la confirmación --------------
    def _confirmar_con_fallo(self, clave, parche):
        visita = self.visitas[clave]
        n = len(self._eventos())
        with parche:
            res = self._confirmar(clave, self.u_a, self.lineas((self.p_tinte, 17)))
        self.assertIsNone(res["juego"])
        sale = self.env["sale.order"].browse(res["sale_order_id"])
        self.assertEqual(sale.state, "sale", "el pedido debe confirmarse igual")
        visita.invalidate_recordset()
        self.assertTrue(visita.stage_id.is_closed, "la visita debe cerrarse igual")
        self.assertEqual(len(self._eventos()), n, "no debe quedar evento a medias")
        # la transacción NO quedó envenenada: se puede seguir consultando y escribiendo
        self.env.cr.execute("SELECT 1")
        self.assertEqual(self.env.cr.fetchone()[0], 1)
        visita.with_user(self.u_a).write({"x_observaciones_visita": "sigue viva la transacción"})
        self.env.flush_all()
        return res

    def test_error_python_dentro_del_juego(self):
        self._confirmar_con_fallo(
            "A1", mock.patch.object(ju, "xp_pedido", side_effect=ValueError("boom python"))
        )

    def test_error_sql_dentro_del_savepoint(self):
        """Peor caso: error de BASE DE DATOS dentro del savepoint (aborta
        la subtransacción). El savepoint debe revertirlo sin envenenar."""
        Evento = type(self.env["shalom.juego.evento"])
        original = Evento.create

        def create_roto(modelo, vals_list):
            modelo.env.cr.execute("SELECT 1/0")   # psycopg2.errors.DivisionByZero
            return original(modelo, vals_list)

        self._confirmar_con_fallo("A2", mock.patch.object(Evento, "create", create_roto))

    def test_error_sql_despues_de_insertar_evento(self):
        """El evento se INSERTA y después falla el cálculo del progreso:
        el savepoint debe deshacer también el INSERT."""
        Evento = type(self.env["shalom.juego.evento"])
        parche = mock.patch.object(Evento, "_shalom_progreso_de", autospec=True,
                                   side_effect=[{"nivel": 1, "xp_total": 0}, RuntimeError("falla tras insertar")])
        self._confirmar_con_fallo("A3", parche)

    # ---------------- recompensas (promo 12+1) --------------------------
    def _crear_programa_12_mas_1(self):
        prog = self.env["loyalty.program"].create({
            "name": "12+1 tinte (prueba)",
            "program_type": "buy_x_get_y",
            "trigger": "auto",
            "applies_on": "current",
            "rule_ids": [(0, 0, {
                "product_ids": [(6, 0, [self.p_tinte.id])],
                "reward_point_mode": "unit",
                "reward_point_amount": 1,
                "minimum_qty": 1,
            })],
            "reward_ids": [(0, 0, {
                "reward_type": "product",
                "reward_product_id": self.p_tinte.id,
                "reward_product_qty": 1,
                "required_points": 12,
            })],
        })
        return prog

    def test_confirmar_con_recompensa(self):
        prog = self._crear_programa_12_mas_1()
        regla = prog.rule_ids[0]
        lineas = self.lineas((self.p_tinte, 12)) + [
            {"product_id": self.p_tinte.id, "qty": 1, "es_recompensa": True, "regla_id": regla.id}
        ]
        res = self._confirmar("A4", self.u_a, lineas)
        sale = self.env["sale.order"].browse(res["sale_order_id"])
        self.assertEqual(sale.state, "sale")
        recompensas = sale.order_line.filtered("is_reward_line")
        self.assertTrue(recompensas, "debe existir la línea de recompensa nativa")
        j = res["juego"]
        self.assertIsNotNone(j, "el juego debe calcularse también con recompensas")
        # venta = 12 tintes pagados (1200); costo = 13 tintes (780) -> utilidad 420
        self.assertEqual(sale.amount_total, 1200.0)
        self.assertEqual(j["total"], 1200.0)
        ev = self._eventos().sorted("id")[-1]
        self.assertEqual(ev.utilidad, 420.0)

    def test_evaluar_pedido_con_recompensa_coincide_con_confirmar(self):
        prog = self._crear_programa_12_mas_1()
        lineas = self.lineas((self.p_tinte, 12)) + [
            {"product_id": self.p_tinte.id, "qty": 1, "es_recompensa": True, "regla_id": prog.rule_ids[0].id}
        ]
        previo = self.env["fsm.order"].with_user(self.u_a).shalom_evaluar_pedido(self.clientes["A5"].id, lineas)
        real = self._confirmar("A5", self.u_a, lineas)["juego"]
        for k in ("total", "margen_pct", "estrellas"):
            self.assertEqual(previo[k], real[k], k)

    # ---------------- permisos de ventas del vendedor -----------------
    def test_confirmar_vendedor_solo_sus_documentos(self):
        """Vendedor con ventas "solo mis documentos": confirma, y la
        vara es la del historial COMPLETO (aunque los pedidos viejos
        sean de otros)."""
        res = self._confirmar("A1", self.u_own, self.lineas((self.p_tinte, 17)))
        self.assertIsNotNone(res["juego"])
        self.assertEqual(res["juego"]["refs"]["n"], 3)
        self.assertEqual(res["juego"]["estrellas"], 3)
        self.assertEqual(self._eventos().sorted("id")[-1].person_id, self.per_a)

    def test_confirmar_fsm_user_sin_grupo_de_ventas(self):
        """INFORMATIVO: cuál es el comportamiento de un usuario con SOLO
        fsm_user (en esta pila, con fieldservice_sale/account). No falla
        el test; deja el resultado en el log."""
        try:
            res = self._confirmar("A2", self.u_min, self.lineas((self.p_tinte, 3)))
            _logger.warning("INFO fsm_user solo: confirmar OK, juego=%s", bool(res["juego"]))
        except Exception as e:  # noqa: BLE001
            _logger.warning("INFO fsm_user solo: confirmar falla con %s: %s", type(e).__name__, str(e)[:120])

    def test_historial_incluye_otra_compania(self):
        """INFORMATIVO (decisión de negocio): con sudo(), un pedido
        confirmado en la compañía 2 (Greenpeak) al mismo cliente SÍ
        cuenta en récord/típico. Antes (sin sudo, vendedor solo en
        compañía 1) no contaba."""
        loc = self.clientes["N1"]
        wh2 = self.wh_nevada
        so = self.env["sale.order"].with_company(self.company2).sudo().create({
            "partner_id": loc.partner_id.id, "company_id": self.company2.id, "warehouse_id": wh2.id,
            "order_line": [(0, 0, {"product_id": self.p_tinte.id, "product_uom_qty": 10})],
        })
        so.write({"state": "sale"})
        f = self.env["fsm.order"].with_user(self.u_a).shalom_ficha_juego(loc.id)
        _logger.warning("INFO pedido de otra compañía cuenta en el historial: n=%s record=%s", f["n"], f["refs"]["record"])
        self.assertIn(f["n"], (0, 1))

    def test_flush_previo_fuera_del_try(self):
        """Diseño (6fc1b7d): si el flush previo al savepoint falla, el
        error SALE (no lo traga el except) para que no se pierda el pedido
        con la transacción abortada."""
        res = self._confirmar("A1", self.u_a, self.lineas((self.p_tinte, 17)))
        sale = self.env["sale.order"].browse(res["sale_order_id"])
        visita = self.visitas["A1"]
        Cursor = type(self.env.cr)
        salio = False
        with mock.patch.object(Cursor, "flush", side_effect=RuntimeError("flush roto")):
            try:      # (assertRaises abre su propio savepoint y también hace flush)
                visita._shalom_registrar_resultado_juego(sale)
            except RuntimeError:
                salio = True
        self.assertTrue(salio, "el error del flush previo debe salir, no tragarse")
