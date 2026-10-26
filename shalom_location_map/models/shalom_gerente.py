# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Administración → pestaña "Gerente" (Fase 7 del juego de ventas): la vista
del dueño. Todo es SOLO para el rol Administrador de Servicio de Campo
(fieldservice.group_fsm_manager) y se lee con sudo() lo que haga falta,
porque son totales de toda la empresa. Es la única vista que devuelve
costo y utilidad en dólares: el vendedor nunca los ve.

Métodos (todos @api.model, colgados de fsm.route para no crear un modelo
nuevo ni permisos nuevos):

- shalom_admin_reasignar_ruta(route_id, person_id, simular=False):
  pasa una ruta a otro vendedor.
- shalom_admin_reparto_rutas(): valor esperado mensual de cada ruta,
  agrupado por vendedor ("Reparto de rutas").
- shalom_admin_gerente_mes(): cómo va el mes (ventas contra piso y
  meta, margen, oxigenta por cada 100 tintes, estrellas y XP).
- shalom_admin_salud_datos(): ubicaciones sin GPS, clientes buenos sin
  ruta, GPS prioritario ordenado por valor.

Los cálculos puros (porcentajes, oxigenta/100, agrupación del reparto)
están en gerente_utils.py y se prueban fuera de Odoo.
"""
import logging

from odoo import _, api, fields, models
from odoo.exceptions import UserError

from . import gerente_utils, juego_utils, tz_utils

_logger = logging.getLogger(__name__)

# Mismo criterio que el resto del módulo: "venta real" = confirmada.
ESTADOS_VENTA_CONFIRMADA = ("sale", "done")


class FSMRouteGerente(models.Model):
    _inherit = "fsm.route"

    # ------------------------------------------------------------------
    # Reasignar una ruta a otro vendedor
    # ------------------------------------------------------------------

    @api.model
    def _shalom_gerente_exigir(self):
        # Mismo guardia que el reparto de carteras y las estrategias.
        self.env["fsm.route.schedule"]._shalom_exigir_admin()

    @api.model
    def _shalom_visitas_de_ruta(self, ruta):
        """Visitas (fsm.order, sin archivadas) de una ruta: las que hoy
        apuntan a la ruta por su cliente o las que nacieron de un ciclo
        de esa ruta (el cliente pudo cambiarse de ruta después)."""
        return [
            "|",
            ("fsm_route_id", "=", ruta.id),
            ("x_route_schedule_id.route_id", "=", ruta.id),
        ]

    @api.model
    def shalom_admin_reasignar_ruta(self, route_id, person_id, simular=False):
        """Pasa la ruta `route_id` al vendedor `person_id` (fsm.person).

        1. Cambia fsm_person_id de la ruta.
        2. Pasa al vendedor nuevo el person_id de las visitas ABIERTAS de
           la ruta que seguían a nombre del anterior (el person_id de una
           visita se calcula una sola vez, al crearla: cambiar el dueño de
           la ruta no lo mueve solo, y el vendedor nuevo no las vería a su
           nombre en Field Service).
        3. NO toca visitas cerradas ni archiva nada.
        4. Si había cartera repartida (x_cartera_*) en visitas abiertas de
           la ruta, la limpia: el reparto se hizo entre los vendedores
           anteriores y ya no vale. Hay que volver a repartir.

        Rechaza las rutas de Visita Exprés (son una por vendedor, se
        crean solas). Con simular=True no escribe nada y devuelve el
        mismo resumen en condicional: sirve para la confirmación de la
        pantalla ("esto es lo que va a cambiar")."""
        self._shalom_gerente_exigir()
        ruta = self.sudo().browse(route_id).exists()
        persona = self.env["fsm.person"].sudo().browse(person_id).exists()
        if not ruta:
            raise UserError(_("La ruta no existe."))
        if not persona:
            raise UserError(_("El vendedor no existe."))
        if ruta.x_es_visita_express:
            raise UserError(
                _("«%(ruta)s» es una Visita Exprés: se crea sola para cada "
                  "vendedor y no se reasigna.", ruta=ruta.name)
            )
        anterior = ruta.fsm_person_id
        if anterior == persona:
            raise UserError(
                _("«%(ruta)s» ya es de %(persona)s.", ruta=ruta.name, persona=persona.name)
            )

        Visita = self.env["fsm.order"].sudo()
        base = self._shalom_visitas_de_ruta(ruta)
        abiertas = Visita.search(base + [("stage_id.is_closed", "=", False)])
        a_pasar = abiertas.filtered(
            lambda v: (v.person_id == anterior) if anterior else not v.person_id
        )
        con_cartera = abiertas.filtered("x_cartera_person_id")
        cerradas = Visita.search_count(base + [("stage_id.is_closed", "=", True)])
        ciclos_con_cartera = sorted(
            {v.x_route_schedule_id.display_name for v in con_cartera if v.x_route_schedule_id}
        )
        resumen = {
            "simulado": bool(simular),
            "ruta_id": ruta.id,
            "ruta": ruta.name,
            "anterior": {"id": anterior.id, "nombre": anterior.name} if anterior else None,
            "nuevo": {"id": persona.id, "nombre": persona.name},
            "visitas_abiertas": len(abiertas),
            "visitas_pasadas": len(a_pasar),
            "visitas_de_otro": len(abiertas) - len(a_pasar),
            "visitas_cerradas_intactas": cerradas,
            "cartera_limpiada": len(con_cartera),
            "ciclos_con_cartera": ciclos_con_cartera,
        }
        if simular:
            return resumen

        # Se escribe como el gerente (no sudo): queda su nombre en el
        # historial de cambios de la ruta y las visitas.
        ruta_usuario = self.browse(ruta.id)
        ruta_usuario.write({"fsm_person_id": persona.id})
        if a_pasar:
            self.env["fsm.order"].browse(a_pasar.ids).write({"person_id": persona.id})
        if con_cartera:
            self.env["fsm.order"].browse(con_cartera.ids).write({
                "x_cartera_person_id": False,
                "x_cartera_fecha": False,
                "x_cartera_orden": 0,
                "x_cartera_reserva": False,
            })
        _logger.info(
            "Ruta '%s' (id=%s) reasignada de %s a %s por %s: %s visita(s) abierta(s) "
            "pasadas, %s con cartera limpiada.",
            ruta.name, ruta.id, anterior.name or "nadie", persona.name,
            self.env.user.login, len(a_pasar), len(con_cartera),
        )
        return resumen
