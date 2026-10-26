# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Libro de eventos del juego de ventas: una fila por pedido confirmado
desde la app con sus estrellas y XP. El XP y el nivel de cada vendedor
se calculan sumando este libro (el nivel nunca baja porque el XP solo
crece). Reglas en juego_utils.py.
"""
import logging

from odoo import api, fields, models

from . import juego_utils, tz_utils

_logger = logging.getLogger(__name__)


class ShalomJuegoEvento(models.Model):
    _name = "shalom.juego.evento"
    _description = "Evento del juego de ventas (pedido con estrellas y XP)"
    _order = "fecha desc, id desc"

    person_id = fields.Many2one("fsm.person", string="Vendedor", index=True, ondelete="set null")
    fecha = fields.Datetime(default=fields.Datetime.now, index=True)
    order_id = fields.Many2one("fsm.order", string="Visita", ondelete="set null")
    sale_id = fields.Many2one("sale.order", string="Pedido", ondelete="set null")
    location_id = fields.Many2one("fsm.location", string="Cliente", ondelete="set null")
    total = fields.Float()
    utilidad = fields.Float()
    margen_pct = fields.Float()
    estrellas = fields.Integer()
    record_roto = fields.Boolean()
    xp = fields.Integer()

    _sql_constraints = [
        (
            "sale_uniq",
            "unique(sale_id)",
            "Ese pedido ya tiene su resultado del juego registrado.",
        ),
    ]

    @api.model
    def _shalom_progreso_de(self, person):
        """XP total y nivel de un vendedor (fsm.person)."""
        grupo = self.sudo().read_group(
            [("person_id", "=", person.id)], ["xp:sum"], []
        ) if person else []
        xp_total = int(grupo[0]["xp"] or 0) if grupo else 0
        numero, nombre, desde, siguiente = juego_utils.nivel_de_xp(xp_total)
        return {
            "xp_total": xp_total,
            "nivel": numero,
            "nivel_nombre": nombre,
            "xp_nivel": desde,
            "xp_siguiente": siguiente,
        }

    @api.model
    def shalom_mi_progreso(self):
        """XP, nivel y resumen del mes del vendedor logueado, para la
        pestaña Rutas. Sin fsm.person vinculado devuelve None."""
        persona = self.env["fsm.person"]._shalom_persona_actual()
        if not persona:
            return None
        progreso = self._shalom_progreso_de(persona)
        inicio_mes = tz_utils.hoy_local(self.env).replace(day=1)
        eventos = self.sudo().search(
            [("person_id", "=", persona.id), ("fecha", ">=", tz_utils.inicio_de_dia_utc(self.env, inicio_mes))]
        )
        progreso.update(
            {
                "pedidos_mes": len(eventos),
                "ventas_mes": round(sum(eventos.mapped("total")), 2),
                "estrellas_mes": sum(eventos.mapped("estrellas")),
            }
        )
        return progreso
