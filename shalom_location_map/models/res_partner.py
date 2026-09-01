# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Extiende res.partner con un botón "Crear Ubicación de Servicio" en la
ficha de Contactos: hace falta para un caso real encontrado en
producción -- un contacto viejo (activo, con historial) que nunca
tuvo una fsm.location asociada. El formulario nativo de "Nuevo" en
Ubicaciones de Servicio no sirve para este caso: por cómo funciona
_inherits (fsm.location delegando en res.partner vía partner_id), ese
formulario SIEMPRE crea un Contacto nuevo al guardar -- el campo
"Contacto Relacionado" queda de solo lectura ahí a propósito, nunca
deja elegir uno ya existente. No hay ningún camino nativo para decirle
"usá este contacto que ya tengo".

Este botón resuelve exactamente eso: crea la fsm.location pasando el
partner_id/owner_id del contacto YA EXISTENTE (nunca crea un Contacto
nuevo), y abre esa Ubicación recién creada para completar el resto
(Ruta, Orden de Ruta, GPS, etc.) a mano.
"""
import logging

from odoo import fields, models

_logger = logging.getLogger(__name__)


class ResPartner(models.Model):
    _inherit = "res.partner"

    # Nombre de la persona con la que el vendedor habla en el local --
    # distinto del nombre comercial (name), que es el del negocio.
    # fsm.location lo hereda automáticamente vía _inherits (delegate=True
    # sobre partner_id), así que queda disponible como
    # location_id.x_nombre_contacto sin tocar fsm_location.py. Ver
    # shalom_campos_cliente_faltantes() en fsm_order.py, que lo exige
    # para poder cerrar una visita en Completado/No quiso.
    x_nombre_contacto = fields.Char(string="Nombre del contacto")

    def action_crear_ubicacion_servicio(self):
        """Botón 'Crear Ubicación de Servicio' en la ficha de
        Contactos: crea una fsm.location vinculada a ESTE contacto
        (partner_id y owner_id = self), sin duplicar el Contacto --
        ver el docstring del módulo para el porqué hace falta esto
        aparte del formulario nativo de Ubicaciones de Servicio."""
        self.ensure_one()
        location = self.env["fsm.location"].create(
            {
                "partner_id": self.id,
                # owner_id es obligatorio en fsm.location (ver el
                # mismo comentario en shalom_crear_cliente_rapido, en
                # fsm_location.py) -- acá el dueño es el mismo
                # contacto, igual que en ese otro flujo.
                "owner_id": self.id,
            }
        )
        _logger.info(
            "Ubicación de Servicio creada desde la ficha de Contacto: "
            "fsm.location id=%s vinculada a res.partner id=%s (%s), "
            "sin crear un contacto nuevo.",
            location.id, self.id, self.name,
        )
        return {
            "type": "ir.actions.act_window",
            "res_model": "fsm.location",
            "res_id": location.id,
            "view_mode": "form",
            "views": [[False, "form"]],
            "target": "current",
        }
