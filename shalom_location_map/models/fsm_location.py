# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
fieldservice_geoengine dispara automáticamente un geo_localize() (llamada a
un servicio externo de geocoding) cada vez que se crea una fsm.location sin
partner_latitude/partner_longitude. Si ese servicio externo no está
disponible o falla, la excepción interrumpe toda la operación de creación.

Esta extensión hace que ese intento automático sea tolerante a fallos:
si el servicio de geocoding no responde, la Ubicación se crea igual, sin
coordenadas (no se inventa ningún dato), y el error queda solo registrado
en el log del servidor en vez de interrumpir la importación o la creación
manual del registro. El vendedor o el administrador puede completar la
ubicación real más tarde, a mano o reintentando el geocoding cuando el
servicio esté disponible.
"""
import logging
import re

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)


class FSMLocation(models.Model):
    _inherit = "fsm.location"

    x_orden_ruta = fields.Integer(
        string="Orden de Ruta",
        help="Posición del cliente dentro de su ruta: 1 = primero a "
        "visitar, 2 = segundo, etc. Editable directamente. Al generar "
        "visitas de una ruta, las tareas se ordenan según este número.",
    )

    def geo_localize(self):
        try:
            return super().geo_localize()
        except Exception:
            _logger.warning(
                "No se pudo geolocalizar automáticamente fsm.location id=%s "
                "(servicio de geocoding no disponible). Se deja sin "
                "coordenadas; se puede completar manualmente más tarde.",
                self.ids,
            )
            return False

    def action_migrar_orden_ruta_desde_notas(self):
        """Método ejecutado una sola vez (ver data/migrar_orden_ruta.xml)
        para llenar x_orden_ruta con el valor ya guardado como texto en
        las notes ('Orden de ruta original: N'), sin pisar valores que
        ya se hayan cargado manualmente en x_orden_ruta."""
        locations = self.search([("x_orden_ruta", "=", 0)])
        migradas = 0
        for location in locations:
            if not location.notes:
                continue
            match = re.search(
                r"Orden de ruta original:\s*(\d+)", location.notes
            )
            if match:
                location.x_orden_ruta = int(match.group(1))
                migradas += 1
        _logger.info(
            "Migración de Orden de Ruta desde notas: %s ubicaciones "
            "actualizadas.",
            migradas,
        )
        return True

    def action_abrir_maps(self):
        """Botón 'Ir con Maps' en la ficha de Ubicación: abre Google
        Maps en pestaña/app nueva con la ruta hacia las coordenadas
        guardadas de este cliente."""
        self.ensure_one()
        if not self.partner_latitude and not self.partner_longitude:
            raise UserError(
                _("Este cliente todavía no tiene coordenadas guardadas.")
            )
        url = (
            f"https://www.google.com/maps/dir/?api=1"
            f"&destination={self.partner_latitude},{self.partner_longitude}"
        )
        return {
            "type": "ir.actions.act_url",
            "url": url,
            "target": "new",
        }

    @api.model
    def shalom_crear_cliente_rapido(self, name, phone=False, address=False):
        """Llamado desde la pestaña Clientes de la app del vendedor:
        crea un cliente mínimo (res.partner + fsm.location) para el
        caso ocasional de onboardear a alguien nuevo directo desde la
        calle. NO lo asigna a ninguna ruta ni le carga x_orden_ruta --
        eso lo hace oficina después, a mano, como corresponde al flujo
        principal del proyecto (onboarding desde la calle es la
        excepción, no la regla)."""
        if not name or not name.strip():
            raise UserError(_("El nombre comercial es obligatorio."))

        partner = self.env["res.partner"].create(
            {
                "name": name.strip(),
                "phone": phone or False,
                "street": address or False,
                "company_type": "company",
            }
        )
        location = self.create(
            {
                "name": name.strip(),
                "partner_id": partner.id,
                "phone": phone or False,
                "street": address or False,
            }
        )
        _logger.info(
            "Cliente rápido creado desde la app del vendedor: "
            "fsm.location id=%s (partner id=%s) - %s",
            location.id, partner.id, name,
        )
        return {"id": location.id, "partner_id": partner.id}
