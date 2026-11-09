# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""Quién está trabajando cada ruta (ciclo): cualquier vendedor puede elegir
cualquier ruta; esta tabla solo deja a la vista del otro que ya la tomaron.

Una "toma" se crea al apretar "Tomar esta ruta" o sola al atender el primer
cliente del ciclo, y se renueva con cada visita atendida. Deja de contar
sola a los DIAS_VIGENCIA días sin actividad (no hace falta ningún cron: la
vigencia se calcula al leer)."""
from datetime import timedelta

from odoo import api, fields, models

DIAS_VIGENCIA = 3


class ShalomRutaToma(models.Model):
    _name = "shalom.ruta.toma"
    _description = "Ruta tomada por un vendedor"

    schedule_id = fields.Many2one(
        "fsm.route.schedule", required=True, index=True, ondelete="cascade"
    )
    person_id = fields.Many2one("fsm.person", required=True, ondelete="cascade")
    ultima_actividad = fields.Datetime(default=fields.Datetime.now, required=True)
    manual = fields.Boolean(help="Se tomó con el botón, antes de atender a nadie.")

    _sql_constraints = [
        ("unica_por_vendedor", "unique(schedule_id, person_id)",
         "Un vendedor solo puede tener una toma por ruta."),
    ]

    @api.model
    def _shalom_tomar(self, schedule, persona, manual=False):
        """Crea o renueva la toma de `persona` sobre `schedule` (con sudo:
        el vendedor no escribe esta tabla directamente)."""
        if not schedule or not persona:
            return
        toma = self.sudo().search(
            [("schedule_id", "=", schedule.id), ("person_id", "=", persona.id)], limit=1
        )
        vals = {"ultima_actividad": fields.Datetime.now()}
        if manual:
            vals["manual"] = True
        if toma:
            toma.write(vals)
        else:
            self.sudo().create({"schedule_id": schedule.id, "person_id": persona.id, **vals})

    @api.model
    def _shalom_soltar(self, schedule, persona):
        self.sudo().search(
            [("schedule_id", "=", schedule.id), ("person_id", "=", persona.id)]
        ).unlink()

    @api.model
    def _shalom_vigentes(self, schedule_ids, persona):
        """{schedule_id: [{"person_id", "nombre", "inicial", "color", "es_yo"}]}
        de las tomas con actividad en los últimos DIAS_VIGENCIA días."""
        if not schedule_ids:
            return {}
        limite = fields.Datetime.now() - timedelta(days=DIAS_VIGENCIA)
        resultado = {}
        tomas = self.sudo().search(
            [("schedule_id", "in", list(schedule_ids)), ("ultima_actividad", ">=", limite)],
            order="ultima_actividad asc",
        )
        for t in tomas:
            resultado.setdefault(t.schedule_id.id, []).append({
                "person_id": t.person_id.id,
                "nombre": t.person_id.name,
                "inicial": (t.person_id.name or "?").strip()[:1].upper(),
                "color": t.person_id.id % 6,
                "es_yo": bool(persona) and t.person_id.id == persona.id,
            })
        return resultado
