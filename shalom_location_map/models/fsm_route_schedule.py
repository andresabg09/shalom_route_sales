# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
fsm.route.schedule: una "ocurrencia" de una fsm.route para un ciclo
concreto (no siempre una semana: cada ruta tiene su propia duración
típica, ver x_duracion_dias en fsm_route.py -- puede ser 1 día, 3
días, una semana...). La fsm.route en sí sigue siendo solo la lista
ordenada de clientes (no cambia); este modelo nuevo es lo que permite
decir "la Ruta Zona Este se recorre del 1 al 5 de septiembre", que es
lo que la pestaña "Rutas" de la app del vendedor necesita mostrar
agrupado/filtrado por ciclo o mes.

date_end es 100% editable a mano (antes era un compute fijo a
date_start + 6 días) -- solo se SUGIERE con la duración típica de la
ruta cuando se completa date_start con date_end todavía vacío (ver
_onchange_date_start_sugerir_fin), sin pisar nunca un valor ya
cargado.

Un mismo vendedor puede recorrer la misma ruta muchas veces al año
(ej. mensual): "Generar próximo ciclo" (ver action_generar_proximo_
ciclo) crea la fsm.route.schedule del ciclo siguiente para la misma
ruta en un solo paso -- cerrando primero, como "No atendido", las
visitas de este ciclo que quedaron sin cerrar, para que no bloqueen la
generación de las nuevas (ver action_generar_visitas_ruta en
fsm_route.py: no duplica visitas si el cliente ya tiene una orden
abierta). También sigue existiendo la opción de crear la fila a mano,
con el tiempo estimado a mano. La capacidad esperada de venta y el
estado de avance se calculan solos.
"""
import logging
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Mismo criterio que fsm_order.py: "venta real" = confirmada, no
# borrador ni cancelada.
ESTADOS_VENTA_CONFIRMADA = ("sale", "done")


class FSMRouteSchedule(models.Model):
    _name = "fsm.route.schedule"
    _description = "Programación de Ruta (ciclo)"
    _order = "date_start desc, route_id"

    route_id = fields.Many2one(
        "fsm.route",
        string="Ruta",
        required=True,
        ondelete="cascade",
    )
    date_start = fields.Date(
        string="Inicio del ciclo",
        required=True,
        help="Primer día en que se recorre esta ruta en este ciclo.",
    )
    date_end = fields.Date(
        string="Fin del ciclo",
        required=True,
        help="Último día en que se recorre esta ruta en este ciclo. "
        "Editable siempre a mano -- no todas las rutas duran una "
        "semana. Se sugiere solo (a partir de la Duración típica del "
        "ciclo configurada en la ruta) la primera vez que se completa "
        "Inicio del ciclo con este campo todavía vacío.",
    )
    x_tiempo_estimado = fields.Float(
        string="Tiempo estimado (horas)",
        help="Duración estimada de recorrer toda la ruta en este "
        "ciclo, cargada a mano por oficina al planificar.",
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
        "cerradas (Completada, No quiso, Cancelado o No atendido).",
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

    @api.onchange("date_start", "route_id")
    def _onchange_date_start_sugerir_fin(self):
        """Sugiere date_end a partir de la Duración típica del ciclo
        (días) de la ruta -- SOLO si date_end todavía está vacío, para
        no pisar nunca un valor ya cargado a mano (ej. al editar una
        programación existente, o si oficina ya escribió su propia
        fecha de fin antes de terminar de completar date_start)."""
        for rec in self:
            if rec.date_start and rec.route_id and not rec.date_end:
                dias = rec.route_id.x_duracion_dias or 7
                rec.date_end = rec.date_start + timedelta(days=max(dias - 1, 0))

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

    def action_generar_proximo_ciclo(self):
        """Botón: arranca el ciclo siguiente de esta misma ruta en un
        solo paso, para no tener que reprogramar cada ruta a mano cada
        vez que se repite (ej. mensual):

        1. Las visitas de ESTA ocurrencia que quedaron sin cerrar (el
           vendedor no llegó/no dio tiempo) se cierran solas como "No
           atendido" -- si no se hiciera esto, action_generar_visitas_
           ruta las vería como "orden abierta" del cliente y se
           saltaría a esos clientes en el ciclo nuevo, dejándolos sin
           visita generada (el síntoma reportado: "tengo 37 clientes
           pero solo se generan 9").
        2. Se archivan las visitas ya cerradas de la ruta (reusa
           action_archivar_visitas_cerradas), para no acumular ruido de
           ciclo en ciclo.
        3. Se crea la fsm.route.schedule del ciclo siguiente para la
           misma ruta: date_start = date_end de esta + 1 día, date_end
           sugerido por x_duracion_dias de la ruta.
        4. Se generan las visitas de esa ocurrencia nueva -- ya sin
           bloqueo, porque el paso 1 dejó todo cerrado.
        """
        self.ensure_one()

        stage_no_atendido = self.env.ref(
            "shalom_location_map.shalom_fsm_stage_no_atendido", raise_if_not_found=False
        )
        if not stage_no_atendido:
            raise UserError(
                _("No se encontró la etapa 'No atendido'. Revisá que el "
                  "módulo esté actualizado (data/fsm_stage_no_atendido.xml).")
            )
        if not self.date_end:
            raise UserError(
                _("Esta programación no tiene fecha de fin cargada. "
                  "Completala antes de generar el ciclo siguiente.")
            )

        abiertas = self.fsm_order_ids.filtered(lambda o: not o.stage_id.is_closed)
        if abiertas:
            abiertas.write({"stage_id": stage_no_atendido.id})
        self.route_id.action_archivar_visitas_cerradas()

        duracion = self.route_id.x_duracion_dias or 7
        date_start_nuevo = self.date_end + timedelta(days=1)
        date_end_nuevo = date_start_nuevo + timedelta(days=max(duracion - 1, 0))
        nueva = self.create({
            "route_id": self.route_id.id,
            "date_start": date_start_nuevo,
            "date_end": date_end_nuevo,
        })

        resultado = nueva.action_generar_visitas()

        mensaje = _(
            "Ciclo siguiente de '%(ruta)s' generado (%(inicio)s - "
            "%(fin)s). %(no_atendidas)s visita(s) del ciclo anterior "
            "sin cerrar se marcaron como 'No atendido'. %(detalle)s",
            ruta=self.route_id.name,
            inicio=date_start_nuevo.strftime("%d/%m"),
            fin=date_end_nuevo.strftime("%d/%m"),
            no_atendidas=len(abiertas),
            detalle=resultado.get("params", {}).get("message", ""),
        )
        _logger.info(mensaje)

        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Próximo ciclo generado"),
                "message": mensaje,
                "sticky": False,
                "type": "success",
            },
        }

    def name_get(self):
        result = []
        for rec in self:
            rango = ""
            if rec.date_start and rec.date_end:
                rango = f" ({rec.date_start.strftime('%d/%m')} - {rec.date_end.strftime('%d/%m')})"
            result.append((rec.id, f"{rec.route_id.name}{rango}"))
        return result
