# -*- coding: utf-8 -*-
"""Modo offline: registro de carritos descartados (Fase 1) y cola de
salida idempotente (Fase 3)."""
import json
from datetime import timedelta

from odoo import fields
from odoo.exceptions import AccessError, UserError
from odoo.tests import HttpCase, tagged

from .common import ShalomCommon


@tagged("post_install", "-at_install", "shalom_harness")
class TestOffline(ShalomCommon):
    # ------------------------------------------------------------------
    def _carrito(self, *pares):
        return {
            str(p.id): {"product_id": p.id, "name": p.name, "list_price": p.list_price,
                        "cantidad": q, "es_recompensa": False, "regla_id": False}
            for p, q in pares
        }

    def _registros(self):
        return self.env["shalom.cotizacion.registro"].sudo().search([])

    def _lote(self, user, *eventos):
        return self.env["shalom.sync.evento"].with_user(user).shalom_procesar_lote(list(eventos))

    def _ev(self, uuid, tipo, **datos):
        return {"uuid": uuid, "tipo": tipo, "datos": datos, "creado_en": "2026-11-16T10:00:00.000Z"}

    # ------------------------------------------------------------------
    # Fase 1: registro de carritos descartados
    # ------------------------------------------------------------------
    def test_descartar_registra_copia_del_servidor(self):
        visita = self.visitas["A1"]
        visita.sudo().write({"x_carrito_borrador": json.dumps(self._carrito((self.p_tinte, 2), (self.p_oxi, 1)))})
        antes = len(self._registros())
        visita.with_user(self.u_a).shalom_limpiar_carrito()
        regs = self._registros()
        self.assertEqual(len(regs), antes + 1)
        reg = regs[0]
        self.assertEqual(reg.total, 250.0)
        self.assertEqual(reg.cantidad_items, 3)
        self.assertEqual(reg.order_id, visita)
        self.assertEqual(reg.user_id, self.u_a)
        self.assertTrue(reg.destacado)  # 250 >= 100
        visita.invalidate_recordset()
        self.assertFalse(visita.x_carrito_borrador)

    def test_descartar_prefiere_carrito_local_y_no_duplica_por_uuid(self):
        visita = self.visitas["A2"]
        visita.sudo().write({"x_carrito_borrador": json.dumps(self._carrito((self.p_tinte, 1)))})
        local = self._carrito((self.p_barato, 3))
        visita.with_user(self.u_a).shalom_limpiar_carrito(local, "uuid-desc-1")
        visita.with_user(self.u_a).shalom_limpiar_carrito(local, "uuid-desc-1")
        regs = self._registros().filtered(lambda r: r.uuid == "uuid-desc-1")
        self.assertEqual(len(regs), 1)
        self.assertEqual(regs.total, 60.0)
        self.assertFalse(regs.destacado)  # 60 < 100

    def test_carrito_vacio_no_registra(self):
        antes = len(self._registros())
        self.visitas["A3"].with_user(self.u_a).shalom_limpiar_carrito()
        self.assertEqual(len(self._registros()), antes)

    def test_umbral_configurable(self):
        self.env["ir.config_parameter"].sudo().set_param("shalom.registro_umbral_aviso", "1000")
        visita = self.visitas["A1"]
        visita.with_user(self.u_a).shalom_limpiar_carrito(self._carrito((self.p_tinte, 5)), "uuid-umbral")
        reg = self._registros().filtered(lambda r: r.uuid == "uuid-umbral")
        self.assertFalse(reg.destacado)

    def test_destacado_avisa_en_la_visita(self):
        visita = self.visitas["A1"]
        mensajes_antes = len(visita.message_ids)
        visita.with_user(self.u_a).shalom_limpiar_carrito(self._carrito((self.p_crema, 1)), "uuid-aviso")
        visita.invalidate_recordset()
        self.assertGreater(len(visita.message_ids), mensajes_antes)
        self.assertIn("Registro", visita.message_ids[0].body)
        self.assertIn(self.u_mgr.partner_id, visita.message_ids[0].partner_ids)

    def test_vendedor_no_ve_ni_restaura(self):
        with self.assertRaises(AccessError):
            self.env["shalom.cotizacion.registro"].with_user(self.u_a).shalom_admin_registro()

    def test_restaurar_al_carrito_si_la_visita_sigue_abierta(self):
        visita = self.visitas["A2"]
        visita.with_user(self.u_a).shalom_limpiar_carrito(self._carrito((self.p_tinte, 4)), "uuid-rest-1")
        Reg = self.env["shalom.cotizacion.registro"].with_user(self.u_mgr)
        lista = Reg.shalom_admin_registro()
        fila = next(f for f in lista if f["total"] == 400.0 and f["cliente_nombre"])
        self.assertTrue(fila["visita_abierta"])
        self.assertEqual(fila["lineas"][0]["cantidad"], 4)
        res = Reg.browse(fila["id"]).shalom_admin_restaurar()
        self.assertEqual(res["modo"], "carrito")
        visita.invalidate_recordset()
        carrito = json.loads(visita.x_carrito_borrador)
        self.assertEqual(carrito[str(self.p_tinte.id)]["cantidad"], 4)
        with self.assertRaises(UserError):
            Reg.browse(fila["id"]).shalom_admin_restaurar()

    def test_restaurar_como_cotizacion_si_la_visita_ya_cerro(self):
        visita = self.visitas["A3"]
        visita.with_user(self.u_a).shalom_limpiar_carrito(self._carrito((self.p_oxi, 2)), "uuid-rest-2")
        visita.sudo().with_context(bypass_order_completed_stage=True).write(
            {"stage_id": self.env.ref("fieldservice.fsm_stage_completed").id}
        )
        reg = self._registros().filtered(lambda r: r.uuid == "uuid-rest-2")
        res = reg.with_user(self.u_mgr).shalom_admin_restaurar()
        self.assertEqual(res["modo"], "cotizacion")
        venta = self.env["sale.order"].browse(res["sale_order_id"])
        self.assertEqual(venta.state, "draft")
        self.assertEqual(venta.order_line.product_id, self.p_oxi)
        self.assertEqual(venta.order_line.product_uom_qty, 2)
        self.assertEqual(venta.partner_id, self.clientes["A3"].partner_id)
        reg.invalidate_recordset()
        self.assertTrue(reg.restaurado)
        self.assertEqual(reg.sale_id, venta)

    def test_cron_borra_lo_de_mas_de_7_dias(self):
        Reg = self.env["shalom.cotizacion.registro"].sudo()
        viejo = Reg.create({"lineas_json": "{}", "fecha": fields.Datetime.now() - timedelta(days=8)})
        nuevo = Reg.create({"lineas_json": "{}", "fecha": fields.Datetime.now() - timedelta(days=6)})
        Reg._shalom_limpiar_registro_viejo()
        self.assertFalse(viejo.exists())
        self.assertTrue(nuevo.exists())

    # ------------------------------------------------------------------
    # Fase 3: cola de salida idempotente
    # ------------------------------------------------------------------
    def test_confirmar_por_la_cola_es_idempotente(self):
        visita = self.visitas["A1"]
        socio = self.clientes["A1"].partner_id
        ventas_antes = self.env["sale.order"].search_count([("partner_id", "=", socio.id)])
        ev = self._ev("uuid-conf-1", "confirmar_pedido", order_id=visita.id,
                      lineas=self.lineas((self.p_tinte, 3)), payment_method="efectivo",
                      special_delivery_date=False, includes_itbms=False)
        [r1] = self._lote(self.u_a, ev)
        self.assertEqual(r1["estado"], "ok", r1)
        self.assertEqual(r1["resultado"]["total"], 300.0)
        [r2] = self._lote(self.u_a, ev)
        self.assertEqual(r2["estado"], "ok")
        self.assertTrue(r2.get("repetido"))
        self.assertEqual(r2["resultado"]["sale_order_id"], r1["resultado"]["sale_order_id"])
        self.assertEqual(
            self.env["sale.order"].search_count([("partner_id", "=", socio.id)]), ventas_antes + 1
        )
        venta = self.env["sale.order"].browse(r1["resultado"]["sale_order_id"])
        self.assertEqual(venta.state, "sale")
        visita.invalidate_recordset()
        self.assertTrue(visita.stage_id.is_closed)

    def test_precio_de_la_visita_se_respeta_si_cambio(self):
        visita = self.visitas["A2"]
        lineas = self.lineas((self.p_tinte, 1), (self.p_oxi, 1))
        lineas[0]["precio_visita"] = 90.0    # el tinte hoy vale 100: cambió
        lineas[1]["precio_visita"] = 50.0    # la oxigenta sigue a 50
        [r] = self._lote(self.u_a, self._ev("uuid-precio", "confirmar_pedido", order_id=visita.id,
                                            lineas=lineas, payment_method="efectivo"))
        self.assertEqual(r["estado"], "ok", r)
        venta = self.env["sale.order"].browse(r["resultado"]["sale_order_id"])
        por_producto = {l.product_id: l.price_unit for l in venta.order_line}
        self.assertEqual(por_producto[self.p_tinte], 90.0)
        self.assertEqual(por_producto[self.p_oxi], 50.0)
        self.assertEqual(len(r["resultado"]["precios_cambiados"]), 1)
        evento = self.env["shalom.sync.evento"].sudo().search([("uuid", "=", "uuid-precio")])
        self.assertTrue(evento.precio_cambiado)
        avisos = self.env["shalom.sync.evento"].with_user(self.u_mgr).shalom_admin_envios_con_aviso()
        self.assertTrue(any(a["precios_cambiados"] for a in avisos))

    def test_en_linea_sin_precio_visita_no_cambia_nada(self):
        visita = self.visitas["A3"]
        res = visita.with_user(self.u_a).shalom_confirmar_pedido(
            self.lineas((self.p_tinte, 1)), "efectivo", False, False
        )
        self.assertEqual(res["precios_cambiados"], [])

    def test_error_de_negocio_queda_para_atencion_y_se_puede_reintentar(self):
        visita = self.visitas["A3"]
        cancelado = self.env.ref("fieldservice.fsm_stage_cancelled").id
        ev_cancelar = self._ev("uuid-cancel", "cambiar_etapa", order_id=visita.id, stage_id=cancelado)
        [r] = self._lote(self.u_a, ev_cancelar)
        self.assertEqual(r["estado"], "error", r)
        self.assertTrue(r["error"])
        evento = self.env["shalom.sync.evento"].sudo().search([("uuid", "=", "uuid-cancel")])
        self.assertEqual(evento.estado, "error")
        # el vendedor escribe la nota y reintenta: mismo uuid, ahora pasa
        res = self._lote(
            self.u_a,
            self._ev("uuid-nota", "observacion", order_id=visita.id, texto="Local cerrado"),
            ev_cancelar,
        )
        self.assertEqual([x["estado"] for x in res], ["ok", "ok"], res)
        visita.invalidate_recordset()
        self.assertEqual(visita.stage_id.id, cancelado)
        evento.invalidate_recordset()
        self.assertEqual(evento.estado, "ok")
        self.assertEqual(evento.intentos, 2)

    def test_un_error_no_deshace_lo_demas_del_lote(self):
        visita = self.visitas["A2"]
        cancelado = self.env.ref("fieldservice.fsm_stage_cancelled").id
        res = self._lote(
            self.u_a,
            self._ev("uuid-l1", "observacion", order_id=visita.id, texto=""),
            self._ev("uuid-l2", "cambiar_etapa", order_id=visita.id, stage_id=cancelado),
            self._ev("uuid-l3", "observacion", order_id=visita.id, texto="Volver el lunes"),
        )
        self.assertEqual([x["estado"] for x in res], ["ok", "error", "ok"], res)
        visita.invalidate_recordset()
        self.assertEqual(visita.x_observaciones_visita, "Volver el lunes")
        self.assertFalse(visita.stage_id.is_closed)

    def test_gps_por_la_cola(self):
        # (en el arnés ni el vendedor ni el gerente de prueba pueden escribir
        # contactos, tampoco en línea: action_capturar_gps toca el partner.
        # Se prueba con el usuario del entorno de tests.)
        visita = self.visitas["A2"]
        [r] = self.env["shalom.sync.evento"].shalom_procesar_lote(
            [self._ev("uuid-gps", "gps", order_id=visita.id, lat=9.0, lng=-79.5)]
        )
        self.assertEqual(r["estado"], "ok", r)
        visita.invalidate_recordset()
        self.assertAlmostEqual(visita.x_gps_capturado_lat, 9.0)

    def test_tipo_desconocido_y_visita_inexistente(self):
        res = self._lote(
            self.u_a,
            self._ev("uuid-x1", "borrar_todo", order_id=self.visitas["A1"].id),
            self._ev("uuid-x2", "observacion", order_id=999999, texto="x"),
        )
        self.assertEqual(res[0]["estado"], "error")
        self.assertTrue(res[0].get("permanente"))
        self.assertEqual(res[1]["estado"], "error")

    def test_descartar_por_la_cola_registra_una_vez(self):
        visita = self.visitas["A1"]
        ev = self._ev("uuid-desc-cola", "descartar_carrito", order_id=visita.id,
                      carrito=self._carrito((self.p_crema, 1)))
        self._lote(self.u_a, ev)
        self._lote(self.u_a, ev)
        regs = self._registros().filtered(lambda r: r.uuid == "uuid-desc-cola")
        self.assertEqual(len(regs), 1)

    def test_guardar_borrador_por_la_cola(self):
        visita = self.visitas["A2"]
        [r] = self._lote(self.u_a, self._ev("uuid-borr", "guardar_borrador", order_id=visita.id,
                                            lineas=self.lineas((self.p_barato, 2))))
        self.assertEqual(r["estado"], "ok", r)
        venta = self.env["sale.order"].browse(r["resultado"]["sale_order_id"])
        self.assertEqual(venta.state, "draft")
        self.assertEqual(r["resultado"]["sale_order_name"], venta.name)

    def test_ping_y_limpieza(self):
        self.assertEqual(self.env["shalom.sync.evento"].with_user(self.u_a).shalom_ping(), {"ok": True})
        Libro = self.env["shalom.sync.evento"].sudo()
        viejo = Libro.create({"uuid": "viejo", "tipo": "gps", "estado": "ok",
                              "recibido_en": fields.Datetime.now() - timedelta(days=31)})
        Libro._shalom_limpiar_sync_viejo()
        self.assertFalse(viejo.exists())

    # ------------------------------------------------------------------
    # Fase 2: paquete offline de una ruta ("Preparar mi día")
    # ------------------------------------------------------------------
    def test_paquete_offline_igual_que_las_pantallas(self):
        Ciclo = self.env["fsm.route.schedule"].with_user(self.u_a)
        paquete = Ciclo.shalom_paquete_offline(self.ciclo.id)
        visita = self.visitas["A1"].with_user(self.u_a)
        pieza = paquete["visitas"][visita.id]
        directo = visita.read([
            "location_id", "x_cliente_orden_ruta", "stage_name", "x_observaciones_visita",
            "x_cliente_lat", "x_cliente_lng", "sale_id",
        ])[0]
        self.assertEqual(pieza["orden"], directo)
        self.assertEqual(pieza["datosFaltantes"], visita.shalom_campos_cliente_faltantes())
        loc_id = directo["location_id"][0]
        Orden = self.env["fsm.order"].with_user(self.u_a)
        self.assertEqual(paquete["pedidos"][loc_id], Orden.shalom_pedidos_anteriores(loc_id))
        self.assertEqual(paquete["fichas"][loc_id], Orden.shalom_ficha_juego(loc_id))
        self.assertEqual(paquete["ultima_fp"][loc_id], Orden.shalom_ultima_forma_pago_e_itbms(loc_id))
        self.assertEqual(len(paquete["visitas"]), len(self.visitas))
        self.assertEqual(Ciclo.shalom_paquete_offline(999999)["visitas"], {})


    # ------------------------------------------------------------------
    # Ajustes: versión estable de las fotos del catálogo
    # ------------------------------------------------------------------
    def test_marcas_fotos_cambian_solo_si_cambia_el_producto(self):
        Orden = self.env["fsm.order"].with_user(self.u_a)
        antes = Orden.shalom_marcas_fotos([self.p_tinte.id, self.p_oxi.id])
        self.assertEqual(set(antes), {self.p_tinte.id, self.p_oxi.id})
        self.assertRegex(antes[self.p_tinte.id], r"^\d{14}$")
        self.assertEqual(Orden.shalom_marcas_fotos([self.p_tinte.id]), {self.p_tinte.id: antes[self.p_tinte.id]})
        # cambia la plantilla (donde suele estar la foto): cambia la marca
        self.env.cr.execute(
            "UPDATE product_template SET write_date = write_date + interval '1 day' WHERE id = %s",
            (self.p_tinte.product_tmpl_id.id,),
        )
        self.p_tinte.product_tmpl_id.invalidate_recordset(["write_date"])
        despues = Orden.shalom_marcas_fotos([self.p_tinte.id, self.p_oxi.id])
        self.assertGreater(despues[self.p_tinte.id], antes[self.p_tinte.id])
        self.assertEqual(despues[self.p_oxi.id], antes[self.p_oxi.id])
        self.assertEqual(Orden.shalom_marcas_fotos([]), {})


@tagged("post_install", "-at_install", "shalom_harness")
class TestPaginaOffline(HttpCase):
    def test_service_worker_lleva_la_marca_y_lo_de_odoo(self):
        respuesta = self.url_open("/web/service-worker.js")
        self.assertEqual(respuesta.status_code, 200)
        self.assertIn("shalom-offline-1", respuesta.text)
        self.assertIn("/odoo/offline", respuesta.text)  # el de Odoo sigue intacto
        pagina = self.url_open("/odoo/offline")
        self.assertIn("Sin señal", pagina.text)
        self.assertIn("Preparar mi día", pagina.text)
        self.assertNotIn("You are offline", pagina.text)

