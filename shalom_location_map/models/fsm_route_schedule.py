# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
fsm.route.schedule: una "ocurrencia" de una fsm.route para una semana
concreta. La fsm.route en sí sigue siendo solo la lista ordenada de
clientes (no cambia); este modelo nuevo es lo que permite decir "la
Ruta Zona Este se recorre la semana del 1 al 5 de septiembre", que es
lo que la pestaña "Rutas" de la app del vendedor necesita mostrar
agrupado/filtrado por semana o mes.

No hay recurrencia automática en esta primera versión: oficina crea una
fila nueva por cada semana que quiere programar una ruta, con el tiempo
estimado a mano. La capacidad esperada de venta y el estado de avance
se calculan solos.
"""
import logging
from datetime import timedelta

from odoo import _, api, fields, models

_logger = logging.getLogger(__name__)

# Mismo criterio que fsm_order.py: "venta real" = confirmada, no
# borrador ni cancelada.
ESTADOS_VENTA_CONFIRMADA = ("sale", "done")


class FSMRouteSchedule(models.Model):
    _name = "fsm.route.schedule"
    _description = "Programación semanal de Ruta"
    _order = "date_start desc, route_id"

    route_id = fields.Many2one(
        "fsm.route",
        string="Ruta",
        required=True,
        ondelete="cascade",
    )
    date_start = fields.Date(
        string="Inicio de semana",
        required=True,
        help="Primer día de la semana en que se recorre esta ruta.",
    )
    date_end = fields.Date(
        string="Fin de semana",
        compute="_compute_date_end",
        store=True,
        help="Se calcula solo como Inicio de semana + 6 días.",
    )
    x_tiempo_estimado = fields.Float(
        string="Tiempo estimado (horas)",
        help="Duración estimada de recorrer toda la ruta esta semana, "
        "cargada a mano por oficina al planificar.",
    )
    capacidad = fields.Monetary(
        string="Capacidad de la ruta",
        compute="_compute_capacidad",
        currency_field="currency_id",
        help="Suma del último sale.order CONFIRMADO (no borrador) de "
        "cada cliente de la ruta: una estimación de cuánto puede "
        "vender el vendedor si visita a todos. Se recalcula al leerse, "
        "no queda guardada en la base.",
    )
    currency_id = fields.Many2one(
        "res.currency",
        default=lambda self: self.env.company.currency_id,
    )
    estado = fields.Selection(
        [
            ("por_iniciar", "Por iniciar"),
            ("en_curso", "En curso"),
            ("completada", "Completada"),
        ],
        string="Estado",
        compute="_compute_estado",
        help="Por iniciar: ninguna visita generada tiene todavía una "
        "etapa cerrada. En curso: alguna sí y otras no. Completada: "
        "todas las visitas generadas para esta ocurrencia ya están "
        "cerradas (Completada, No quiso o Cancelado).",
    )
    fsm_order_ids = fields.One2many(
        "fsm.order",
        "x_route_schedule_id",
        string="Visitas generadas",
    )
    cantidad_clientes = fields.Integer(
        string="Clientes",
        compute="_compute_cantidad_clientes",
        help="Cantidad de Ubicaciones de Servicio de la ruta (no de "
        "visitas ya generadas).",
    )
    fsm_person_id = fields.Many2one(
        related="route_id.fsm_person_id",
        string="Vendedor",
        store=True,
    )
    company_id = fields.Many2one(
        "res.company", default=lambda self: self.env.company
    )
    active = fields.Boolean(default=True)

    @api.depends("date_start")
    def _compute_date_end(self):
        for rec in self:
            rec.date_end = (
                rec.date_start + timedelta(days=6) if rec.date_start else False
            )

    @api.depends("fsm_order_ids.stage_id.is_closed")
    def _compute_estado(self):
        for rec in self:
            orders = rec.fsm_order_ids
            if not orders:
                rec.estado = "por_iniciar"
                continue
            cerradas = orders.filtered(lambda o: o.stage_id.is_closed)
            if not cerradas:
                rec.estado = "por_iniciar"
            elif len(cerradas) == len(orders):
                rec.estado = "completada"
            else:
                rec.estado = "en_curso"

    @api.depends("route_id")
    def _compute_cantidad_clientes(self):
        for rec in self:
            rec.cantidad_clientes = self.env["fsm.location"].search_count(
                [("fsm_route_id", "=", rec.route_id.id)]
            )

    @api.depends("route_id")
    def _compute_capacidad(self):
        for rec in self:
            locations = self.env["fsm.location"].search(
                [("fsm_route_id", "=", rec.route_id.id)]
            )
            total = 0.0
            for location in locations:
                partner = location.partner_id
                if not partner:
                    continue
                ultima = self.env["sale.order"].search(
                    [
                        ("partner_id", "=", partner.id),
                        ("state", "in", list(ESTADOS_VENTA_CONFIRMADA)),
                    ],
                    order="date_order desc",
                    limit=1,
                )
                if ultima:
                    total += ultima.amount_total
            rec.capacidad = total

    def action_generar_visitas(self):
        """Botón: igual que 'Generar visitas de esta ruta' en fsm.route,
        pero taggeando cada fsm.order creada con esta ocurrencia
        (x_route_schedule_id), para que la app del vendedor sepa qué
        visitas corresponden a qué semana."""
        self.ensure_one()
        return self.route_id.action_generar_visitas_ruta(schedule=self)

    def name_get(self):
        result = []
        for rec in self:
            rango = ""
            if rec.date_start and rec.date_end:
                rango = f" ({rec.date_start.strftime('%d/%m')} - {rec.date_end.strftime('%d/%m')})"
            result.append((rec.id, f"{rec.route_id.name}{rango}"))
        return result
