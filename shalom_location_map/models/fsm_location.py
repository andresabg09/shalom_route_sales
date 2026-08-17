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
    def shalom_crear_cliente_rapido(
        self,
        name,
        phone=False,
        address=False,
        vat=False,
        mobile=False,
        email=False,
        image_1920=False,
        latitude=False,
        longitude=False,
        route_id=False,
        cliente_anterior_id=False,
    ):
        """Llamado desde la pestaña Clientes de la app del vendedor (y
        desde 'Editar cliente' cuando se crea desde cero): crea un
        cliente (res.partner + fsm.location) con los datos que se
        hayan cargado en el formulario ampliado -- RUC, celular, correo,
        foto del local y GPS quedan en el contacto/ubicación igual que
        si los cargara oficina.

        route_id/cliente_anterior_id son OPCIONALES: si no se pasan, el
        cliente queda sin ruta asignada, igual que el comportamiento
        original (onboarding desde la calle es el caso ocasional, no
        el flujo principal -- oficina asigna la ruta después). Si se
        pasa route_id, se asigna la ruta y se calcula la posición con
        el mismo criterio que shalom_asignar_ruta_y_orden()."""
        if not name or not name.strip():
            raise UserError(_("El nombre comercial es obligatorio."))

        partner = self.env["res.partner"].create(
            {
                "name": name.strip(),
                "phone": phone or False,
                "street": address or False,
                "vat": vat or False,
                "mobile": mobile or False,
                "email": email or False,
                "image_1920": image_1920 or False,
                "company_type": "company",
            }
        )
        location_vals = {
            "name": name.strip(),
            "partner_id": partner.id,
            "phone": phone or False,
            "street": address or False,
        }
        if latitude and longitude:
            location_vals["partner_latitude"] = latitude
            location_vals["partner_longitude"] = longitude
        location = self.create(location_vals)
        _logger.info(
            "Cliente rápido creado desde la app del vendedor: "
            "fsm.location id=%s (partner id=%s) - %s",
            location.id, partner.id, name,
        )
        if route_id:
            location.shalom_asignar_ruta_y_orden(route_id, cliente_anterior_id)
        return {"id": location.id, "partner_id": partner.id}

    def shalom_actualizar_gps(self, latitude, longitude):
        """Botón 'Registrar coordenadas' de la ficha del cliente
        (Editar cliente / Alta rápida), fuera del contexto de una
        visita puntual -- guarda el GPS capturado del dispositivo
        directo en la Ubicación. Distinto de
        fsm.order.action_capturar_gps(), que además guarda una copia
        propia en la visita; acá no hay ninguna visita de por medio."""
        self.ensure_one()
        self.write({"partner_latitude": latitude, "partner_longitude": longitude})
        _logger.info(
            "GPS actualizado desde la ficha del cliente para fsm.location "
            "id=%s: lat=%s lng=%s",
            self.id, latitude, longitude,
        )
        return True

    def shalom_asignar_ruta_y_orden(self, route_id, cliente_anterior_id=False):
        """Asigna esta Ubicación a la ruta indicada y calcula su
        posición (x_orden_ruta) según "va después de" el cliente
        indicado (cliente_anterior_id) -- o primera posición si no se
        indica ninguno --, corriendo +1 el orden de los clientes que ya
        ocupaban esa posición o una posterior DENTRO DE LA MISMA RUTA,
        para que el nuevo cliente entre sin pisar a nadie.

        route_id=False desasigna la ruta (deja el cliente sin ruta,
        como si nunca se hubiera posicionado)."""
        self.ensure_one()
        if not route_id:
            self.write({"fsm_route_id": False})
            return True

        nuevo_orden = 1
        if cliente_anterior_id:
            anterior = self.env["fsm.location"].browse(cliente_anterior_id)
            nuevo_orden = (anterior.x_orden_ruta or 0) + 1

        siguientes = self.env["fsm.location"].search(
            [
                ("fsm_route_id", "=", route_id),
                ("x_orden_ruta", ">=", nuevo_orden),
                ("id", "!=", self.id),
            ],
            order="x_orden_ruta desc",
        )
        for loc in siguientes:
            loc.x_orden_ruta = loc.x_orden_ruta + 1

        self.write({"fsm_route_id": route_id, "x_orden_ruta": nuevo_orden})
        _logger.info(
            "fsm.location id=%s asignada a fsm.route id=%s en posición %s "
            "(%s ubicaciones corridas)",
            self.id, route_id, nuevo_orden, len(siguientes),
        )
        return True
