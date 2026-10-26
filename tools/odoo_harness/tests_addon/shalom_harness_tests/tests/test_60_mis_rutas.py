# -*- coding: utf-8 -*-
import ast
import inspect
import os
import pathlib
import subprocess
import textwrap
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import AccessError
from odoo.tests import tagged

from .common import ShalomCommon

REPO = pathlib.Path(os.environ.get("SHALOM_REPO", "/home/user/shalom_route_sales"))
# Versión del método ANTES del cambio de la Fase 4 (commit 502d9e8 = carteras;
# 119863d^ = justo antes de la Fase 1). Solo cambió en 502d9e8.
REF_PREVIA = "119863d^"
NUEVAS = {"mi_persona_id", "tiene_cartera", "centro_lat", "centro_lng", "pendientes_mios", "esperado_mio"}


def metodo_previo():
    """Extrae del git la función shalom_mis_rutas_programadas de la
    versión previa y la devuelve como función suelta (self, ds, de)."""
    fuente = subprocess.run(
        ["git", "-C", str(REPO), "show", "%s:shalom_location_map/models/fsm_person.py" % REF_PREVIA],
        check=True, capture_output=True, text=True,
    ).stdout
    arbol = ast.parse(fuente)
    for nodo in ast.walk(arbol):
        if isinstance(nodo, ast.FunctionDef) and nodo.name == "shalom_mis_rutas_programadas":
            nodo.decorator_list = []
            mod = ast.Module(body=[nodo], type_ignores=[])
            ns = {"api": api, "models": models, "_": _, "AccessError": AccessError}
            exec(compile(ast.fix_missing_locations(mod), "fsm_person_previo", "exec"), ns)
            return ns["shalom_mis_rutas_programadas"]
    raise AssertionError("no se encontró el método previo")


@tagged("post_install", "-at_install", "shalom_harness")
class TestMisRutas(ShalomCommon):
    def setUp(self):
        super().setUp()
        h = self.hoy
        self.ds = fields.Date.to_string(h - timedelta(days=h.weekday()))
        self.de = fields.Date.to_string(h - timedelta(days=h.weekday()) + timedelta(days=6))

    def _mis(self, user, ds=None, de=None):
        return self.env["fsm.person"].with_user(user).shalom_mis_rutas_programadas(ds or self.ds, de or self.de)

    def _ids(self, user):
        return [r["id"] for r in self._mis(user)]

    def _repartir(self, personas):
        self.env["fsm.route.schedule"].with_user(self.u_mgr).shalom_admin_repartir_cartera(
            self.ciclo.id, [p.id for p in personas])

    # ------------------------------------------------------------------
    def test_sin_carteras_solo_el_dueno(self):
        self.assertEqual(self._ids(self.u_a), [self.ciclo.id])
        self.assertEqual(self._ids(self.u_b), [])
        self.assertEqual(self._ids(self.u_c), [])
        r = self._mis(self.u_a)[0]
        self.assertFalse(r["tiene_cartera"])
        self.assertEqual(r["mi_persona_id"], self.per_a.id)
        self.assertEqual(r["route_name"], "R1 prueba")
        self.assertEqual(r["cantidad_clientes"], 20)

    def test_con_carteras_b_ve_el_ciclo_y_c_no(self):
        self._repartir([self.per_a, self.per_b])
        rb = self._mis(self.u_b)
        self.assertEqual([r["id"] for r in rb], [self.ciclo.id])
        self.assertTrue(rb[0]["tiene_cartera"])
        self.assertEqual(rb[0]["mi_persona_id"], self.per_b.id)
        ra = self._mis(self.u_a)
        self.assertEqual([r["id"] for r in ra], [self.ciclo.id], "sin duplicados aunque sea dueño Y tenga cartera")
        self.assertTrue(ra[0]["tiene_cartera"])
        self.assertEqual(ra[0]["mi_persona_id"], self.per_a.id)
        self.assertEqual(self._ids(self.u_c), [], "el tercero no ve la ruta")
        # el dueño también ve la ruta si el reparto es solo de B y C
        self._repartir([self.per_b, self.per_c])
        self.assertEqual(self._ids(self.u_a), [self.ciclo.id])
        self.assertEqual(self._ids(self.u_c), [self.ciclo.id])
        # limpiar: B y C dejan de verla
        self.env["fsm.route.schedule"].with_user(self.u_mgr).shalom_admin_limpiar_cartera(self.ciclo.id)
        self.assertEqual(self._ids(self.u_b), [])
        self.assertEqual(self._ids(self.u_c), [])
        self.assertFalse(self._mis(self.u_a)[0]["tiene_cartera"])

    def test_datos_del_mapa_de_rutas(self):
        """Fase 5: centro del ciclo y lo que me toca (pendientes y valor esperado)."""
        r = self._mis(self.u_a)[0]
        # sin reparto: todo el ciclo es del dueño; solo cuentan clases que compran
        self.assertGreater(r["pendientes_mios"], 0)
        self.assertLessEqual(r["pendientes_mios"], 20)
        self.assertGreater(r["esperado_mio"], 0)
        total_dueno = r["esperado_mio"]
        self.assertTrue(8.0 < r["centro_lat"] < 10.0, r["centro_lat"])
        # con reparto A/B: cada uno ve solo lo suyo y entre los dos suman lo mismo
        self._repartir([self.per_a, self.per_b])
        ra = self._mis(self.u_a)[0]
        rb = self._mis(self.u_b)[0]
        self.assertLess(ra["esperado_mio"], total_dueno + 0.01)
        self.assertGreater(rb["esperado_mio"], 0)
        self.assertAlmostEqual(ra["pendientes_mios"] + rb["pendientes_mios"], r["pendientes_mios"], delta=0)
        # un tercero sin cartera no ve la ruta
        self.assertEqual(self._mis(self.u_c), [])

    def test_vendedor_sin_persona_o_admin(self):
        self.assertEqual(self.env["fsm.person"].shalom_mis_rutas_programadas(self.ds, self.de), [])  # OdooBot
        self.assertEqual(self._mis(self.u_min), [])

    def test_cartera_en_visitas_cerradas_sigue_viendo_ciclo(self):
        """B tiene cartera pero TODAS sus visitas ya cerraron: el ciclo
        sigue visible por fecha/estado (no completada) y tiene_cartera
        sigue True (la cartera cuenta aunque la visita esté cerrada)."""
        self._repartir([self.per_a, self.per_b])
        completada = self.env.ref("fieldservice.fsm_stage_completed")
        for v in self.visitas.values():
            if v.x_cartera_person_id == self.per_b:
                v.with_context(bypass_order_completed_stage=True).write({"stage_id": completada.id})
        self.assertEqual(self._ids(self.u_b), [self.ciclo.id])
        self.assertTrue(self._mis(self.u_b)[0]["tiene_cartera"])

    def test_ventana_y_no_completadas(self):
        lejos_ini = fields.Date.to_string(self.hoy + timedelta(days=60))
        lejos_fin = fields.Date.to_string(self.hoy + timedelta(days=66))
        self.assertEqual(self._ids_ventana(self.u_a, lejos_ini, lejos_fin), [self.ciclo.id],
                         "no completada: se ve aunque la ventana no la cubra")
        completada = self.env.ref("fieldservice.fsm_stage_completed")
        for v in self.visitas.values():
            v.with_context(bypass_order_completed_stage=True).write({"stage_id": completada.id})
        self.assertEqual(self.ciclo.estado, "completada")
        self.assertEqual(self._ids_ventana(self.u_a, lejos_ini, lejos_fin), [])
        self.assertEqual(self._ids(self.u_a), [self.ciclo.id], "dentro de la ventana, completada igual se ve")

    def _ids_ventana(self, user, ds, de):
        return [r["id"] for r in self._mis(user, ds, de)]

    def test_visita_expres(self):
        """Ruta Visita Exprés: aparece mientras tenga una visita abierta;
        sin visitas abiertas desaparece; es_visita_express True."""
        ruta = self.env["fsm.route"].create({"name": "Exprés A", "fsm_person_id": self.per_a.id, "x_es_visita_express": True})
        loc = self.clientes["A1"]
        sch = self.env["fsm.route.schedule"].create({"route_id": ruta.id, "date_start": self.hoy, "date_end": self.hoy + timedelta(days=2)})
        orden = self.env["fsm.order"].create({
            "name": "expres", "location_id": loc.id, "x_route_schedule_id": sch.id,
            "stage_id": self.env.ref("shalom_location_map.shalom_fsm_stage_order_new").id,
        })
        res = {r["id"]: r for r in self._mis(self.u_a)}
        self.assertTrue(res[sch.id]["es_visita_express"])
        orden.write({"active": False})
        self.assertNotIn(sch.id, self._ids(self.u_a))

    def test_regresion_igual_que_la_version_previa_sin_carteras(self):
        """Sin carteras, el método nuevo devuelve LO MISMO que la versión
        previa (salvo las 2 claves nuevas), para todos los usuarios y
        varias ventanas, con un exprés y un ciclo completado en el mix."""
        previo = metodo_previo()
        ruta2 = self.env["fsm.route"].create({"name": "R2 prueba", "fsm_person_id": self.per_b.id})
        loc2 = self.env["fsm.location"].create({"name": "Cliente R2", "fsm_route_id": ruta2.id, "x_orden_ruta": 1})
        sch2 = self.env["fsm.route.schedule"].create(
            {"route_id": ruta2.id, "date_start": self.hoy - timedelta(days=40), "date_end": self.hoy - timedelta(days=34)})
        sch2.action_generar_visitas()
        sch3 = self.env["fsm.route.schedule"].create(
            {"route_id": ruta2.id, "date_start": self.hoy + timedelta(days=7), "date_end": self.hoy + timedelta(days=13)})
        exp = self.env["fsm.route"].create({"name": "Exprés", "fsm_person_id": self.per_a.id, "x_es_visita_express": True})
        sch4 = self.env["fsm.route.schedule"].create({"route_id": exp.id, "date_start": self.hoy, "date_end": self.hoy})
        exp_loc = self.clientes["B1"]
        self.env["fsm.order"].create({"name": "exp", "location_id": exp_loc.id, "x_route_schedule_id": sch4.id,
                                      "stage_id": self.env.ref("shalom_location_map.shalom_fsm_stage_order_new").id})
        ventanas = [(self.ds, self.de), ("2000-01-01", "2000-01-02"), ("2099-01-01", "2099-01-31"),
                    (fields.Date.to_string(self.hoy - timedelta(days=45)), fields.Date.to_string(self.hoy + timedelta(days=30)))]
        vistos = 0
        for user in (self.u_a, self.u_b, self.u_c, self.u_mgr, self.u_min):
            for ds, de in ventanas:
                nuevo = self.env["fsm.person"].with_user(user).shalom_mis_rutas_programadas(ds, de)
                viejo = previo(self.env["fsm.person"].with_user(user), ds, de)
                vistos += len(viejo)
                self.assertEqual([{k: v for k, v in r.items() if k not in NUEVAS} for r in nuevo], viejo,
                                 (user.login, ds, de))
                for r in nuevo:
                    self.assertEqual(set(r) & NUEVAS, NUEVAS)
                    self.assertFalse(r["tiene_cartera"])
        self.assertGreater(vistos, 5, "la comparación debe tener datos")

    def test_regresion_con_carteras_mismas_filas_para_el_dueno(self):
        previo = metodo_previo()
        antes = previo(self.env["fsm.person"].with_user(self.u_a), self.ds, self.de)
        self._repartir([self.per_a, self.per_b])
        despues = self._mis(self.u_a)
        self.assertEqual([{k: v for k, v in r.items() if k not in NUEVAS} for r in despues], antes)
