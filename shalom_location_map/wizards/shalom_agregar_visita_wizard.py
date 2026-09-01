# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Wizard chiquito: "Agregar cliente a esta ocurrencia" en el formulario
de Programación de Ruta (fsm.route.schedule). Resuelve el caso real
reportado: un cliente se agregó a una ruta después de generar el
ciclo (o hay que sumarlo a mitad de camino), y "Generar visitas de
esta ocurrencia" no sirve para eso -- ese botón toca a TODOS los
clientes de la ruta (cierra como "No atendido" cualquier visita vieja
abierta), lo que resetearía el trabajo en curso del vendedor si ya
había visitas del ciclo sin cerrar.

Este wizard hace lo opuesto: crea UNA sola fsm.order, para UN cliente
puntual, dentro de la misma ocurrencia -- sin tocar ninguna otra
visita. Ver fsm.route.schedule.action_agregar_visita() en
fsm_route_schedule.py para la lógica real (reusa
_shalom_crear_visita_para_location() de fsm.route, el mismo núcleo
que usa el generado masivo).
"""
from odoo import _, fields, models
from odoo.exceptions import UserError


class ShalomAgregarVisitaWizard(models.TransientModel):
    _name = "shalom.agregar.visita.wizard"
    _description = "Agregar un cliente puntual a una ocurrencia de ruta"

    schedule_id = fields.Many2one(
        "fsm.route.schedule",
        string="Ocurrencia",
        required=True,
        readonly=True,
    )
    route_id = fields.Many2one(
        related="schedule_id.route_id",
        string="Ruta",
        readonly=True,
        help="Solo para filtrar el selector de cliente de abajo a los "
        "de esta ruta -- no editable acá.",
    )
    location_id = fields.Many2one(
        "fsm.location",
        string="Cliente",
        required=True,
        help="Cliente de esta ruta al que le falta la visita de este "
        "ciclo. Si ya tiene una visita ABIERTA en esta ocurrencia, "
        "no se puede agregar de nuevo (evita duplicados por error).",
    )

    def action_agregar(self):
        """Botón 'Agregar visita': delega en
        fsm.route.schedule.action_agregar_visita(), que valida que el
        cliente pertenezca a la ruta y que no tenga ya una visita
        abierta en esta ocurrencia antes de crear la nueva."""
        self.ensure_one()
        if not self.location_id:
            raise UserError(_("Elegí un cliente antes de agregar la visita."))
        return self.schedule_id.action_agregar_visita(self.location_id.id)
