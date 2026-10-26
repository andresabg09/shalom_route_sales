# -*- coding: utf-8 -*-
import json

from odoo.tests import tagged

from .common import ShalomCommon


@tagged("post_install", "-at_install", "shalom_harness")
class TestCatalogo(ShalomCommon):
    # ---------------- existencias por bodega ---------------------------
    def test_existencias_bodegas_vendedor(self):
        """Dianke=WH, Nevada=ALBRK (otra compañía) y el vendedor NO tiene
        acceso a la compañía 2."""
        self.assertNotIn(self.company2, self.u_a.company_ids)
        Order = self.env["fsm.order"].with_user(self.u_a)
        ids = [self.p_tinte.id, self.p_oxi.id, self.p_crema.id, self.p_barato.id]
        res = Order.shalom_existencias_bodegas(ids)
        self.assertEqual(res[self.p_tinte.id], {"dianke": 10, "nevada": 3})
        self.assertEqual(res[self.p_oxi.id], {"dianke": 0, "nevada": 40})
        self.assertEqual(res[self.p_crema.id], {"dianke": 5, "nevada": 0})
        self.assertEqual(res[self.p_barato.id], {"dianke": 100, "nevada": 7})

    def test_existencias_bodegas_vacio_e_inexistente(self):
        Order = self.env["fsm.order"].with_user(self.u_a)
        self.assertEqual(Order.shalom_existencias_bodegas([]), {})
        res = Order.shalom_existencias_bodegas([self.p_tinte.id, 99999999])
        self.assertEqual(list(res), [self.p_tinte.id])

    def test_existencias_bodegas_param_config(self):
        """shalom.bodega_*_id manda sobre el código; invertidos."""
        icp = self.env["ir.config_parameter"].sudo()
        icp.set_param("shalom.bodega_dianke_id", str(self.wh_nevada.id))
        icp.set_param("shalom.bodega_nevada_id", str(self.wh_dianke.id))
        res = self.env["fsm.order"].with_user(self.u_a).shalom_existencias_bodegas([self.p_tinte.id])
        self.assertEqual(res[self.p_tinte.id], {"dianke": 3, "nevada": 10})

    def test_existencias_sin_bodega_nevada(self):
        self.wh_nevada.sudo().write({"code": "ZZ"})
        res = self.env["fsm.order"].with_user(self.u_a).shalom_existencias_bodegas([self.p_tinte.id])
        self.assertEqual(res[self.p_tinte.id], {"dianke": 10, "nevada": 0})

    def test_existencias_free_qty_descuenta_reservado(self):
        """free_qty = a mano - reservado: se reserva stock en Dianke."""
        loc = self.wh_dianke.lot_stock_id
        quant = self.env["stock.quant"].sudo().search(
            [("product_id", "=", self.p_tinte.id), ("location_id", "=", loc.id)]
        )
        quant.reserved_quantity = 4
        res = self.env["fsm.order"].with_user(self.u_a).shalom_existencias_bodegas([self.p_tinte.id])
        self.assertEqual(res[self.p_tinte.id]["dianke"], 6)

    # ---------------- pedidos anteriores -------------------------------
    def test_pedidos_anteriores(self):
        Order = self.env["fsm.order"].with_user(self.u_a)
        loc = self.clientes["A1"]
        res = Order.shalom_pedidos_anteriores(loc.id)
        self.assertEqual(len(res), 3)
        # del más nuevo al más viejo
        self.assertEqual([r["total"] for r in res], [1500.0, 1200.0, 1600.0])
        self.assertEqual(res[0]["lineas"], [
            {"product_id": self.p_tinte.id, "nombre": self.p_tinte.display_name, "cantidad": 15.0}
        ])
        self.assertTrue(res[0]["fecha"])
        # límite
        self.assertEqual(len(Order.shalom_pedidos_anteriores(loc.id, limite=2)), 2)

    def test_pedidos_anteriores_filtros(self):
        """No salen: cotizaciones/canceladas, líneas $0, productos no
        vendibles, sin cliente, sin pedidos."""
        loc = self.clientes["N1"]
        self.assertEqual(self.env["fsm.order"].with_user(self.u_a).shalom_pedidos_anteriores(loc.id), [])
        self._crear_venta(loc.partner_id, 1, [(self.p_tinte, 1)], estado="draft")
        self._crear_venta(loc.partner_id, 1, [(self.p_tinte, 1)], estado="cancel")
        self.assertEqual(self.env["fsm.order"].with_user(self.u_a).shalom_pedidos_anteriores(loc.id), [])
        o = self._crear_venta(loc.partner_id, 1, [(self.p_tinte, 2), (self.p_nosale, 3), (self.p_barato, 1)])
        o.order_line.filtered(lambda l: l.product_id == self.p_barato).price_unit = 0
        res = self.env["fsm.order"].with_user(self.u_a).shalom_pedidos_anteriores(loc.id)
        self.assertEqual(len(res), 1)
        self.assertEqual([l["product_id"] for l in res[0]["lineas"]], [self.p_tinte.id])
        self.assertEqual(self.env["fsm.order"].with_user(self.u_a).shalom_pedidos_anteriores(99999999), [])
        self.assertEqual(self.env["fsm.order"].with_user(self.u_a).shalom_pedidos_anteriores(False), [])

    def test_pedidos_anteriores_historial_completo_sin_ver_todo(self):
        """Fix verificado: el vendedor con ventas "solo mis documentos"
        (regla Personal Orders) y el que tiene solo fsm_user obtienen el
        historial COMPLETO del cliente (sudo en el servidor)."""
        loc = self.clientes["A1"].id
        for user in (self.u_own, self.u_min, self.u_b):
            res = self.env["fsm.order"].with_user(user).shalom_pedidos_anteriores(loc)
            self.assertEqual(len(res), 3, user.login)
            self.assertEqual([r["total"] for r in res], [1500.0, 1200.0, 1600.0], user.login)

    def test_pedidos_anteriores_limite_acotado(self):
        loc = self.clientes["N2"]
        for i in range(25):
            self._crear_venta(loc.partner_id, i + 1, [(self.p_barato, 1)])
        Order = self.env["fsm.order"].with_user(self.u_a)
        self.assertEqual(len(Order.shalom_pedidos_anteriores(loc.id, limite=999)), 20)
        self.assertEqual(len(Order.shalom_pedidos_anteriores(loc.id, limite="abc")), 8)
        self.assertEqual(len(Order.shalom_pedidos_anteriores(loc.id, limite=0)), 8)
        self.assertEqual(len(Order.shalom_pedidos_anteriores(loc.id, limite=-5)), 1)

    def test_pedidos_anteriores_fecha_hora_panama(self):
        """Un pedido a las 02:00 UTC es del día anterior en Panamá."""
        from datetime import datetime
        loc = self.clientes["N1"]
        o = self._crear_venta(loc.partner_id, 1, [(self.p_barato, 1)])
        o.date_order = datetime(2026, 3, 10, 2, 0, 0)
        res = self.env["fsm.order"].with_user(self.u_a).shalom_pedidos_anteriores(loc.id)
        self.assertEqual(res[0]["fecha"], "2026-03-09")

    # ---------------- perfiles de ruta ---------------------------------
    def test_perfiles_ruta_clases(self):
        Order = self.env["fsm.order"].with_user(self.u_a)
        ids = [l.id for l in self.clientes.values()]
        perf = Order.shalom_perfiles_ruta(ids)
        self.assertEqual(set(perf), set(ids))
        clase = {k: perf[v.id]["clase"] for k, v in self.clientes.items()}
        for k in ("A1", "A2", "A3", "A4", "A5"):
            self.assertEqual(clase[k], "A", k)
        for k in ("A2_1", "A2_2", "A2_3"):
            self.assertEqual(clase[k], "A2", k)
        for k in ("B1", "B2", "B3", "B4"):
            self.assertEqual(clase[k], "B", k)
        for k in ("B2_1", "B2_2"):
            self.assertEqual(clase[k], "B2", k)
        for k in ("C1", "C2"):
            self.assertEqual(clase[k], "C", k)
        for k in ("N1", "N2"):
            self.assertEqual(clase[k], "NUEVO", k)
        self.assertEqual(clase["DIST"], "A")
        self.assertEqual(clase["RELLENO"], "A")
        # valores
        a1 = perf[self.clientes["A1"].id]
        self.assertEqual(a1["record"], 1600.0)
        self.assertAlmostEqual(a1["tipico"], (1500 + 1200 + 1600) / 3, places=2)
        self.assertAlmostEqual(a1["esperado"], round(a1["tipico"] * 0.81, 2), places=2)
        self.assertEqual(perf[self.clientes["N1"].id]["esperado"], 0.0)
        # el pedido de relleno (100 < 15% de 2000) no baja el típico
        rl = perf[self.clientes["RELLENO"].id]
        self.assertEqual(rl["record"], 2000.0)
        self.assertAlmostEqual(rl["tipico"], 1900.0, places=2)
        self.assertEqual(set(rl), {"clase", "esperado", "tipico", "record"})

    def test_perfiles_ruta_ids_invalidos(self):
        res = self.env["fsm.order"].with_user(self.u_a).shalom_perfiles_ruta([99999999])
        self.assertEqual(res, {})
        res = self.env["fsm.order"].with_user(self.u_a).shalom_perfiles_ruta([])
        self.assertEqual(res, {})

    # ---------------- ficha ---------------------------------------------
    def test_ficha_juego(self):
        Order = self.env["fsm.order"].with_user(self.u_a)
        f = Order.shalom_ficha_juego(self.clientes["A1"].id)
        self.assertEqual(set(f), {"refs", "clase", "esperado", "n"})
        self.assertEqual(f["n"], 3)
        self.assertEqual(f["clase"], "A")
        self.assertEqual(f["refs"]["record"], 1600.0)
        f = Order.shalom_ficha_juego(self.clientes["N1"].id)
        self.assertEqual((f["clase"], f["n"], f["esperado"]), ("NUEVO", 0, 0.0))
        f = Order.shalom_ficha_juego(99999999)
        self.assertEqual(f["clase"], "NUEVO")

    # ---------------- evaluar pedido ------------------------------------
    def test_evaluar_pedido_estrellas_y_costo(self):
        Order = self.env["fsm.order"].with_user(self.u_a)
        loc = self.clientes["A1"]   # típico 1433.33; t75 1075; record 1600
        casos = [
            (self.lineas((self.p_tinte, 5)), 0),     # 500
            (self.lineas((self.p_tinte, 11)), 1),    # 1100 >= 1075
            (self.lineas((self.p_tinte, 15)), 2),    # 1500 >= 1433.33
            (self.lineas((self.p_tinte, 17)), 3),    # 1700 > 1600 y margen 40%
        ]
        for lineas, esperadas in casos:
            res = Order.shalom_evaluar_pedido(loc.id, lineas)
            self.assertEqual(res["estrellas"], esperadas, res)
        # 17 oxigenta = 850 -> 0 estrellas; pero 40 oxigenta = 2000 > récord
        # con margen 10% -> NO oro (2 estrellas) y "siguiente" marca margen_bajo
        res = Order.shalom_evaluar_pedido(loc.id, self.lineas((self.p_oxi, 40)))
        self.assertEqual(res["total"], 2000.0)
        self.assertEqual(res["margen_pct"], 10.0)
        self.assertEqual(res["estrellas"], 2)
        self.assertTrue(res["siguiente"]["margen_bajo"])
        # oro: 3 estrellas -> siguiente None
        res = Order.shalom_evaluar_pedido(loc.id, self.lineas((self.p_tinte, 17)))
        self.assertIsNone(res["siguiente"])
        self.assertEqual(res["margen_pct"], 40.0)
        self.assertNotIn("utilidad", res)
        # el COSTO no sale por ninguna vía
        self.assertNotIn("costo", res)
        txt = json.dumps(res)
        self.assertNotIn("costo", txt)
        # costo total = 17*60 = 1020 y utilidad 680: ninguno debe aparecer
        self.assertNotIn("1020", txt)
        self.assertNotIn("680", txt)

    def test_evaluar_pedido_recompensa_y_cliente_nuevo(self):
        Order = self.env["fsm.order"].with_user(self.u_a)
        loc = self.clientes["A1"]
        lineas = self.lineas((self.p_tinte, 11)) + [
            {"product_id": self.p_tinte.id, "qty": 1, "es_recompensa": True, "regla_id": False}
        ]
        res = Order.shalom_evaluar_pedido(loc.id, lineas)
        # el regalo no suma a la venta pero sí al costo: 1100 vs costo 12*60=720
        # (margen 34.5%)
        self.assertEqual(res["total"], 1100.0)
        self.assertEqual(res["margen_pct"], 34.5)
        # cliente sin historial: 0 estrellas, sin siguiente
        res = Order.shalom_evaluar_pedido(self.clientes["N1"].id, self.lineas((self.p_tinte, 50)))
        self.assertEqual(res["estrellas"], 0)
        self.assertIsNone(res["siguiente"])
        # carrito vacío / ubicación inexistente
        res = Order.shalom_evaluar_pedido(99999999, [])
        self.assertEqual(res["total"], 0)
        res = Order.shalom_evaluar_pedido(loc.id, None)
        self.assertEqual(res["estrellas"], 0)

    def test_evaluar_pedido_historial_completo_sin_ver_todo(self):
        """Antes (502d9e8) el vendedor "solo mis documentos" veía la vara
        vacía (0 estrellas siempre). Con el fix ve la vara completa."""
        loc = self.clientes["A1"].id
        for user in (self.u_own, self.u_min):
            res = self.env["fsm.order"].with_user(user).shalom_evaluar_pedido(loc, self.lineas((self.p_tinte, 17)))
            self.assertEqual(res["refs"]["n"], 3, user.login)
            self.assertEqual(res["estrellas"], 3, user.login)

    def test_base_sin_impuestos(self):
        """El historial usa amount_untaxed (misma base que el medidor en
        vivo): un pedido con ITBMS 7% no infla la vara."""
        tax = self.env["account.tax"].create(
            {"name": "ITBMS 7 prueba", "amount": 7.0, "amount_type": "percent", "type_tax_use": "sale"}
        )
        loc = self.clientes["N1"]
        o = self._crear_venta(loc.partner_id, 3, [(self.p_tinte, 10)])
        o.order_line.write({"tax_id": [(6, 0, tax.ids)]})
        self.assertEqual(o.amount_untaxed, 1000.0)
        self.assertAlmostEqual(o.amount_total, 1070.0, places=2)
        f = self.env["fsm.order"].with_user(self.u_a).shalom_ficha_juego(loc.id)
        self.assertEqual(f["refs"]["record"], 1000.0)
