# -*- coding: utf-8 -*-
"""Fase 6B: avisos a 3 días por WhatsApp, distribuidoras por mensaje y
casilla "Es distribuidora". Todo se prueba como VENDEDOR normal."""
from datetime import timedelta

from odoo.exceptions import AccessError
from odoo.tests import tagged

from .common import ShalomCommon


@tagged("post_install", "-at_install", "shalom_harness")
class TestCampo(ShalomCommon):
    def setUp(self):
        super().setUp()
        self.P = self.env["fsm.person"]
        # el ciclo arranca pasado mañana: A1..A5 y compañía caen en la ventana
        self._fecha_ciclo(2)
        tel = {
            "A1": {"mobile": "6678-1234"},
            "A2": {"phone": "233-4455"},                  # 7 dígitos: no sirve
            "A3": {"mobile": "+507 6000 0000"},
            "A4": {"mobile": "", "phone": "6600 1111"},   # solo teléfono fijo/local
            "A5": {},                                      # sin teléfono
            "A2_1": {"mobile": "00507 6111-2222"},
            "B1": {"mobile": "6222-3333"},
            "DIST": {"mobile": "6999-8888"},
        }
        for clave, vals in tel.items():
            loc = self.clientes[clave]
            loc.phone = vals.get("phone", False)
            loc.partner_id.mobile = vals.get("mobile", False)

    # -- utilidades ------------------------------------------------------
    def _fecha_ciclo(self, dias):
        self.ciclo.write({"date_start": self.hoy + timedelta(days=dias),
                          "date_end": self.hoy + timedelta(days=dias + 6)})

    def _avisos(self, user=None):
        return self.P.with_user(user or self.u_a).shalom_avisos_proximos()

    def _nombres(self, user=None):
        return [a["nombre"] for a in self._avisos(user)]

    def _param(self, clave, valor):
        self.env["ir.config_parameter"].sudo().set_param(clave, valor)

    # -- ventana de 3 días -----------------------------------------------
    def test_ventana_manana_a_tres_dias(self):
        for dias, esperado in ((-3, False), (0, False), (1, True), (2, True), (3, True), (4, False), (10, False)):
            self._fecha_ciclo(dias)
            self.assertEqual("Cliente A1" in self._nombres(), esperado, "ciclo en %+d días" % dias)

    def test_fecha_de_cartera_manda_sobre_el_ciclo(self):
        # el ciclo arrancó hace 10 días, pero la cartera dice mañana
        self._fecha_ciclo(-10)
        self.assertEqual(self._nombres(), [])
        self.visitas["A1"].write({"x_cartera_person_id": self.per_a.id,
                                  "x_cartera_fecha": self.hoy + timedelta(days=1)})
        a = self._avisos()
        self.assertEqual([x["nombre"] for x in a], ["Cliente A1"])
        self.assertEqual(a[0]["fecha"], str(self.hoy + timedelta(days=1)))
        self.assertEqual(a[0]["dias"], 1)

    # -- quiénes reciben aviso --------------------------------------------
    def test_solo_clientes_grandes_con_umbral(self):
        nombres = set(self._nombres())
        # A y A2 con teléfono usable
        self.assertEqual(nombres, {"Cliente A1", "Cliente A3", "Cliente A4", "Cliente A2_1"})
        # B1 tiene teléfono pero su valor esperado no llega a $500
        perfil = self.env["fsm.order"].shalom_perfiles_ruta([self.clientes["B1"].id])[self.clientes["B1"].id]
        self.assertLess(perfil["esperado"], 500)
        self._param("shalom.aviso_min_esperado", "10")
        self.assertIn("Cliente B1", self._nombres())
        self._param("shalom.aviso_min_esperado", "100000")
        self.assertEqual(set(self._nombres()), nombres, "A y A2 entran siempre, sea cual sea el umbral")
        self._param("shalom.aviso_min_esperado", "basura")           # mal escrito -> defecto 500
        self.assertEqual(set(self._nombres()), nombres)

    def test_sin_telefono_usable_no_hay_aviso(self):
        nombres = self._nombres()
        self.assertNotIn("Cliente A2", nombres)   # "233-4455" (7 dígitos)
        self.assertNotIn("Cliente A5", nombres)   # sin teléfono

    def test_distribuidoras_fuera_de_avisos_y_en_su_lista(self):
        dist = self.clientes["DIST"]
        self.assertTrue(dist.x_es_distribuidora)
        self.assertNotIn("Cliente DIST", self._nombres())
        # en su lista, visible para cualquier vendedor (aunque no sea su ruta)
        for user in (self.u_a, self.u_b, self.u_min, self.u_own):
            lista = self.P.with_user(user).shalom_distribuidoras()
            self.assertEqual([d["nombre"] for d in lista], ["Cliente DIST"], user.login)
        d = self.P.with_user(self.u_own).shalom_distribuidoras()[0]
        self.assertEqual(d["telefono"], "50769998888")
        self.assertEqual(d["telefono_texto"], "+507 6999-8888")
        self.assertTrue(d["url"].startswith("https://wa.me/50769998888?text="))
        self.assertIn("Persona Own", d["mensaje"])
        # último pedido: 40 x $200 hace 5 días (se ve aunque el vendedor solo vea sus documentos)
        self.assertEqual(d["ultimo_monto"], 8000.0)
        self.assertEqual(d["dias"], 5)
        self.assertEqual(d["ultimo_fecha"], str(self.hoy - timedelta(days=5)))
        # sin costo ni utilidad
        self.assertFalse({"costo", "utilidad", "margen", "margen_pct"} & set(d))
        # una que deja de serlo sale de la lista y entra a los avisos
        dist.x_es_distribuidora = False
        self.assertEqual(self.P.with_user(self.u_a).shalom_distribuidoras(), [])
        self.assertIn("Cliente DIST", self._nombres())

    def test_distribuidora_sin_pedidos_ni_telefono(self):
        loc = self.clientes["N1"]
        loc.x_es_distribuidora = True
        loc.phone = False
        lista = self.P.with_user(self.u_a).shalom_distribuidoras()
        self.assertEqual([d["nombre"] for d in lista], ["Cliente DIST", "Cliente N1"], "sin pedidos, al final")
        n1 = lista[1]
        self.assertFalse(n1["ultimo_fecha"])
        self.assertEqual(n1["ultimo_monto"], 0.0)
        self.assertFalse(n1["dias"])
        self.assertEqual((n1["telefono"], n1["url"]), ("", ""))

    def test_orden_por_valor_esperado(self):
        a = self._avisos()
        esperados = [x["esperado"] for x in a]
        self.assertEqual(esperados, sorted(esperados, reverse=True))
        self.assertGreater(len(a), 1)
        # A (ticket ~1,433 x 0.81) por encima de A2 (900 x 0.92)
        self.assertEqual(a[-1]["nombre"], "Cliente A2_1")

    # -- teléfono y mensaje ------------------------------------------------
    def test_telefonos_normalizados(self):
        por_nombre = {a["nombre"]: a for a in self._avisos()}
        self.assertEqual(por_nombre["Cliente A1"]["telefono"], "50766781234")      # 8 dígitos con guion
        self.assertEqual(por_nombre["Cliente A3"]["telefono"], "50760000000")      # con +507 y espacios
        self.assertEqual(por_nombre["Cliente A4"]["telefono"], "50766001111")      # solo teléfono, con espacio
        self.assertEqual(por_nombre["Cliente A2_1"]["telefono"], "50761112222")    # 00507
        self.assertEqual(por_nombre["Cliente A1"]["telefono_texto"], "+507 6678-1234")
        # vacío: ni siquiera aparece
        self.assertNotIn("Cliente A5", por_nombre)

    def test_mensaje_y_enlace(self):
        a = {x["nombre"]: x for x in self._avisos()}["Cliente A1"]
        fecha = self.hoy + timedelta(days=2)
        self.assertEqual(a["fecha"], str(fecha))
        self.assertIn(a["fecha_texto"], a["mensaje"])
        self.assertIn("Persona A", a["mensaje"])
        self.assertTrue(a["url"].startswith("https://wa.me/50766781234?text="))
        self.assertNotIn(" ", a["url"])
        self.assertEqual(a["clase"], "A")
        self.assertEqual(a["ruta"], "R1 prueba")

    def test_plantilla_configurable(self):
        self._param("shalom.aviso_whatsapp_plantilla", "Hola {cliente}, soy {vendedor}. Voy el {fecha}. {extra}")
        a = {x["nombre"]: x for x in self._avisos()}["Cliente A1"]
        self.assertEqual(a["mensaje"], "Hola Cliente A1, soy Persona A. Voy el %s. {extra}" % a["fecha_texto"])
        self._param("shalom.aviso_whatsapp_plantilla", "")           # vacía = texto por defecto cordial
        a = {x["nombre"]: x for x in self._avisos()}["Cliente A1"]
        self.assertIn("Shalom", a["mensaje"])
        self.assertNotIn("{", a["mensaje"])

    def test_no_devuelve_costo_ni_utilidad(self):
        for a in self._avisos():
            self.assertEqual(
                set(a),
                {"order_id", "location_id", "nombre", "clase", "esperado", "fecha", "fecha_texto", "dias",
                 "ruta", "telefono", "telefono_texto", "mensaje", "url", "avisado"})

    # -- visibilidad -------------------------------------------------------
    def test_solo_mi_cartera_o_mis_rutas(self):
        # sin reparto: la ruta es de A
        self.assertTrue(self._avisos(self.u_a))
        for u in (self.u_b, self.u_c, self.u_min, self.u_own):
            self.assertEqual(self._avisos(u), [], u.login)
        # con reparto: A1 -> B (mañana), A3 -> A (pasado mañana); el resto sin cartera
        self.visitas["A1"].write({"x_cartera_person_id": self.per_b.id,
                                  "x_cartera_fecha": self.hoy + timedelta(days=1)})
        self.visitas["A3"].write({"x_cartera_person_id": self.per_a.id,
                                  "x_cartera_fecha": self.hoy + timedelta(days=2)})
        self.assertEqual(self._nombres(self.u_a), ["Cliente A3"])
        self.assertEqual(self._nombres(self.u_b), ["Cliente A1"])
        self.assertEqual(self._avisos(self.u_c), [])

    def test_reserva_y_visitas_cerradas_no_se_avisan(self):
        self.visitas["A1"].write({"x_cartera_person_id": self.per_a.id,
                                  "x_cartera_fecha": self.hoy + timedelta(days=1),
                                  "x_cartera_reserva": True})
        self.visitas["A3"].write({"x_cartera_person_id": self.per_a.id,
                                  "x_cartera_fecha": self.hoy + timedelta(days=1)})
        self.assertEqual(self._nombres(), ["Cliente A3"], "la reserva no se avisa")
        self.visitas["A3"].with_context(bypass_order_completed_stage=True).write(
            {"stage_id": self.env.ref("fieldservice.fsm_stage_completed").id})
        self.assertEqual(self._nombres(), [], "una visita ya cerrada no se avisa")

    def test_usuario_sin_fsm_person(self):
        admin = self.env.ref("base.user_admin")
        self.assertFalse(self.P.search([("user_id", "=", admin.id)]))
        self.assertEqual(self.P.with_user(admin).shalom_avisos_proximos(), [])
        self.assertEqual(self.P.with_user(admin).shalom_marcar_avisado([self.visitas["A1"].id]), [])

    # -- marcar avisado ------------------------------------------------------
    def test_marcar_avisado_idempotente(self):
        visita = self.visitas["A1"]
        a = {x["nombre"]: x for x in self._avisos()}["Cliente A1"]
        self.assertFalse(a["avisado"])
        self.assertFalse(visita.x_aviso_enviado)
        self.assertEqual(self.P.with_user(self.u_a).shalom_marcar_avisado([a["order_id"]]), [visita.id])
        visita.invalidate_recordset()
        primera = visita.x_aviso_enviado
        self.assertTrue(primera)
        self.assertEqual(visita.x_aviso_fecha, self.hoy + timedelta(days=2))
        self.assertTrue({x["nombre"]: x for x in self._avisos()}["Cliente A1"]["avisado"])
        # segunda vez: mismo resultado y la hora del primer aviso no cambia
        self.assertEqual(self.P.with_user(self.u_a).shalom_marcar_avisado([a["order_id"], a["order_id"]]), [visita.id])
        visita.invalidate_recordset()
        self.assertEqual(visita.x_aviso_enviado, primera)
        # los demás siguen pendientes
        self.assertFalse({x["nombre"]: x for x in self._avisos()}["Cliente A3"]["avisado"])
        # si el reparto mueve la visita a otro día, el aviso anterior ya no vale
        visita.write({"x_cartera_person_id": self.per_a.id, "x_cartera_fecha": self.hoy + timedelta(days=3)})
        self.assertFalse({x["nombre"]: x for x in self._avisos()}["Cliente A1"]["avisado"])

    def test_no_se_puede_marcar_lo_ajeno(self):
        visita = self.visitas["A1"]
        # B no es dueño de la ruta ni tiene cartera: no puede marcar
        self.assertEqual(self.P.with_user(self.u_b).shalom_marcar_avisado([visita.id]), [])
        self.assertFalse(visita.x_aviso_enviado)
        # basura en la lista: se ignora sin romper
        self.assertEqual(self.P.with_user(self.u_a).shalom_marcar_avisado([0, 99999999, "x", None, visita.id]), [visita.id])
        self.assertEqual(self.P.with_user(self.u_a).shalom_marcar_avisado([]), [])
        self.assertEqual(self.P.with_user(self.u_a).shalom_marcar_avisado(False), [])
        # una visita cerrada no se marca
        visita.with_context(bypass_order_completed_stage=True).write(
            {"stage_id": self.env.ref("fieldservice.fsm_stage_completed").id})
        otra = self.visitas["A3"]
        otra.with_context(bypass_order_completed_stage=True).write(
            {"stage_id": self.env.ref("fieldservice.fsm_stage_completed").id})
        self.assertEqual(self.P.with_user(self.u_a).shalom_marcar_avisado([otra.id]), [])
        self.assertFalse(otra.x_aviso_enviado)

    def test_vendedor_con_solo_sus_documentos_tambien_funciona(self):
        """u_own (ventas 'solo mis documentos') ve la clase y el valor del
        cliente completos: el historial se lee con sudo, como en el juego."""
        self.ruta.fsm_person_id = self.per_own.id
        a = {x["nombre"]: x for x in self._avisos(self.u_own)}
        self.assertIn("Cliente A1", a)
        ref = self.env["fsm.order"].shalom_perfiles_ruta([self.clientes["A1"].id])[self.clientes["A1"].id]
        self.assertEqual(a["Cliente A1"]["clase"], ref["clase"])
        self.assertEqual(a["Cliente A1"]["esperado"], ref["esperado"])

    # -- casilla "Es distribuidora" -------------------------------------------
    def test_solo_el_dueno_marca_distribuidoras(self):
        L = self.env["fsm.location"]
        loc = self.clientes["A1"]
        self.assertFalse(L.with_user(self.u_a).shalom_puede_marcar_distribuidora())
        self.assertFalse(L.with_user(self.u_own).shalom_puede_marcar_distribuidora())
        self.assertTrue(L.with_user(self.u_mgr).shalom_puede_marcar_distribuidora())
        for user in (self.u_a, self.u_b, self.u_min, self.u_own):
            with self.assertRaises(AccessError, msg=user.login):
                loc.with_user(user).write({"x_es_distribuidora": True})
        self.assertFalse(loc.x_es_distribuidora)
        # el dueño sí: la marca la saca de los avisos y la mete en la lista
        loc.with_user(self.u_mgr).write({"x_es_distribuidora": True})
        self.assertTrue(loc.x_es_distribuidora)
        self.assertNotIn("Cliente A1", self._nombres())
        self.assertIn("Cliente A1", [d["nombre"] for d in self.P.with_user(self.u_a).shalom_distribuidoras()])
        loc.with_user(self.u_mgr).write({"x_es_distribuidora": False})
        self.assertFalse(loc.x_es_distribuidora)
