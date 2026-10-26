# -*- coding: utf-8 -*-
"""Fase 7: vista del gerente (shalom_gerente.py) en un Odoo real.

Los valores esperados se calculan a mano con juego_utils sobre el
escenario sintético de common.py:

    A (x5):   pedidos 1500/1200/1600 -> típico 1433.33 x 0.81 = 1161.00 c/u
    A2 (x3):  1000/800 al 10% -> típico 900 x 0.92 = 828.00 c/u
    B (x4):   100/80 -> típico 90 x 0.89 = 80.10 c/u
    B2 (x2):  100 al 10% -> típico 100 x 0.89 = 89.00 c/u
    RELLENO:  2000/1800/100 (el de 100 es relleno) -> típico 1900 x 0.81 = 1539.00
    DIST, C1, C2, N1, N2: no cuentan
"""
from datetime import datetime, timedelta

from odoo import fields
from odoo.exceptions import AccessError, UserError
from odoo.tests import tagged

from .common import ShalomCommon

# valor esperado mensual de la ruta R1 (clientes buenos que no son distribuidora)
VALOR_R1 = 5 * 1161.00 + 3 * 828.00 + 4 * 80.10 + 2 * 89.00 + 1539.00   # 10326.40
CLIENTES_BUENOS_R1 = 5 + 3 + 4 + 2 + 1                                    # 15


@tagged("post_install", "-at_install", "shalom_harness")
class TestGerente(ShalomCommon):
    # ------------------------------------------------------------------
    # utilidades
    # ------------------------------------------------------------------
    def _R(self, user=None):
        return self.env["fsm.route"].with_user(user or self.u_mgr)

    def _ubicacion(self, nombre, ruta=None, pedidos=(), distribuidora=False, con_gps=False, phone=False):
        loc = self.env["fsm.location"].create({
            "name": nombre,
            "fsm_route_id": ruta.id if ruta else False,
            "x_es_distribuidora": distribuidora,
            "partner_latitude": 8.95 if con_gps else 0.0,
            "partner_longitude": -79.5 if con_gps else 0.0,
            "phone": phone,
        })
        for dias, lineas in pedidos:
            self._crear_venta(loc.partner_id, dias, lineas)
        return loc

    def _ruta_en(self, resultado, ruta_id):
        for v in resultado["vendedores"]:
            for r in v["rutas"]:
                if r["id"] == ruta_id:
                    return v, r
        return None, None

    # ------------------------------------------------------------------
    # permisos: ningún método admin es para el vendedor
    # ------------------------------------------------------------------
    def test_permisos_solo_gerente(self):
        for user in (self.u_a, self.u_b, self.u_c, self.u_min, self.u_own):
            R = self._R(user)
            with self.assertRaises(AccessError, msg=user.login):
                R.shalom_admin_reasignar_ruta(self.ruta.id, self.per_b.id)
            with self.assertRaises(AccessError, msg=user.login):
                R.shalom_admin_reasignar_ruta(self.ruta.id, self.per_b.id, True)
            with self.assertRaises(AccessError, msg=user.login):
                R.shalom_admin_reparto_rutas()
            with self.assertRaises(AccessError, msg=user.login):
                R.shalom_admin_gerente_mes()
            with self.assertRaises(AccessError, msg=user.login):
                R.shalom_admin_salud_datos()
        # nada cambió
        self.assertEqual(self.ruta.fsm_person_id, self.per_a)
        # el gerente sí puede leer todo
        self._R().shalom_admin_reparto_rutas()
        self._R().shalom_admin_gerente_mes()
        self._R().shalom_admin_salud_datos()

    # ------------------------------------------------------------------
    # reasignar ruta
    # ------------------------------------------------------------------
    def test_reasignar_abiertas_si_cerradas_no_y_cartera_limpia(self):
        cancelado = self.env.ref("fieldservice.fsm_stage_cancelled")
        # 1) reparto de cartera (A y B) y una visita ya cerrada
        self.env["fsm.route.schedule"].with_user(self.u_mgr).shalom_admin_repartir_cartera(
            self.ciclo.id, [self.per_a.id, self.per_b.id])
        con_cartera = self.env["fsm.order"].search(
            [("x_route_schedule_id", "=", self.ciclo.id), ("x_cartera_person_id", "!=", False)])
        self.assertTrue(con_cartera)
        cerrada = self.visitas["A1"]
        cerrada.write({"stage_id": cancelado.id})
        self.assertTrue(cerrada.stage_id.is_closed)
        cartera_cerrada = (cerrada.x_cartera_person_id, cerrada.x_cartera_orden)
        # 2) una visita abierta asignada a mano a otro vendedor (C): se respeta
        de_otro = self.visitas["B1"]
        de_otro._write({"person_id": self.per_c.id})        # sin write(): evita la ruta del día de OCA
        de_otro.invalidate_recordset(["person_id"])
        abiertas = self.visitas["A2_1"].search(
            [("x_route_schedule_id", "=", self.ciclo.id), ("stage_id.is_closed", "=", False)])
        self.assertEqual(len(abiertas), 19)       # 20 clientes - 1 cerrada
        pasan = abiertas.filtered(lambda v: v.person_id == self.per_a)
        self.assertEqual(len(pasan), 18)          # todas menos la de C
        n_con_cartera_abiertas = len(abiertas.filtered("x_cartera_person_id"))
        total_visitas = self.env["fsm.order"].with_context(active_test=False).search_count(
            [("x_route_schedule_id", "=", self.ciclo.id)])

        # --- vista previa: no escribe nada ---------------------------------
        previa = self._R().shalom_admin_reasignar_ruta(self.ruta.id, self.per_b.id, True)
        self.assertTrue(previa["simulado"])
        self.assertEqual(self.ruta.fsm_person_id, self.per_a)
        self.assertEqual(previa["visitas_pasadas"], 18)
        self.assertEqual(previa["visitas_de_otro"], 1)
        self.assertEqual(previa["visitas_abiertas"], 19)
        self.assertEqual(previa["visitas_cerradas_intactas"], 1)
        self.assertEqual(previa["cartera_limpiada"], n_con_cartera_abiertas)
        self.assertEqual(len(previa["ciclos_con_cartera"]), 1)
        self.assertEqual(previa["anterior"]["nombre"], "Persona A")
        self.assertEqual(previa["nuevo"]["nombre"], "Persona B")
        self.assertEqual(set(abiertas.mapped("person_id")), {self.per_a, self.per_c})

        # --- reasignación real ------------------------------------------------
        res = self._R().shalom_admin_reasignar_ruta(self.ruta.id, self.per_b.id)
        self.assertFalse(res["simulado"])
        self.assertEqual(res["visitas_pasadas"], 18)
        self.assertEqual(self.ruta.fsm_person_id, self.per_b)
        abiertas.invalidate_recordset()
        for v in abiertas:
            if v == de_otro:
                self.assertEqual(v.person_id, self.per_c)       # la de otro no se toca
            else:
                self.assertEqual(v.person_id, self.per_b, v.name)
            # cartera limpiada en TODAS las abiertas
            self.assertFalse(v.x_cartera_person_id, v.name)
            self.assertFalse(v.x_cartera_fecha)
            self.assertEqual(v.x_cartera_orden, 0)
            self.assertFalse(v.x_cartera_reserva)
        # la cerrada sigue intacta: mismo vendedor, misma cartera
        cerrada.invalidate_recordset()
        self.assertEqual(cerrada.person_id, self.per_a)
        self.assertEqual((cerrada.x_cartera_person_id, cerrada.x_cartera_orden), cartera_cerrada)
        # nada se archivó ni se creó ni se borró
        self.assertEqual(
            self.env["fsm.order"].with_context(active_test=False).search_count(
                [("x_route_schedule_id", "=", self.ciclo.id)]), total_visitas)
        self.assertTrue(all(v.active for v in abiertas))
        # y el ciclo cambia de dueño en la app: B lo ve, A ya no
        hoy = fields.Date.to_string(self.hoy)
        fin = fields.Date.to_string(self.hoy + timedelta(days=6))
        vistas_b = self.env["fsm.person"].with_user(self.u_b).shalom_mis_rutas_programadas(hoy, fin)
        vistas_a = self.env["fsm.person"].with_user(self.u_a).shalom_mis_rutas_programadas(hoy, fin)
        self.assertIn(self.ciclo.id, [s["id"] for s in vistas_b])
        # A todavía lo ve SOLO porque la visita cerrada conserva su cartera (no se toca);
        # sin cartera de por medio, ver test_reparto_tras_reasignar.
        self.assertIn(self.ciclo.id, [s["id"] for s in vistas_a])

    def test_reasignar_suelta_la_ruta_del_dia(self):
        """Con la ruta corriendo todos los días, un write() de person_id arma
        una ruta del día (fsm.route.dayroute) de OCA. Al reasignar, la visita
        se suelta de ella y la ruta del día que queda vacía se borra."""
        self.ruta.write({"day_ids": [(6, 0, self.env["fsm.route.day"].search([]).ids)]})
        v = self.visitas["A1"]
        v.write({"person_id": self.per_a.id})
        dayroute = v.dayroute_id
        self.assertTrue(dayroute)
        self._R().shalom_admin_reasignar_ruta(self.ruta.id, self.per_b.id)
        v.invalidate_recordset()
        self.assertEqual(v.person_id, self.per_b)
        self.assertFalse(v.dayroute_id)
        self.assertFalse(dayroute.exists())

    def test_reasignar_rechaza_express_igual_ausente_y_vacios(self):
        express = self.env["fsm.route"].create({
            "name": "Exprés prueba", "x_es_visita_express": True, "fsm_person_id": self.per_a.id})
        with self.assertRaises(UserError):
            self._R().shalom_admin_reasignar_ruta(express.id, self.per_b.id)
        self.assertEqual(express.fsm_person_id, self.per_a)
        with self.assertRaises(UserError):                      # ya es de A
            self._R().shalom_admin_reasignar_ruta(self.ruta.id, self.per_a.id)
        with self.assertRaises(UserError):                      # ruta inexistente
            self._R().shalom_admin_reasignar_ruta(999999, self.per_a.id)
        with self.assertRaises(UserError):                      # vendedor inexistente
            self._R().shalom_admin_reasignar_ruta(self.ruta.id, 999999)
        self.assertEqual(self.ruta.fsm_person_id, self.per_a)
        self.assertTrue(all(v.person_id == self.per_a for v in self.visitas.values()))

    def test_reasignar_ruta_sin_dueno(self):
        sin = self.env["fsm.route"].create({"name": "Sin dueño"})
        loc = self._ubicacion("Cliente sin dueño", sin)
        sin.action_generar_visitas_ruta()
        visita = self.env["fsm.order"].search([("location_id", "=", loc.id)])
        self.assertEqual(len(visita), 1)
        self.assertFalse(visita.person_id)
        res = self._R().shalom_admin_reasignar_ruta(sin.id, self.per_b.id)
        self.assertIsNone(res["anterior"])
        self.assertEqual(res["visitas_pasadas"], 1)
        self.assertEqual(sin.fsm_person_id, self.per_b)
        self.assertEqual(visita.person_id, self.per_b)

    # ------------------------------------------------------------------
    # reparto de rutas
    # ------------------------------------------------------------------
    def test_reparto_valores_esperados(self):
        res = self._R().shalom_admin_reparto_rutas()
        vendedor, ruta = self._ruta_en(res, self.ruta.id)
        self.assertEqual(vendedor["persona_nombre"], "Persona A")
        self.assertAlmostEqual(ruta["valor"], VALOR_R1, places=2)
        self.assertEqual(ruta["clientes"], CLIENTES_BUENOS_R1)
        self.assertAlmostEqual(ruta["dias"], round(VALOR_R1 / 2000.0, 1), places=1)
        self.assertAlmostEqual(vendedor["valor_mes"], VALOR_R1, places=2)
        self.assertEqual(res["por_dia"], 2000.0)
        # distribuidora, dormidos y nuevos no suman: el valor coincide con el perfil real
        locs = self.env["fsm.location"].search([("fsm_route_id", "=", self.ruta.id)])
        perfiles = self.env["fsm.order"]._shalom_perfiles_clientes(locs)
        esperado = sum(
            perfiles[loc.id]["esperado"] for loc in locs
            if not loc.x_es_distribuidora and perfiles[loc.id]["clase"] in ("A", "A2", "B", "B2"))
        self.assertAlmostEqual(ruta["valor"], esperado, places=2)
        # todos los vendedores posibles para "Pasar a…"
        nombres = {p["name"] for p in res["personas"]}
        self.assertTrue({"Persona A", "Persona B", "Persona C"} <= nombres)

    def test_reparto_sin_dueno_sin_ventas_sin_ruta_y_express(self):
        r_sin_dueno = self.env["fsm.route"].create({"name": "R sin dueño"})
        self._ubicacion("Cliente B nuevo", r_sin_dueno, pedidos=[(10, [(self.p_barato, 5)])])     # B: 100 -> 89
        r_sin_ventas = self.env["fsm.route"].create({"name": "R sin ventas", "fsm_person_id": self.per_b.id})
        self._ubicacion("Cliente nuevo", r_sin_ventas)                                               # NUEVO
        self.env["fsm.route"].create(
            {"name": "Exprés X", "x_es_visita_express": True, "fsm_person_id": self.per_c.id})
        # cliente bueno SIN ruta: A, 500 al 75% -> típico 500 x 0.81 = 405
        self._ubicacion("Cliente sin ruta", None, pedidos=[(10, [(self.p_barato, 25)])])
        res = self._R().shalom_admin_reparto_rutas()
        aparte = {r["name"]: r for r in res["sin_dueno_o_ventas"]}
        self.assertEqual(aparte["R sin dueño"]["motivo"], "sin_dueno")
        self.assertAlmostEqual(aparte["R sin dueño"]["valor"], 89.0, places=2)
        self.assertEqual(aparte["R sin ventas"]["motivo"], "sin_ventas")
        self.assertEqual(aparte["R sin ventas"]["valor"], 0)
        self.assertEqual(aparte["R sin ventas"]["persona_nombre"], "Persona B")
        # esas rutas no cuentan en el valor de nadie, y Exprés no aparece en ningún lado
        todos = [r["name"] for v in res["vendedores"] for r in v["rutas"]] + list(aparte)
        self.assertNotIn("Exprés X", todos)
        self.assertEqual({v["persona_nombre"] for v in res["vendedores"]}, {"Persona A"})
        self.assertEqual(res["sin_ruta"]["clientes"], 1)
        self.assertAlmostEqual(res["sin_ruta"]["valor"], 405.0, places=2)
        self.assertEqual(res["sin_ruta"]["top"][0]["name"], "Cliente sin ruta")
        self.assertEqual(res["sin_ruta"]["top"][0]["clase"], "A")

    def test_reparto_tras_reasignar(self):
        self._R().shalom_admin_reasignar_ruta(self.ruta.id, self.per_c.id)
        res = self._R().shalom_admin_reparto_rutas()
        vendedor, _ruta = self._ruta_en(res, self.ruta.id)
        self.assertEqual(vendedor["persona_nombre"], "Persona C")
        # y en la app del vendedor: C ve el ciclo; A (sin cartera de por medio) ya no
        hoy = fields.Date.to_string(self.hoy)
        fin = fields.Date.to_string(self.hoy + timedelta(days=6))
        P = self.env["fsm.person"]
        self.assertIn(self.ciclo.id, [x["id"] for x in P.with_user(self.u_c).shalom_mis_rutas_programadas(hoy, fin)])
        self.assertNotIn(self.ciclo.id, [x["id"] for x in P.with_user(self.u_a).shalom_mis_rutas_programadas(hoy, fin)])

    # ------------------------------------------------------------------
    # cómo va el mes
    # ------------------------------------------------------------------
    def _aislar_mes(self):
        """Mueve todos los pedidos del escenario a 2020 para que el mes en
        curso solo tenga los que crea cada prueba."""
        self.env.flush_all()
        self.env.cr.execute("UPDATE sale_order SET date_order = %s", [datetime(2020, 1, 15, 12, 0)])
        self.env.invalidate_all()

    def test_mes_ventas_margen_y_oxigenta(self):
        self._aislar_mes()
        socio = self.clientes["A1"].partner_id
        # P1: 10 tintes + 2 oxigenta + 1 crema ; P2: 30 tintes ; P3: 10 tintes + 3 oxigenta
        self._crear_venta(socio, 0, [(self.p_tinte, 10), (self.p_oxi, 2), (self.p_crema, 1)])
        self._crear_venta(socio, 0, [(self.p_tinte, 30)])
        self._crear_venta(socio, 0, [(self.p_tinte, 10), (self.p_oxi, 3)])
        # no cuentan: borrador, cancelado, y de otro mes
        self._crear_venta(socio, 0, [(self.p_tinte, 100), (self.p_oxi, 100)], estado="draft")
        self._crear_venta(socio, 0, [(self.p_tinte, 100), (self.p_oxi, 100)], estado="cancel")
        self._crear_venta(socio, 60, [(self.p_tinte, 100), (self.p_oxi, 100)])
        res = self._R().shalom_admin_gerente_mes()
        # ventas sin impuestos: 1300 + 3000 + 1150
        self.assertEqual(res["pedidos"], 3)
        self.assertAlmostEqual(res["ventas"], 5450.0, places=2)
        # utilidad: (400+10+80) + 1200 + (400+15)
        self.assertAlmostEqual(res["utilidad"], 2105.0, places=2)
        self.assertAlmostEqual(res["costo"], 5450.0 - 2105.0, places=2)
        self.assertAlmostEqual(res["margen_pct"], 38.6, places=1)
        # piso y meta por defecto
        self.assertEqual((res["piso"], res["meta"]), (60000.0, 80000.0))
        self.assertAlmostEqual(res["pct_piso"], 9.1, places=1)
        self.assertAlmostEqual(res["pct_meta"], 6.8, places=1)
        self.assertAlmostEqual(res["falta_piso"], 60000.0 - 5450.0, places=2)
        # oxigenta por 100 tintes: 5 oxigentas / 50 tintes
        ox = res["oxigenta"]
        self.assertEqual((ox["tintes"], ox["oxigenta"]), (50, 5))
        self.assertEqual(ox["por_100"], 10.0)
        self.assertEqual(ox["pedidos_con_oxigenta"], 2)
        self.assertEqual(ox["por_100_en_pedidos_con_oxigenta"], 25.0)     # 5 / 20 tintes
        # el margen del año incluye ADEMÁS el pedido de hace 60 días (este año): ventas
        # 5450 + 15000, utilidad 2105 + 4500 (100 tintes a 40 y 100 oxigenta a 5)
        self.assertAlmostEqual(res["margen_anio_pct"], round(6605 * 100.0 / 20450, 1), places=1)

    def test_mes_piso_y_meta_configurables(self):
        self._aislar_mes()
        self._crear_venta(self.clientes["A1"].partner_id, 0, [(self.p_tinte, 50)])     # 5000
        P = self.env["ir.config_parameter"].sudo()
        P.set_param("shalom.juego.piso_mes", "4000")
        P.set_param("shalom.juego.meta_mes", "10000")
        res = self._R().shalom_admin_gerente_mes()
        self.assertEqual((res["piso"], res["meta"]), (4000.0, 10000.0))
        self.assertEqual(res["pct_piso"], 125.0)
        self.assertEqual(res["falta_piso"], 0)
        self.assertEqual(res["pct_meta"], 50.0)
        self.assertEqual(res["falta_meta"], 5000.0)
        # parámetro dañado -> vuelve al valor por defecto
        P.set_param("shalom.juego.piso_mes", "no es un número")
        self.assertEqual(self._R().shalom_admin_gerente_mes()["piso"], 60000.0)

    def test_mes_sin_tintes_y_sin_ventas(self):
        self._aislar_mes()
        res = self._R().shalom_admin_gerente_mes()
        self.assertEqual((res["pedidos"], res["ventas"]), (0, 0))
        self.assertIsNone(res["oxigenta"]["por_100"])
        self.assertIsNone(res["margen_pct"])
        self.assertEqual(res["vendedores"], [])
        self._crear_venta(self.clientes["A1"].partner_id, 0, [(self.p_oxi, 4)])
        res = self._R().shalom_admin_gerente_mes()
        self.assertIsNone(res["oxigenta"]["por_100"])               # sin tintes no hay razón
        self.assertEqual(res["oxigenta"]["oxigenta"], 4)

    def test_mes_estrellas_y_xp_por_vendedor(self):
        self._aislar_mes()
        Evento = self.env["shalom.juego.evento"]
        ahora = fields.Datetime.now()
        datos = [
            (self.per_a, 3, 300, 1000.0), (self.per_a, 1, 80, 200.0),
            (self.per_b, 2, 150, 500.0),
        ]
        for persona, est, xp, total in datos:
            Evento.create({"person_id": persona.id, "fecha": ahora, "estrellas": est, "xp": xp, "total": total})
        # evento del mes pasado: no cuenta
        Evento.create({"person_id": self.per_a.id, "fecha": datetime(2020, 1, 10), "estrellas": 3, "xp": 999, "total": 9.0})
        res = self._R().shalom_admin_gerente_mes()
        por = {v["persona_nombre"]: v for v in res["vendedores"]}
        self.assertEqual(set(por), {"Persona A", "Persona B"})
        self.assertEqual((por["Persona A"]["pedidos"], por["Persona A"]["estrellas"], por["Persona A"]["oro"],
                          por["Persona A"]["xp"]), (2, 4, 1, 380))
        self.assertEqual(por["Persona A"]["ventas"], 1200.0)
        self.assertEqual((por["Persona B"]["pedidos"], por["Persona B"]["estrellas"], por["Persona B"]["oro"],
                          por["Persona B"]["xp"]), (1, 2, 0, 150))
        self.assertEqual(res["equipo"], {"pedidos": 3, "estrellas": 6, "oro": 1, "xp": 530})

    # ------------------------------------------------------------------
    # salud de los datos
    # ------------------------------------------------------------------
    def _salud(self):
        return self._R().shalom_admin_salud_datos()

    def test_salud_gps_prioritario(self):
        antes = self._salud()
        self.assertEqual(antes["gps_prioritario"], [])           # el escenario trae GPS a todos
        self._ubicacion("GPS1 bueno en ruta", self.ruta, pedidos=[(10, [(self.p_crema, 5)])])      # A: 1000 -> 810
        self._ubicacion("GPS2 bueno sin ruta", None, pedidos=[(10, [(self.p_barato, 5)])])          # B: 100 -> 89
        self._ubicacion("GPS3 nuevo", self.ruta)                                                    # NUEVO: no entra
        self._ubicacion("GPS4 distribuidora", self.ruta, distribuidora=True, pedidos=[(10, [(self.p_crema, 40)])])
        self._ubicacion("GPS5 con GPS", self.ruta, pedidos=[(10, [(self.p_crema, 5)])], con_gps=True, phone="555-0000")
        s = self._salud()
        self.assertEqual(s["sin_gps"] - antes["sin_gps"], 4)
        self.assertEqual(s["total_ubicaciones"] - antes["total_ubicaciones"], 5)
        nombres = [p["name"] for p in s["gps_prioritario"]]
        self.assertEqual(nombres, ["GPS1 bueno en ruta", "GPS2 bueno sin ruta"])    # por valor, solo buenos
        p1, p2 = s["gps_prioritario"]
        self.assertAlmostEqual(p1["valor"], 810.0, places=2)
        self.assertEqual((p1["clase"], p1["ruta"], p1["sin_ruta"]), ("A", "R1 prueba", False))
        self.assertAlmostEqual(p2["valor"], 89.0, places=2)
        self.assertEqual((p2["clase"], p2["ruta"], p2["sin_ruta"], p2["ruta_id"]), ("B", "", True, False))
        self.assertEqual(s["buenos"]["sin_gps"], 2)
        self.assertAlmostEqual(s["buenos"]["valor_sin_gps"], 899.0, places=2)
        self.assertEqual(s["buenos"]["total"] - antes["buenos"]["total"], 3)      # GPS1, GPS2, GPS5
        self.assertEqual(s["buenos"]["con_gps"] - antes["buenos"]["con_gps"], 1)  # GPS5
        self.assertEqual(s["gps_n"], 30)
        self.assertEqual(s["gps_cobertura_pct"], 100.0)                            # 2 clientes caben en los 30
        self.assertEqual((s["buenos_sin_ruta"]["total"] - antes["buenos_sin_ruta"]["total"]), 1)
        self.assertAlmostEqual(s["buenos_sin_ruta"]["valor"] - antes["buenos_sin_ruta"]["valor"], 89.0, places=2)
        # una distribuidora más, sin GPS; su peso en ventas sube
        self.assertEqual(s["distribuidoras"]["cantidad"] - antes["distribuidoras"]["cantidad"], 1)
        self.assertEqual(s["distribuidoras"]["sin_gps"] - antes["distribuidoras"]["sin_gps"], 1)
        self.assertGreater(s["distribuidoras"]["pct_ventas"], 0)
        self.assertGreater(s["distribuidoras"]["ventas"], antes["distribuidoras"]["ventas"])
        # sin teléfono: todos menos el que tiene
        self.assertEqual(s["sin_telefono"] - antes["sin_telefono"], 4)
        self.assertEqual(s["sin_tipo"] - antes["sin_tipo"], 5)

    def test_salud_top_30_y_cobertura(self):
        for i in range(35):
            # valores crecientes: i+1 barato x5 -> B/A con típico distinto
            self._ubicacion(f"Masivo {i:02d}", self.ruta, pedidos=[(10, [(self.p_barato, 5 + i)])])
        s = self._salud()
        lista = s["gps_prioritario"]
        self.assertEqual(len(lista), 35)
        valores = [p["valor"] for p in lista]
        self.assertEqual(valores, sorted(valores, reverse=True))
        self.assertEqual(lista[0]["name"], "Masivo 34")
        primeros = sum(valores[:30])
        self.assertAlmostEqual(s["gps_cobertura_pct"], round(primeros * 100.0 / sum(valores), 1), places=1)
        self.assertLess(s["gps_cobertura_pct"], 100.0)

    def test_salud_ciclos_sin_cartera(self):
        s = self._salud()
        ids = [c["id"] for c in s["ciclos_sin_cartera"]["lista"]]
        self.assertIn(self.ciclo.id, ids)
        self.assertGreaterEqual(s["ciclos_sin_cartera"]["abiertos"], 1)
        self.env["fsm.route.schedule"].with_user(self.u_mgr).shalom_admin_repartir_cartera(
            self.ciclo.id, [self.per_a.id, self.per_b.id])
        s2 = self._salud()
        self.assertNotIn(self.ciclo.id, [c["id"] for c in s2["ciclos_sin_cartera"]["lista"]])
        self.assertEqual(s2["ciclos_sin_cartera"]["sin_cartera"], s["ciclos_sin_cartera"]["sin_cartera"] - 1)

    def test_salud_rendimiento_no_crece_con_las_ubicaciones(self):
        """Una sola pasada: la cantidad de consultas SQL no depende de
        cuántas ubicaciones haya (~1,100 en producción)."""
        cr = self.env.cr

        def consultas(metodo):
            self.env.flush_all()
            self.env.invalidate_all()
            antes = cr.sql_log_count
            getattr(self._R(), metodo)()
            return cr.sql_log_count - antes

        consultas("shalom_admin_salud_datos")                    # calienta lo que se cachea entre llamadas
        base_salud = consultas("shalom_admin_salud_datos")
        base_reparto = consultas("shalom_admin_reparto_rutas")
        for i in range(60):
            self._ubicacion(f"Perf {i}", self.ruta, pedidos=[(10 + i, [(self.p_barato, 5)])])
        con_mas_salud = consultas("shalom_admin_salud_datos")
        con_mas_reparto = consultas("shalom_admin_reparto_rutas")
        self.assertLessEqual(con_mas_salud, base_salud + 5, (base_salud, con_mas_salud))
        self.assertLessEqual(con_mas_reparto, base_reparto + 5, (base_reparto, con_mas_reparto))
