# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Wizard de administración: borra varias fsm.location seleccionadas a la
vez desde el listado de Ubicaciones de Servicio (menú de acciones ⚙️
de la lista, con la selección hecha a mano), sin tocar nunca los
contactos detrás -- mismo criterio que el botón "Eliminar esta
Ubicación" de la ficha individual (ver
_shalom_eliminar_ubicacion_o_motivo() en models/fsm_location.py), solo
que acá se aplica a varias filas de una sola vez.

Cada Ubicación se procesa por separado: si alguna no se puede borrar
(por ejemplo, es la única Ubicación de su contacto y tiene visitas en
su historial), esa fila se omite con el motivo y el resto de la
selección sigue procesándose -- un caso puntual que falle no frena
todo el lote.
"""
import logging

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)


class ShalomEliminarUbicacionesWizard(models.TransientModel):
    _name = "shalom.eliminar.ubicaciones.wizard"
    _description = "Eliminar varias Ubicaciones (solo la Ubicación, nunca el contacto)"

    location_ids = fields.Many2many("fsm.location", string="Ubicaciones a eliminar")

    @api.model
    def default_get(self, fields_list):
        vals = super().default_get(fields_list)
        location_ids = self.env.context.get("active_ids") or []
        vals["location_ids"] = [(6, 0, location_ids)]
        return vals

    def action_eliminar(self):
        """Botón 'Eliminar seleccionadas' (con confirmación en la
        vista): procesa cada Ubicación de location_ids por separado,
        acumulando cuántas se borraron y cuáles se omitieron (con
        motivo), en vez de frenar todo el lote por un caso puntual."""
        self.ensure_one()
        if not self.location_ids:
            raise UserError(_("No seleccionaste ninguna Ubicación."))

        borradas = 0
        omitidas = []
        for location in self.location_ids:
            nombre = location.name
            motivo = location._shalom_eliminar_ubicacion_o_motivo()
            if motivo:
                omitidas.append(f"{nombre}: {motivo}")
            else:
                borradas += 1

        _logger.info(
            "Borrado en lote de Ubicaciones desde el listado: %s "
            "borrada(s), %s omitida(s).", borradas, len(omitidas),
        )

        mensaje = _("%(borradas)s Ubicación(es) eliminada(s).", borradas=borradas)
        if omitidas:
            mensaje += "\n" + _(
                "%(cantidad)s omitida(s):", cantidad=len(omitidas)
            ) + "\n" + "\n".join(omitidas)

        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Borrado en lote terminado"),
                "message": mensaje,
                "sticky": bool(omitidas),
                "type": "success" if not omitidas else "warning",
            },
        }
