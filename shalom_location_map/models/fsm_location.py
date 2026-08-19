# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
fieldservice_geoengine dispara automáticamente un geo_localize() (llamada a
un servicio externo de geocoding) cada vez que se crea una fsm.location sin
partner_latitude/partner_longitude. Si ese servicio externo no está
disponible o falla, la excepción interrumpe toda la operación de creación.

Esta extensión hace que SOLO ese intento automático (disparado durante
create()) sea tolerante a fallos: si el servicio de geocoding no responde,
la Ubicación se crea igual, sin coordenadas (no se inventa ningún dato), y
el error queda solo registrado en el log del servidor en vez de interrumpir
la importación o la creación manual del registro.

IMPORTANTE: geo_localize() también se llama de forma interactiva, por
ejemplo desde el botón "Geolocalizar" del formulario de Ubicación (el popup
donde se edita el cliente). Ahí NO queremos tragarnos el error: si se traga
en silencio, la llamada RPC termina como "exitosa" y Odoo hace commit de
cualquier escritura parcial que el geocoder haya hecho antes de fallar
(por ejemplo, limpiar lat/lng antes de intentar poner las nuevas) — el
usuario ve el campo de coordenadas vacío sin ningún mensaje de error. Si en
cambio se deja propagar la excepción, Odoo hace rollback de toda la
transacción (las coordenadas anteriores quedan intactas) y le muestra al
usuario el error real. Por eso el modo tolerante a fallos se activa solo
con un flag de contexto que ponemos nosotros mismos alrededor de create().
"""
import logging
import re

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

CONTEXT_KEY_GEOLOCALIZAR_TOLERANTE = "shalom_geo_localize_tolerante_a_fallos"


class FSMLocation(models.Model):
    _inherit = "fsm.location"

    x_orden_ruta = fields.Integer(
        string="Orden de Ruta",
        help="Posición del cliente dentro de su ruta: 1 = primero a "
        "visitar, 2 = segundo, etc. Editable directamente. Al generar "
        "visitas de una ruta, las tareas se ordenan según este número.",
    )

    @api.model_create_multi
    def create(self, vals_list):
        return super(
            FSMLocation,
            self.with_context(**{CONTEXT_KEY_GEOLOCALIZAR_TOLERANTE: True}),
        ).create(vals_list)

    def geo_localize(self):
        if not self.env.context.get(CONTEXT_KEY_GEOLOCALIZAR_TOLERANTE):
            # Llamada interactiva (ej. botón "Geolocalizar" del formulario
            # de Ubicación): dejar que la excepción se propague, para que
            # Odoo haga rollback y muestre el error real al usuario, en vez
            # de guardar en silencio un estado a medio terminar.
            return super().geo_localize()
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
