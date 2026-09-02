# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Extiende fsm.person (el vendedor) con métodos "mis datos" que usa la
app de ruta del vendedor (Owl) para pedir, en una sola llamada, todo lo
que le corresponde ver al usuario logueado: sus rutas programadas, su
directorio de clientes y sus cotizaciones -- sin que el frontend tenga
que reconstruir esos dominios a mano en cada pantalla.

"Asignado a mí" se resuelve siempre igual: el fsm.person del usuario
logueado (fsm.person.user_id = uid), y de ahí las fsm.route donde
fsm_person_id sea ese fsm.person -- reutiliza el mismo campo que ya usa
el resto del stack de Field Service, sin pedirle a oficina que cargue
un dato nuevo de asignación.
"""
import logging

from odoo import _, api, models
from odoo.exceptions import AccessError

_logger = logging.getLogger(__name__)

# Mismo criterio que fsm_order.py y fsm_route_schedule.py.
ESTADOS_VENTA_CONFIRMADA = ("sale", "done")


class FSMPerson(models.Model):
    _inherit = "fsm.person"

    @api.model
    def _shalom_persona_actual(self):
        """fsm.person del usuario logueado, o recordset vacío si no
        tiene ninguno vinculado (por ejemplo, un admin sin fsm.person
        propio)."""
        return self.search([("user_id", "=", self.env.uid)], limit=1)

    @api.model
    def shalom_mis_rutas_programadas(self, date_start, date_end):
        """Ocurrencias de fsm.route.schedule de las rutas asignadas al
        vendedor logueado cuya semana se solape con [date_start,
        date_end] (strings 'YYYY-MM-DD'), MÁS cualquier ocurrencia que
        todavía no esté completada (estado != 'completada') aunque su
        fecha haya quedado afuera de esa ventana -- para que una ruta
        con clientes sin atender no se pierda de vista solo porque
        pasó su fecha de fin estimada; una vez que de verdad se cierra
        del todo (todas las visitas en una etapa cerrada), recién ahí
        puede salir de la ventana por fecha como cualquier otra.
        Devuelve datos ya listos para la pestaña 'Rutas' de la app,
        sin que el frontend tenga que hacer una segunda llamada por
        ruta."""
        persona = self._shalom_persona_actual()
        if not persona:
            return []
        schedules = self.env["fsm.route.schedule"].search(
            [
                ("fsm_person_id", "=", persona.id),
                "|",
                "&", ("date_start", "<=", date_end), ("date_end", ">=", date_start),
                ("estado", "!=", "completada"),
            ],
            order="date_start asc",
        )
        return [
            {
                "id": s.id,
                "route_id": s.route_id.id,
                "route_name": s.route_id.name,
                "date_start": s.date_start.isoformat(),
                "date_end": s.date_end.isoformat(),
                "tiempo_estimado": s.x_tiempo_estimado,
                "capacidad": s.capacidad,
                "estado": s.estado,
                "cantidad_clientes": s.cantidad_clientes,
            }
            for s in schedules
        ]

    @api.model
    def shalom_mis_rutas(self):
        """Rutas (fsm.route) asignadas al vendedor logueado -- para el
        selector de ruta del formulario ampliado de cliente (Editar
        cliente / Alta rápida). Distinto de
        shalom_mis_rutas_programadas(): acá se listan las rutas en sí,
        no sus ocurrencias semanales."""
        persona = self._shalom_persona_actual()
        if not persona:
            return []
        rutas = self.env["fsm.route"].search(
            [("fsm_person_id", "=", persona.id)], order="name asc"
        )
        return [{"id": r.id, "name": r.name} for r in rutas]

    @api.model
    def shalom_mis_clientes(self):
        """Directorio de fsm.location asignadas (vía la ruta que las
        contiene) al vendedor logueado. Un mismo vendedor puede tener
        varias rutas -- se incluye a cuál pertenece cada cliente
        (fsm_route_id/fsm_route_name) para mostrarlo en la lista y para
        el formulario ampliado de edición (RUC/celular/correo vienen
        del contacto, res.partner)."""
        persona = self._shalom_persona_actual()
        if not persona:
            return []
        rutas = self.env["fsm.route"].search([("fsm_person_id", "=", persona.id)])
        if not rutas:
            return []
        # Ordenados por ruta y después por posición dentro de la ruta
        # (x_orden_ruta) -- sin esto, reordenar un cliente desde
        # ClienteForm cambiaba bien el número pero la lista de la
        # pestaña Clientes seguía mostrándolos en el orden de creación,
        # sin reflejar el reordenamiento.
        locations = self.env["fsm.location"].search(
            [("fsm_route_id", "in", rutas.ids)],
            order="fsm_route_id, x_orden_ruta asc",
        )
        return [
            {
                "id": loc.id,
                "name": loc.name,
                "phone": loc.phone,
                "street": loc.street,
                "street2": loc.street2,
                "partner_id": loc.partner_id.id if loc.partner_id else False,
                "x_orden_ruta": loc.x_orden_ruta,
                "fsm_route_id": loc.fsm_route_id.id if loc.fsm_route_id else False,
                "fsm_route_name": loc.fsm_route_id.name if loc.fsm_route_id else "",
                "vat": loc.partner_id.vat if loc.partner_id else False,
                "mobile": loc.partner_id.mobile if loc.partner_id else False,
                "email": loc.partner_id.email if loc.partner_id else False,
            }
            for loc in locations
        ]

    @api.model
    def shalom_mis_cotizaciones(self):
        """sale.order de todos los clientes asignados al vendedor
        logueado (no solo los de la ruta de hoy), de más reciente a
        más antigua. Incluye borradores y confirmadas; excluye
        canceladas."""
        persona = self._shalom_persona_actual()
        if not persona:
            return []
        rutas = self.env["fsm.route"].search([("fsm_person_id", "=", persona.id)])
        if not rutas:
            return []
        locations = self.env["fsm.location"].search(
            [("fsm_route_id", "in", rutas.ids)]
        )
        partner_ids = locations.mapped("partner_id").ids
        if not partner_ids:
            return []
        orders = self.env["sale.order"].search(
            [("partner_id", "in", partner_ids), ("state", "!=", "cancel")],
            order="date_order desc",
        )
        return [
            {
                "id": o.id,
                "name": o.name,
                "partner_name": o.partner_id.name,
                "date_order": o.date_order.isoformat() if o.date_order else False,
                "amount_total": o.amount_total,
                "confirmada": o.state in ESTADOS_VENTA_CONFIRMADA,
            }
            for o in orders
        ]

    @api.model
    def shalom_admin_rutas_programadas(self):
        """Administración → Rutas de mis vendedores: TODAS las
        ocurrencias de fsm.route.schedule todavía no completadas, de
        TODOS los vendedores (no solo el usuario logueado), agrupadas
        por vendedor -- para el selector "vendedor primero, en
        cascada" (Opción A del mockup). Mismo criterio de "abierta"
        que shalom_mis_rutas_programadas(), sin la restricción de
        fsm_person_id."""
        if not self.env.user.has_group("fieldservice.group_fsm_manager"):
            raise AccessError(_(
                "Esta acción es solo para el rol Administrador de "
                "Servicio de Campo."
            ))
        schedules = self.env["fsm.route.schedule"].search(
            [("estado", "!=", "completada")],
            order="fsm_person_id, date_start asc",
        )
        vendedores = {}
        for s in schedules:
            persona = s.fsm_person_id
            if not persona:
                continue
            if persona.id not in vendedores:
                vendedores[persona.id] = {
                    "persona_id": persona.id,
                    "persona_nombre": persona.name,
                    "rutas": [],
                }
            vendedores[persona.id]["rutas"].append(
                {
                    "id": s.id,
                    "route_id": s.route_id.id,
                    "route_name": s.route_id.name,
                    "cantidad_clientes": s.cantidad_clientes,
                    "estado": s.estado,
                }
            )
        return list(vendedores.values())
