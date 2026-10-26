# -*- coding: utf-8 -*-
from odoo.exceptions import AccessError
from odoo.tests import tagged

from .common import ShalomCommon


@tagged("post_install", "-at_install", "shalom_harness")
class TestRegresionAdmin(ShalomCommon):
    def _carrito(self, clave, user):
        v = self.visitas[clave].with_user(user)
        v.shalom_actualizar_carrito(
            {"k1": {"product_id": self.p_tinte.id, "name": "Tinte", "list_price": 100.0, "cantidad": 2,
                    "es_recompensa": False, "regla_id": False}})
        return v

    def test_vendedor_nombre(self):
        v = self.visitas["A1"]
        self.assertEqual(v._shalom_vendedor_nombre(), "Persona A")          # dueño de la ruta
        v.x_cartera_person_id = self.per_b
        self.assertEqual(v._shalom_vendedor_nombre(), "Persona B")          # cartera manda
        self.clientes["A1"].fsm_route_id = False
        v.x_cartera_person_id = False
        v.invalidate_recordset()
        self.assertEqual(v._shalom_vendedor_nombre(), "")

    def test_seguimiento_visitas(self):
        Order = self.env["fsm.order"].with_user(self.u_mgr)
        cancelado = self.env.ref("fieldservice.fsm_stage_cancelled")
        v = self.visitas["B1"]
        v.write({"x_observaciones_visita": "no estaba", "x_cartera_person_id": self.per_b.id})
        v.write({"stage_id": cancelado.id})
        v2 = self.visitas["B2_1"]
        v2.write({"x_observaciones_visita": "no estaba", "stage_id": cancelado.id})
        res = Order.shalom_admin_seguimiento_visitas()
        por_cliente = {r["cliente_nombre"]: r for r in res}
        self.assertEqual(por_cliente["Cliente B1"]["vendedor_nombre"], "Persona B")   # cartera
        self.assertEqual(por_cliente["Cliente B2_1"]["vendedor_nombre"], "Persona A")  # ruta
        self.assertEqual(por_cliente["Cliente B1"]["observaciones"], "no estaba")
        self.assertEqual(por_cliente["Cliente B1"]["ruta_nombre"], "R1 prueba")
        pend = Order.shalom_admin_seguimiento_visitas(["pendiente"], route_id=self.ruta.id)
        self.assertEqual(len(pend), 18)
        self.assertEqual(Order.shalom_admin_seguimiento_visitas(["inexistente"]), [])
        with self.assertRaises(AccessError):
            self.env["fsm.order"].with_user(self.u_a).shalom_admin_seguimiento_visitas()

    def test_visitas_en_vivo_y_carritos_pendientes(self):
        Order = self.env["fsm.order"].with_user(self.u_mgr)
        v = self._carrito("A1", self.u_a)
        v.shalom_marcar_catalogo_abierto("tab-1")           # catálogo abierto AHORA
        w = self._carrito("A2", self.u_a)                     # carrito abandonado (sin heartbeat)
        w.x_cartera_person_id = self.per_b
        en_vivo = Order.shalom_admin_visitas_en_vivo()
        self.assertEqual([r["cliente_nombre"] for r in en_vivo], ["Cliente A1"])
        self.assertEqual(en_vivo[0]["vendedor_nombre"], "Persona A")
        self.assertEqual(set(en_vivo[0]), {"id", "cliente_nombre", "ruta_nombre", "vendedor_nombre"})
        pend = Order.shalom_admin_carritos_pendientes()
        self.assertEqual([r["cliente_nombre"] for r in pend], ["Cliente A2"])
        self.assertEqual(pend[0]["vendedor_nombre"], "Persona B")
        self.assertEqual((pend[0]["cantidad_items"], pend[0]["total"]), (2, 200.0))
        for user in (self.u_a, self.u_own):
            with self.assertRaises(AccessError):
                self.env["fsm.order"].with_user(user).shalom_admin_visitas_en_vivo()
            with self.assertRaises(AccessError):
                self.env["fsm.order"].with_user(user).shalom_admin_carritos_pendientes()

    def test_otras_apis_de_persona(self):
        P = self.env["fsm.person"]
        self.assertEqual([r["name"] for r in P.with_user(self.u_a).shalom_mis_rutas()], ["R1 prueba"])
        self.assertEqual(P.with_user(self.u_b).shalom_mis_rutas(), [])
        self.assertEqual([r["name"] for r in P.with_user(self.u_mgr).shalom_mis_rutas()], ["R1 prueba", "Visita Exprés"])  # gerente: todas
        self.assertEqual(len(P.with_user(self.u_a).shalom_mis_clientes()), 20)
        self.assertEqual(len(P.with_user(self.u_a).shalom_mis_cotizaciones()) > 0, True)
        adm = P.with_user(self.u_mgr).shalom_admin_rutas_programadas()
        self.assertEqual([a["persona_nombre"] for a in adm], ["Persona A"])
        with self.assertRaises(AccessError):
            P.with_user(self.u_a).shalom_admin_rutas_programadas()

    def test_otros_metodos_del_pedido(self):
        Order = self.env["fsm.order"].with_user(self.u_a)
        formas = Order.shalom_formas_pago_disponibles()
        self.assertEqual(len(formas), 8)
        self.assertEqual(formas[0], {"value": "efectivo", "label": "Efectivo"})
        self.assertEqual(Order.shalom_ultima_forma_pago_e_itbms(self.clientes["N1"].id),
                         {"payment_method": False, "includes_itbms": False})
        est = Order.shalom_estado_promociones_carrito(self.lineas((self.p_tinte, 2)))
        self.assertEqual(set(est), {"mensajes", "recompensas"})

    def test_borrador_pedido_no_registra_juego(self):
        """shalom_guardar_borrador_pedido (Revisar cotización) no cuenta
        para el juego: ni evento ni confirma."""
        n = self.env["shalom.juego.evento"].sudo().search_count([])
        v = self.visitas["A3"].with_user(self.u_a)
        accion = v.shalom_guardar_borrador_pedido(self.lineas((self.p_tinte, 3)))
        sale = self.env["sale.order"].browse(accion["res_id"])
        self.assertEqual(sale.state, "draft")
        self.assertEqual(self.env["shalom.juego.evento"].sudo().search_count([]), n)
