# -*- coding: utf-8 -*-
"""Fase 6A: tutorial, logros/misiones, equipo cooperativo y temporada.

Todo se llama como VENDEDOR NORMAL (solo fieldservice.group_fsm_user), que
es quien lo hace por RPC desde la app; nunca como admin."""
import calendar
import json
from datetime import datetime, timedelta
from unittest import mock

import pytz

from odoo.exceptions import AccessError
from odoo.tests import tagged

from odoo.addons.shalom_location_map.models import juego_utils as ju
from odoo.addons.shalom_location_map.models import tz_utils

from .common import ShalomCommon

PROHIBIDAS = ("costo", "standard_price", "utilidad", "margen", "cost")


def _sin_costos(test, respuesta):
    texto = repr(respuesta).lower()
    for palabra in PROHIBIDAS:
        test.assertNotIn(palabra, texto, "la respuesta no puede traer %r" % palabra)


@tagged("post_install", "-at_install", "shalom_harness")
class TestTutorial(ShalomCommon):
    def test_estado_y_terminar_solo_el_propio(self):
        Evento = self.env["shalom.juego.evento"]
        a, b = Evento.with_user(self.u_min), Evento.with_user(self.u_b)
        self.assertEqual(
            a.shalom_tutorial_estado(),
            {"disponible": True, "visto": False, "mostrar": True, "nombre": "Persona Min"},
        )
        self.assertEqual(b.shalom_tutorial_estado()["mostrar"], True)
        res = a.shalom_tutorial_terminar()
        self.assertEqual(res, {"disponible": True, "visto": True, "mostrar": False, "nombre": "Persona Min"})
        self.assertEqual(a.shalom_tutorial_estado()["mostrar"], False)
        # el de B sigue sin verse, y el campo de A quedó guardado
        self.assertEqual(b.shalom_tutorial_estado()["mostrar"], True)
        self.assertTrue(self.per_min.sudo().x_tutorial_visto)
        self.assertFalse(self.per_b.sudo().x_tutorial_visto)
        # idempotente
        self.assertEqual(a.shalom_tutorial_terminar()["visto"], True)

    def test_sin_fsm_person_no_hay_tutorial(self):
        # el superusuario/admin de la prueba no tiene fsm.person
        Evento = self.env["shalom.juego.evento"]
        self.assertEqual(
            Evento.shalom_tutorial_estado(),
            {"disponible": False, "visto": True, "mostrar": False, "nombre": ""},
        )
        self.assertEqual(Evento.shalom_tutorial_terminar()["mostrar"], False)

    def test_vendedor_no_puede_escribir_el_libro_ni_los_logros(self):
        Logro = self.env["shalom.juego.logro"]
        with self.assertRaises(AccessError):
            Logro.with_user(self.u_min).create({"person_id": self.per_min.id, "codigo": "oro", "xp": 99999})
        with self.assertRaises(AccessError):
            Logro.with_user(self.u_min).search([])


@tagged("post_install", "-at_install", "shalom_harness")
class TestLogros(ShalomCommon):
    def _ev(self, persona, minutos=0, **kw):
        valores = {
            "person_id": persona.id, "xp": 10, "total": 100.0, "estrellas": 0,
            "fecha": datetime.now() + timedelta(minutes=minutos),
        }
        valores.update(kw)
        return self.env["shalom.juego.evento"].sudo().create(valores)

    def _logros(self, user):
        return self.env["shalom.juego.evento"].with_user(user).shalom_mis_logros()

    def _por_codigo(self, res):
        return {l["codigo"]: l for l in res["logros"]}

    def _filas(self, persona):
        return self.env["shalom.juego.logro"].sudo().search([("person_id", "=", persona.id)])

    # ------------------------------------------------------------------
    def test_sin_actividad(self):
        res = self._logros(self.u_min)
        self.assertEqual((res["completos"], res["total"], res["nuevos_hoy"], res["xp_logros"]), (0, 8, 0, 0))
        self.assertEqual([l["codigo"] for l in res["logros"]], [l["codigo"] for l in ju.LOGROS])
        self.assertTrue(all(l["progreso"] == 0 and not l["completo"] and l["fecha"] is False for l in res["logros"]))
        _sin_costos(self, res)
        self.assertEqual(len(self._filas(self.per_min)), 0)

    def test_sin_fsm_person_devuelve_none(self):
        self.assertIsNone(self.env["shalom.juego.evento"].shalom_mis_logros())

    def test_primer_pedido_y_xp_idempotente(self):
        self._ev(self.per_min, xp=40, estrellas=1)
        antes = self.env["shalom.juego.evento"].with_user(self.u_min).shalom_mi_progreso()["xp_total"]
        self.assertEqual(antes, 40)
        res = self._logros(self.u_min)
        l = self._por_codigo(res)
        self.assertTrue(l["primer_pedido"]["completo"])
        self.assertTrue(l["primer_pedido"]["hoy"])
        self.assertEqual(res["nuevos_hoy"], res["completos"])
        self.assertFalse(l["primera_plata"]["completo"])
        xp1 = res["xp_logros"]
        self.assertEqual(xp1, 100)
        n1 = len(self._filas(self.per_min))
        # una y otra vez: ni filas ni XP nuevos
        for _ in range(3):
            res = self._logros(self.u_min)
        self.assertEqual(res["xp_logros"], xp1)
        self.assertEqual(len(self._filas(self.per_min)), n1)
        self.assertEqual(self.env["shalom.juego.evento"].sudo()._shalom_otorgar_logros(self.per_min), [])
        # el XP del logro suma al progreso exactamente una vez
        prog = self.env["shalom.juego.evento"].with_user(self.u_min).shalom_mi_progreso()
        self.assertEqual(prog["xp_total"], 40 + xp1)
        # y la fila queda con la restricción única
        with self.assertRaises(Exception), self.env.cr.savepoint():
            self.env["shalom.juego.logro"].sudo().create(
                {"person_id": self.per_min.id, "codigo": "primer_pedido", "xp": 100}
            )

    def test_misiones_de_bienvenida_llevan_al_nivel_2(self):
        """100 + 200 + 300 = 600 XP -> nivel 2 y el logro "Nivel 2" (+50)."""
        persona = self.per_min
        visitas = [self.visitas[k] for k in ("A1", "A2", "A3", "A4", "A5")]
        # 5 pedidos seguidos de la misma ruta; 3 con tinte + oxigenta
        for i, visita in enumerate(visitas):
            self._ev(persona, i, order_id=visita.id, xp=0, con_tinte=i < 3, con_oxigenta=i < 3)
        res = self._logros(self.u_min)
        l = self._por_codigo(res)
        for codigo in ("primer_pedido", "quimico", "ruta_sin_saltos", "nivel_2"):
            self.assertTrue(l[codigo]["completo"], codigo)
        self.assertEqual((l["quimico"]["progreso"], l["quimico"]["meta"]), (3, 3))
        self.assertEqual((l["ruta_sin_saltos"]["progreso"], l["ruta_sin_saltos"]["meta"]), (5, 5))
        prog = self.env["shalom.juego.evento"].with_user(self.u_min).shalom_mi_progreso()
        self.assertEqual(prog["xp_total"], 600 + 50)
        self.assertEqual((prog["nivel"], prog["nivel_nombre"]), (2, "Explorador"))
        # el nivel nunca baja: borrar un evento no cambia lo ya ganado
        self.assertTrue(self._por_codigo(self._logros(self.u_min))["nivel_2"]["completo"])

    def test_racha_se_corta_con_pedido_sin_ruta(self):
        persona = self.per_min
        claves = ("A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4")
        for i, clave in enumerate(claves):
            # el 5º evento no tiene visita (ruta desconocida): corta la racha
            self._ev(persona, i, order_id=False if i == 4 else self.visitas[clave].id, xp=0)
        l = self._por_codigo(self._logros(self.u_min))
        self.assertEqual(l["ruta_sin_saltos"]["progreso"], 4)
        self.assertFalse(l["ruta_sin_saltos"]["completo"])
        self._ev(persona, 99, order_id=self.visitas["B1"].id, xp=0)   # 4 + 1 seguidos (B1..B4, B1)
        l = self._por_codigo(self._logros(self.u_min))
        self.assertTrue(l["ruta_sin_saltos"]["completo"])

    def test_estrellas_record_y_grandes(self):
        self._ev(self.per_min, 0, estrellas=2, total=2500.0, record_roto=False)
        l = self._por_codigo(self._logros(self.u_min))
        self.assertTrue(l["primera_plata"]["completo"] and l["cazador_grandes"]["completo"])
        self.assertFalse(l["oro"]["completo"] or l["record_roto"]["completo"])
        self._ev(self.per_min, 1, estrellas=3, record_roto=True)
        l = self._por_codigo(self._logros(self.u_min))
        self.assertTrue(l["oro"]["completo"] and l["record_roto"]["completo"])

    def test_logros_son_por_vendedor(self):
        self._ev(self.per_min, estrellas=3, record_roto=True)
        self._logros(self.u_min)
        res_b = self._logros(self.u_b)
        self.assertEqual(res_b["completos"], 0)
        self.assertEqual(len(self._filas(self.per_b)), 0)

    def test_confirmar_guarda_banderas_y_no_se_rompe(self):
        visita = self.visitas["A1"].with_user(self.u_a)
        res = visita.shalom_confirmar_pedido(self.lineas((self.p_tinte, 2), (self.p_oxi, 1)), "efectivo")
        self.assertIsNotNone(res["juego"])
        ev = self.env["shalom.juego.evento"].sudo().search([("sale_id", "=", res["sale_order_id"])])
        self.assertTrue(ev.con_tinte and ev.con_oxigenta)
        # solo tinte
        res = self.visitas["A2"].with_user(self.u_a).shalom_confirmar_pedido(self.lineas((self.p_tinte, 2)), "efectivo")
        ev = self.env["shalom.juego.evento"].sudo().search([("sale_id", "=", res["sale_order_id"])])
        self.assertTrue(ev.con_tinte)
        self.assertFalse(ev.con_oxigenta)
        # si el cálculo de banderas revienta, el pedido se confirma igual y el
        # resultado del juego sigue saliendo (sin banderas)
        with mock.patch.object(ju, "pedido_con_tinte_y_oxigenta", side_effect=RuntimeError("boom")):
            res = self.visitas["A3"].with_user(self.u_a).shalom_confirmar_pedido(
                self.lineas((self.p_tinte, 2), (self.p_oxi, 1)), "efectivo")
        self.assertEqual(self.env["sale.order"].browse(res["sale_order_id"]).state, "sale")
        self.assertIsNotNone(res["juego"])
        ev = self.env["shalom.juego.evento"].sudo().search([("sale_id", "=", res["sale_order_id"])])
        self.assertFalse(ev.con_tinte or ev.con_oxigenta)

    def test_el_quimico_con_pedidos_reales(self):
        for clave in ("A1", "A2", "A3"):
            self.visitas[clave].with_user(self.u_a).shalom_confirmar_pedido(
                self.lineas((self.p_tinte, 2), (self.p_oxi, 1)), "efectivo")
        res = self._logros(self.u_a)
        l = self._por_codigo(res)
        self.assertTrue(l["quimico"]["completo"])
        self.assertTrue(l["primer_pedido"]["completo"])
        # progreso del juego = eventos + logros, sin doble conteo
        eventos_xp = sum(self.env["shalom.juego.evento"].sudo().search([("person_id", "=", self.per_a.id)]).mapped("xp"))
        prog = self.env["shalom.juego.evento"].with_user(self.u_a).shalom_mi_progreso()
        self.assertEqual(prog["xp_total"], eventos_xp + res["xp_logros"])
        self._logros(self.u_a)
        prog2 = self.env["shalom.juego.evento"].with_user(self.u_a).shalom_mi_progreso()
        self.assertEqual(prog2["xp_total"], prog["xp_total"])
        _sin_costos(self, res)


@tagged("post_install", "-at_install", "shalom_harness")
class TestEquipoMes(ShalomCommon):
    def _param(self, clave, valor):
        self.env["ir.config_parameter"].sudo().set_param(clave, valor)

    def _borrar_params(self):
        self.env["ir.config_parameter"].sudo().search([("key", "like", "shalom.juego.%")]).unlink()

    def _equipo(self, user=None):
        return self.env["shalom.juego.evento"].with_user(user or self.u_min).shalom_equipo_mes()

    def _esperado_mes(self):
        """Venta del mes calculada aparte: pedidos confirmados de la compañía
        principal cuyo día local (Panamá) cae en el mes actual."""
        hoy = tz_utils.hoy_local(self.env)
        total = 0.0
        for o in self.env["sale.order"].sudo().search([("state", "in", ("sale", "done")), ("company_id", "=", self.company1.id)]):
            local = tz_utils.a_local(self.env, o.date_order).date()
            if (local.year, local.month) == (hoy.year, hoy.month):
                total += o.amount_untaxed
        return round(total, 2)

    def test_sin_parametros_usa_defectos_y_sin_camion(self):
        self._borrar_params()
        self._crear_venta(self.clientes["A1"].partner_id, 0, [(self.p_tinte, 100)])   # +10,000 hoy
        res = self._equipo()
        self.assertEqual((res["piso"], res["meta"]), (60000.0, 80000.0))
        self.assertIsNone(res["camion"])
        self.assertGreaterEqual(res["ventas"], 10000.0)
        self.assertEqual(res["ventas"], self._esperado_mes())
        hoy = tz_utils.hoy_local(self.env)
        self.assertEqual((res["mes"], res["anio"], res["dia_actual"]), (hoy.month, hoy.year, hoy.day))
        self.assertEqual(res["dias_mes"], calendar.monthrange(hoy.year, hoy.month)[1])
        self.assertEqual(res["faltan_piso"], round(max(60000.0 - res["ventas"], 0), 2))
        self.assertAlmostEqual(res["pct_piso"], round(res["ventas"] / 60000.0 * 100, 1), places=1)
        _sin_costos(self, res)

    def test_con_parametros(self):
        self._param("shalom.juego.piso_mes", "1500")
        self._param("shalom.juego.meta_mes", "3000.5")
        self._crear_venta(self.clientes["A1"].partner_id, 0, [(self.p_tinte, 100)])
        res = self._equipo()
        self.assertEqual((res["piso"], res["meta"]), (1500.0, 3000.5))
        self.assertTrue(res["piso_alcanzado"] and res["meta_alcanzada"])
        self.assertEqual((res["faltan_piso"], res["faltan_meta"], res["ritmo_piso"]), (0.0, 0.0, 0.0))
        # parámetros inválidos o <= 0 -> vuelven a los valores por defecto
        self._param("shalom.juego.piso_mes", "abc")
        self._param("shalom.juego.meta_mes", "-4")
        res = self._equipo()
        self.assertEqual((res["piso"], res["meta"]), (60000.0, 80000.0))

    def test_solo_confirmadas_del_mes_y_de_la_compania(self):
        self._borrar_params()
        base = self._equipo()["ventas"]
        partner = self.clientes["A1"].partner_id
        self._crear_venta(partner, 0, [(self.p_tinte, 1)], estado="draft")
        self._crear_venta(partner, 0, [(self.p_tinte, 1)], estado="cancel")
        self._crear_venta(partner, 400, [(self.p_tinte, 50)])                       # otro mes
        self.assertEqual(self._equipo()["ventas"], base)
        self._crear_venta(partner, 0, [(self.p_crema, 1)])                          # +200 (en Odoo 18 "bloqueado" ya no es un estado)
        self.assertEqual(self._equipo()["ventas"], round(base + 200.0, 2))
        # pedido confirmado de OTRA compañía (Nevada/Greenpeak): no cuenta
        otra = self.env["sale.order"].with_company(self.company2).sudo().create({
            "partner_id": partner.id, "company_id": self.company2.id,
            "order_line": [(0, 0, {"product_id": self.p_tinte.id, "product_uom_qty": 500})],
        })
        otra.write({"state": "sale"})
        self.assertEqual(self._equipo()["ventas"], round(base + 200.0, 2))

    def test_camion_solo_si_existe_el_parametro(self):
        self._borrar_params()
        self.assertIsNone(self._equipo()["camion"])
        self._crear_venta(self.clientes["A1"].partner_id, 0, [(self.p_tinte, 100)])   # 10,000 hoy
        self._param("shalom.juego.camion_dia", "9000")
        camion = self._equipo()["camion"]
        self.assertEqual(camion["meta"], 9000.0)
        self.assertGreaterEqual(camion["vendido"], 10000.0)
        self.assertTrue(camion["lleno"])
        self._param("shalom.juego.camion_dia", "100000000")
        self.assertFalse(self._equipo()["camion"]["lleno"])
        self._param("shalom.juego.camion_dia", "")
        self.assertIsNone(self._equipo()["camion"])
        self._param("shalom.juego.camion_dia", "no-es-numero")
        self.assertIsNone(self._equipo()["camion"])

    def test_sin_ranking_ni_comparacion_entre_vendedores(self):
        self._borrar_params()
        # ventas de dos vendedores distintos este mes
        self._crear_venta(self.clientes["A1"].partner_id, 0, [(self.p_tinte, 10)])
        orden = self._crear_venta(self.clientes["A2"].partner_id, 0, [(self.p_tinte, 20)])
        orden.write({"user_id": self.u_b.id})
        res_a, res_b = self._equipo(self.u_a), self._equipo(self.u_b)
        self.assertEqual(res_a, res_b)                      # es del equipo, no de quien pregunta
        texto = repr(res_a).lower()
        for palabra in ("persona", "vendedor", "ranking", "posicion", "posición", "lider", "líder"):
            self.assertNotIn(palabra, texto)
        # ningún valor es una lista de personas: solo números/texto/bool/None
        self.assertFalse(any(isinstance(v, (list, dict)) for v in res_a.values()))

    def test_sin_fsm_person_devuelve_none(self):
        self.assertIsNone(self.env["shalom.juego.evento"].shalom_equipo_mes())


@tagged("post_install", "-at_install", "shalom_harness")
class TestTemporada(ShalomCommon):
    def _ev(self, persona, xp, dias_atras=0, estrellas=1):
        return self.env["shalom.juego.evento"].sudo().create({
            "person_id": persona.id, "xp": xp, "estrellas": estrellas, "total": 100.0,
            "fecha": datetime.now() - timedelta(days=dias_atras),
        })

    def _temporada(self, user=None):
        return self.env["shalom.juego.evento"].with_user(user or self.u_min).shalom_temporada()

    def _param(self, valor):
        self.env["ir.config_parameter"].sudo().set_param("shalom.juego.premios_temporada", valor)

    def _borrar_premios(self):
        self.env["ir.config_parameter"].sudo().search([("key", "=", "shalom.juego.premios_temporada")]).unlink()

    def test_sin_actividad_y_sin_premios(self):
        self._borrar_premios()
        res = self._temporada()
        self.assertEqual((res["xp_mes"], res["estrellas_mes"], res["pedidos_mes"], res["nivel_temporada"]), (0, 0, 0, 0))
        self.assertEqual(res["niveles_total"], 12)
        self.assertEqual(len(res["hitos"]), 12)
        self.assertFalse(res["hay_premios"])
        self.assertTrue(all(h["premio"] is False for h in res["hitos"]))
        self.assertEqual(res["proximo"], {"nivel": 1, "xp": ju.HITOS_TEMPORADA[0], "faltan": ju.HITOS_TEMPORADA[0]})
        hoy = tz_utils.hoy_local(self.env)
        self.assertEqual(res["bono_quincena"]["activo"], hoy.day <= 15)
        self.assertEqual(res["bono_quincena"]["dias_restantes"], ju.dias_quincena_restantes(hoy))
        self.assertEqual(res["bono_quincena"]["multiplicador"], 1.5)
        self.assertEqual(res["dias_restantes_mes"], calendar.monthrange(hoy.year, hoy.month)[1] - hoy.day)
        _sin_costos(self, res)

    def test_xp_del_mes_incluye_logros_y_reinicia_cada_mes(self):
        self._borrar_premios()
        hoy = tz_utils.hoy_local(self.env)
        # evento del mes anterior (hoy.day + 1 días atrás siempre cae el mes pasado)
        self._ev(self.per_min, 900, dias_atras=hoy.day + 1, estrellas=3)
        self._ev(self.per_min, 400, estrellas=2)
        self._ev(self.per_min, 250, estrellas=3)
        self._ev(self.per_b, 5000)                                    # de otro vendedor
        res = self._temporada()
        self.assertEqual((res["xp_mes"], res["estrellas_mes"], res["pedidos_mes"]), (650, 5, 2))
        self.assertEqual(res["nivel_temporada"], 1)                    # alcanzó el hito de 300, no el de 700
        self.assertEqual(res["proximo"]["faltan"], ju.HITOS_TEMPORADA[1] - 650)
        # los logros ganados este mes suman al XP de la temporada
        logros = self.env["shalom.juego.evento"].with_user(self.u_min).shalom_mis_logros()
        res2 = self._temporada()
        self.assertEqual(res2["xp_mes"], 650 + logros["xp_logros"])
        # lo del mes pasado cuenta para el nivel global, no para la temporada
        prog = self.env["shalom.juego.evento"].with_user(self.u_min).shalom_mi_progreso()
        self.assertEqual(prog["xp_total"], 900 + 650 + logros["xp_logros"])

    def test_premios_desde_parametro(self):
        self._param(json.dumps({"3": "Cena para dos", "6": "Marco dorado", "99": "ignorado", "x": "ignorado"}))
        res = self._temporada()
        self.assertTrue(res["hay_premios"])
        premios = {h["nivel"]: h["premio"] for h in res["hitos"] if h["premio"]}
        self.assertEqual(premios, {3: "Cena para dos", 6: "Marco dorado"})
        # formato en lista
        self._param(json.dumps([{"nivel": 5, "texto": "Día libre"}]))
        self.assertEqual({h["nivel"]: h["premio"] for h in self._temporada()["hitos"] if h["premio"]}, {5: "Día libre"})
        # vacío, basura o JSON raro -> no se muestran premios y no falla
        for crudo in ("", "   ", "{roto", "42", "null", "[1,2]"):
            self._param(crudo)
            res = self._temporada()
            self.assertFalse(res["hay_premios"], crudo)
            self.assertTrue(all(h["premio"] is False for h in res["hitos"]), crudo)

    def test_sin_fsm_person_devuelve_none(self):
        self.assertIsNone(self.env["shalom.juego.evento"].shalom_temporada())
