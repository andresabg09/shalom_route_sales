# -*- coding: utf-8 -*-
"""Clientes creados y editados sin señal (cola offline con ids provisorios):
el teléfono usa ids negativos para el cliente nuevo y su visita, y todo lo
que viene después (pedido, edición, GPS) se traduce a los ids reales."""
from odoo.tests import tagged

from .common import ShalomCommon


@tagged("post_install", "-at_install", "shalom_harness")
class TestClientesOffline(ShalomCommon):
    def setUp(self):
        super().setUp()
        # Como en producción: los vendedores ya crean y editan clientes desde
        # la app (permisos "Creación de contactos" y "Despachador" de Field
        # Service). La cola usa los mismos permisos que el camino de siempre.
        grupos = [self.env.ref("base.group_partner_manager"), self.env.ref("fieldservice.group_fsm_dispatcher")]
        for usuario in (self.u_a, self.u_b, self.u_mgr):
            usuario.write({"groups_id": [(4, g.id) for g in grupos]})

    def _lote(self, user, *eventos):
        return self.env["shalom.sync.evento"].with_user(user).shalom_procesar_lote(list(eventos))

    def _ev(self, uuid, tipo, **datos):
        return {"uuid": uuid, "tipo": tipo, "datos": datos, "creado_en": "2026-11-18T10:00:00.000Z"}

    def _alta(self, uuid="uuid-alta", tmp_loc=-101, tmp_ord=-201, **extra):
        datos = {
            "name": "Abarrotería Doña Luz", "street": "Vía principal", "mobile": "6612-3344",
            "route_id": self.ruta.id, "cliente_anterior_id": self.clientes["A1"].id,
            "tmp_location_id": tmp_loc, "tmp_order_id": tmp_ord,
            "lat": 8.95, "lng": -79.53,
        }
        datos.update(extra)
        return self._ev(uuid, "crear_cliente", **datos)

    def test_crear_cliente_y_pedido_en_el_mismo_envio(self):
        pedido = self._ev("uuid-pedido-nuevo", "confirmar_pedido", order_id=-201,
                          lineas=self.lineas((self.p_tinte, 2)), payment_method="efectivo")
        r_alta, r_pedido = self._lote(self.u_a, self._alta(), pedido)
        self.assertEqual(r_alta["estado"], "ok", r_alta)
        res = r_alta["resultado"]
        cliente = self.env["fsm.location"].browse(res["location_id"])
        self.assertEqual(cliente.name, "Abarrotería Doña Luz")
        self.assertEqual(cliente.fsm_route_id, self.ruta)
        self.assertEqual(cliente.x_orden_ruta, self.clientes["A1"].x_orden_ruta + 1, "va después de A1")
        visita = self.env["fsm.order"].browse(res["order_id"])
        self.assertTrue(visita.exists(), res)
        self.assertEqual(visita.x_route_schedule_id, self.ciclo)
        self.assertEqual(visita.location_id, cliente)
        self.assertEqual(res["schedule_id"], self.ciclo.id)
        # el pedido con el id provisorio de la visita cae en la visita real
        self.assertEqual(r_pedido["estado"], "ok", r_pedido)
        venta = self.env["sale.order"].browse(r_pedido["resultado"]["sale_order_id"])
        self.assertEqual(venta.partner_id, cliente.partner_id)
        self.assertEqual(r_pedido["resultado"]["total"], 200.0)

    def test_mismo_envio_dos_veces_un_solo_cliente(self):
        [r1] = self._lote(self.u_a, self._alta("uuid-alta-doble"))
        [r2] = self._lote(self.u_a, self._alta("uuid-alta-doble"))
        self.assertEqual(r1["estado"], "ok", r1)
        self.assertTrue(r2.get("repetido"))
        self.assertEqual(r1["resultado"]["location_id"], r2["resultado"]["location_id"])
        self.assertEqual(self.env["fsm.location"].search_count([("name", "=", "Abarrotería Doña Luz")]), 1)

    def test_editar_y_gps_del_cliente_nuevo_y_va_despues_de_otro_nuevo(self):
        primero = self._alta("uuid-alta-1", -11, -21, name="Primero Nuevo")
        segundo = self._alta("uuid-alta-2", -12, -22, name="Segundo Nuevo", cliente_anterior_id=-11)
        editar = self._ev("uuid-editar", "editar_cliente", location_id=-11,
                          valores={"name": "Primero Editado", "vat": "8-123-456", "nombre_contacto": "Luz"})
        gps = self._ev("uuid-gps-cli", "gps_cliente", location_id=-11, lat=9.1, lng=-79.9)
        r1, r2, r3, r4 = self._lote(self.u_a, primero, segundo, editar, gps)
        for r in (r1, r2, r3, r4):
            self.assertEqual(r["estado"], "ok", r)
        uno = self.env["fsm.location"].browse(r1["resultado"]["location_id"])
        dos = self.env["fsm.location"].browse(r2["resultado"]["location_id"])
        self.assertEqual(dos.x_orden_ruta, uno.x_orden_ruta + 1, "el segundo va después del primero (id provisorio)")
        self.assertEqual(uno.name, "Primero Editado")
        self.assertEqual(uno.partner_id.vat, "8-123-456")
        self.assertEqual(uno.partner_id.x_nombre_contacto, "Luz")
        self.assertAlmostEqual(uno.partner_latitude, 9.1)

    def test_editar_cliente_existente_sin_senal(self):
        cliente = self.clientes["B1"]
        [r] = self._lote(self.u_a, self._ev("uuid-editar-b1", "editar_cliente", location_id=cliente.id,
                                            valores={"phone": "222-3333", "street": "Nueva dirección",
                                                     "posicion": {"route_id": self.ruta.id, "cliente_anterior_id": False}}))
        self.assertEqual(r["estado"], "ok", r)
        self.assertEqual(cliente.phone, "222-3333")
        self.assertEqual(cliente.street, "Nueva dirección")
        self.assertEqual(cliente.x_orden_ruta, 1, "primero de la ruta")
        # nombre vacío: necesita atención, no se guarda
        [r] = self._lote(self.u_a, self._ev("uuid-editar-vacio", "editar_cliente", location_id=cliente.id, valores={"name": "  "}))
        self.assertEqual(r["estado"], "error")
        # la distribuidora solo la cambia el dueño
        self._lote(self.u_a, self._ev("uuid-dist-a", "editar_cliente", location_id=cliente.id, valores={"es_distribuidora": True}))
        self.assertFalse(cliente.x_es_distribuidora)
        self._lote(self.u_mgr, self._ev("uuid-dist-m", "editar_cliente", location_id=cliente.id, valores={"es_distribuidora": True}))
        self.assertTrue(cliente.x_es_distribuidora)

    def test_sin_ruta_o_alta_fallida_queda_en_atencion(self):
        [r] = self._lote(self.u_a, self._alta("uuid-sin-ruta", -31, -41, route_id=False))
        self.assertEqual(r["estado"], "error")
        self.assertIn("ruta", r["error"])
        # lo que depende de un alta fallida no se procesa
        pedido = self._ev("uuid-pedido-huerfano", "confirmar_pedido", order_id=-41,
                          lineas=self.lineas((self.p_tinte, 1)), payment_method="efectivo")
        [r] = self._lote(self.u_a, pedido)
        self.assertEqual(r["estado"], "error")
        self.assertIn("no se pudo crear", r["error"])
        # un id provisorio que nunca llegó
        [r] = self._lote(self.u_a, self._ev("uuid-nunca", "observacion", order_id=-999, texto="x"))
        self.assertEqual(r["estado"], "error")

    def test_otro_vendedor_no_resuelve_ids_ajenos(self):
        [r] = self._lote(self.u_a, self._alta("uuid-alta-a", -51, -61))
        self.assertEqual(r["estado"], "ok", r)
        [r] = self._lote(self.u_b, self._ev("uuid-b-nota", "observacion", order_id=-61, texto="hola"))
        self.assertEqual(r["estado"], "error")
        visita = self.env["fsm.order"].browse(self._lote(self.u_a, self._alta("uuid-alta-a", -51, -61))[0]["resultado"]["order_id"])
        self.assertNotEqual(visita.x_observaciones_visita, "hola")

    def test_lecturas_para_el_formulario_sin_senal(self):
        L = self.env["fsm.location"].with_user(self.u_a)
        fichas = L.shalom_fichas_cliente_form([self.clientes["A1"].id, self.clientes["B1"].id])
        ficha = fichas[self.clientes["A1"].id]
        self.assertEqual(ficha["name"], "Cliente A1")
        self.assertEqual(ficha["fsm_route_id"][0], self.ruta.id)
        self.assertIn("vat", ficha)
        por_ruta = L.shalom_clientes_de_rutas([self.ruta.id])
        nombres = [c["name"] for c in por_ruta[self.ruta.id]]
        self.assertEqual(nombres[0], "Cliente A1", "en el orden de la ruta")
        self.assertEqual(L.shalom_fichas_cliente_form("x"), {})

    def test_registro_no_guarda_la_foto(self):
        foto = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        [r] = self._lote(self.u_a, self._alta("uuid-foto", -71, -81, image_1920=foto))
        self.assertEqual(r["estado"], "ok", r)
        ev = self.env["shalom.sync.evento"].sudo().search([("uuid", "=", "uuid-foto")])
        self.assertIn("[foto]", ev.payload_json)
        self.assertNotIn(foto, ev.payload_json)
        cliente = self.env["fsm.location"].browse(r["resultado"]["location_id"])
        self.assertTrue(cliente.partner_id.image_1920)
