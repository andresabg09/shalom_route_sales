# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
fieldservice_geoengine dispara automáticamente un geo_localize() (llamada a
un servicio externo de geocoding) cada vez que se crea o se edita una
fsm.location con datos de dirección, si no hay partner_latitude/
partner_longitude ya cargados. Si ese servicio externo no está disponible
o falla, la excepción interrumpe toda la operación de creación/guardado
(por ejemplo, guardar el formulario "Editar cliente" de la app del
vendedor, aunque el vendedor no haya tocado el botón "Registrar
coordenadas" para nada).

Esta extensión hace ese intento tolerante a fallos SIN perder datos: si
el geocoder externo falla, se registra el error en el log del servidor
(nunca se interrumpe la operación en curso) y, si el intento fallido
llegó a limpiar partner_latitude/partner_longitude a mitad de camino
(patrón típico: primero borra la coordenada vieja, después intenta poner
la nueva), se restauran las coordenadas que había ANTES de este método,
en vez de dejarlas en blanco. Nunca se inventa una coordenada nueva --
solo se evita perder una que ya estaba guardada por culpa de un
geocoder caído.
"""
import logging
import re

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Mismo criterio que ESTADOS_VENTA_CONFIRMADA en fsm_order.py y
# fsm_route_schedule.py: estados de sale.order que cuentan como venta
# real, no borrador.
ESTADOS_VENTA_CONFIRMADA = ("sale", "done")


class FSMLocation(models.Model):
    _inherit = "fsm.location"

    x_orden_ruta = fields.Integer(
        string="Orden de Ruta",
        help="Posición del cliente dentro de su ruta: 1 = primero a "
        "visitar, 2 = segundo, etc. Editable directamente. Al generar "
        "visitas de una ruta, las tareas se ordenan según este número.",
    )
    x_gps_wizard_revisado = fields.Boolean(
        string="GPS revisado (wizard)",
        default=False,
        help="Casilla interna, no pensada para tocarse a mano: la usa "
        "el wizard 'Buscar GPS por nombre' para saber qué clientes ya "
        "se revisaron (aceptados, descartados o con la coordenada "
        "borrada a propósito) y no volver a mostrarlos en la próxima "
        "corrida, tenga o no tenga GPS cargado.",
    )
    x_venta_mas_alta = fields.Monetary(
        string="Venta más alta",
        compute="_compute_x_venta_mas_alta",
        currency_field="x_currency_id",
        help="La venta CONFIRMADA de mayor monto (no la última, la "
        "más alta) que se le haya hecho alguna vez al contacto de "
        "este cliente. Se muestra en el listado de clientes de la "
        "ruta (app del vendedor) como meta concreta -- 'a este "
        "cliente ya se le vendió hasta $X'. Se recalcula al leerse, "
        "no queda guardada en la base (mismo criterio que 'capacidad' "
        "en fsm.route.schedule, pero por máximo en vez de por "
        "última venta).",
    )
    x_currency_id = fields.Many2one(
        "res.currency",
        string="Moneda",
        default=lambda self: self.env.company.currency_id,
        help="Solo para mostrar x_venta_mas_alta con el símbolo "
        "correcto -- fsm.location no tenía un campo de moneda propio.",
    )

    @api.depends("partner_id")
    def _compute_x_venta_mas_alta(self):
        for location in self:
            mejor = False
            if location.partner_id:
                mejor = self.env["sale.order"].search(
                    [
                        ("partner_id", "=", location.partner_id.id),
                        ("state", "in", list(ESTADOS_VENTA_CONFIRMADA)),
                    ],
                    order="amount_total desc",
                    limit=1,
                )
            location.x_venta_mas_alta = mejor.amount_total if mejor else 0.0

    def geo_localize(self):
        # OJO: probado en producción -- un intento fallido de geo_localize()
        # no siempre lanza una excepción. Cuando el geocoder busca la
        # dirección y no encuentra nada, eso NO es un error para Odoo: es
        # una búsqueda "exitosa" que simplemente no dio resultado, y deja
        # partner_latitude/partner_longitude en 0 como si fuera la
        # respuesta correcta. El primer intento de este fix solo actuaba
        # dentro de un except, así que nunca se activaba en ese caso -- las
        # coordenadas seguían quedando en 0 en silencio. Por eso ahora se
        # compara SIEMPRE el antes/después (haya habido excepción o no):
        # si había coordenadas válidas y el resultado las dejó vacías, se
        # restauran. Si el geocoder sí encontró algo nuevo (resultado no
        # vacío), esa actualización real se respeta -- solo se protege
        # contra perder un dato bueno por un "no encontrado".
        coordenadas_previas = {
            loc.id: (loc.partner_latitude, loc.partner_longitude) for loc in self
        }
        resultado = False
        try:
            resultado = super().geo_localize()
        except Exception:
            _logger.warning(
                "No se pudo geolocalizar automáticamente fsm.location id=%s "
                "(excepción del geocoder). Se revisan las coordenadas "
                "previas por si el intento fallido llegó a limpiarlas.",
                self.ids,
            )
        for loc in self:
            lat_previa, lng_previa = coordenadas_previas[loc.id]
            tenia_coordenadas_previas = bool(lat_previa or lng_previa)
            quedo_sin_coordenadas = not loc.partner_latitude and not loc.partner_longitude
            if tenia_coordenadas_previas and quedo_sin_coordenadas:
                _logger.warning(
                    "geo_localize() dejó fsm.location id=%s sin coordenadas "
                    "(geocoder sin resultado o con error) -- se restauran "
                    "las que tenía antes en vez de dejarla en 0.",
                    loc.id,
                )
                loc.write(
                    {
                        "partner_latitude": lat_previa,
                        "partner_longitude": lng_previa,
                    }
                )
        return resultado

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
        """Botón 'Ir con Waze' en la ficha de Ubicación: abre Waze en
        pestaña/app nueva con la ruta hacia las coordenadas guardadas
        de este cliente. Antes abría Google Maps -- se cambió por
        decisión explícita del usuario (prefiere que el equipo
        navegue con Waze)."""
        self.ensure_one()
        if not self.partner_latitude and not self.partner_longitude:
            raise UserError(
                _("Este cliente todavía no tiene coordenadas guardadas.")
            )
        url = (
            f"https://waze.com/ul?ll={self.partner_latitude},{self.partner_longitude}"
            f"&navigate=yes"
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
            # owner_id es obligatorio en fsm.location (no tiene default ni
            # se completa solo fuera del onchange del formulario nativo,
            # que este create() directo no dispara) -- sin esto, el INSERT
            # fallaba por violar la restricción NOT NULL de la columna.
            # Para un alta desde la calle sin jerarquía de Ubicaciones, el
            # dueño es el mismo contacto recién creado.
            "owner_id": partner.id,
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

    def _shalom_eliminar_ubicacion_o_motivo(self):
        """Núcleo compartido entre action_eliminar_ubicacion() (botón
        de la ficha, un solo registro) y
        shalom.eliminar.ubicaciones.wizard (borrado en lote desde el
        listado): intenta borrar ÚNICAMENTE este registro de
        fsm.location, nunca el contacto.

        fsm.location usa _inherits sobre res.partner vía partner_id
        (delegate=True) -- eso significa que name, street, active,
        GPS, etc. son en realidad campos del contacto delegado, no de
        la Ubicación. Por esto mismo, ARCHIVAR una Ubicación
        (active=False) apaga el 'active' del contacto delegado -- si
        ese contacto tiene más de una Ubicación apuntándolo (caso
        típico de la importación original), las demás se ven
        archivadas también aunque no se hayan tocado. Borrar (unlink)
        en cambio solo elimina la fila propia de fsm.location: por
        cómo funciona _inherits en Odoo, el contacto delegado
        (partner_id/owner_id) NO se borra ni se toca -- sigue
        existiendo, activo, igual que antes.

        Si esta es la única Ubicación del contacto y tiene visitas en
        su historial, NO se borra (se perdería ese historial sin
        ubicación a la que quedar asociado) -- devuelve el motivo
        como texto en vez de lanzar una excepción, para que un
        borrado en lote pueda seguir con las demás filas seleccionadas
        en vez de frenarse en la primera que falle. Si hay otra
        Ubicación del mismo contacto, las visitas se reasignan ahí
        antes de borrar. Devuelve False si se borró con éxito."""
        self.ensure_one()
        otras_ubicaciones = self.search(
            [("partner_id", "=", self.partner_id.id), ("id", "!=", self.id)]
        )
        visitas = self.env["fsm.order"].search([("location_id", "=", self.id)])

        if visitas and not otras_ubicaciones:
            return _(
                "es la única Ubicación de este contacto y tiene "
                "%(cantidad)s visita(s) en su historial",
                cantidad=len(visitas),
            )

        if visitas:
            visitas.write({"location_id": otras_ubicaciones[0].id})

        nombre = self.name
        contacto_id = self.partner_id.id
        cantidad_visitas = len(visitas)
        # fsm.location no tiene perm_unlink habilitado para ningún grupo
        # en el módulo nativo (fuerza archivar en vez de borrar desde
        # cualquier lado) -- acá se salta a propósito solo para esta
        # llamada puntual, ya protegida por el grupo manager y la
        # confirmación obligatoria en la vista.
        self.sudo().unlink()

        _logger.info(
            "Ubicación eliminada a mano: '%s' (contacto id=%s). %s "
            "visita(s) reasignada(s). El contacto no se tocó.",
            nombre, contacto_id, cantidad_visitas,
        )
        return False

    def action_eliminar_ubicacion(self):
        """Botón 'Eliminar esta Ubicación' en la ficha (con
        confirmación en la vista, un solo registro). Ver
        _shalom_eliminar_ubicacion_o_motivo() para la lógica real."""
        self.ensure_one()
        motivo = self._shalom_eliminar_ubicacion_o_motivo()
        if motivo:
            raise UserError(
                _("No se pudo eliminar esta Ubicación: %(motivo)s. Si "
                  "querés eliminar el contacto completo, hacelo desde "
                  "Contactos.",
                  motivo=motivo)
            )
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Ubicación eliminada"),
                "message": _("Eliminada. El contacto sigue intacto."),
                "sticky": False,
                "type": "success",
            },
        }

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
