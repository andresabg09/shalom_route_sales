# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Trabajo de campo (Fase 6B del juego de ventas): avisos de visita con 3 días
de antelación por WhatsApp y distribuidoras "solo por mensaje".

No hay integración con WhatsApp: el servidor solo arma, por cada cliente, el
teléfono normalizado, el mensaje y el enlace https://wa.me/<número>?text=...
que la app abre en otra pestaña. Las reglas puras (teléfonos, mensaje,
ventana de fechas, umbral) viven en campo_utils.py.

Todo el dinero del juego es al contado y NUNCA se devuelve costo ni utilidad:
de cada cliente solo salen clase y valor esperado (ya los ve el vendedor en
la lista de la ruta) y, de las distribuidoras, fecha y monto del último
pedido.
"""
import logging

from odoo import _, api, fields, models
from odoo.exceptions import AccessError

from . import campo_utils, tz_utils

_logger = logging.getLogger(__name__)

PARAM_UMBRAL = "shalom.aviso_min_esperado"
PARAM_PLANTILLA_AVISO = "shalom.aviso_whatsapp_plantilla"
PARAM_PLANTILLA_DISTRIBUIDORA = "shalom.distribuidora_whatsapp_plantilla"

PLANTILLA_DISTRIBUIDORA_DEFECTO = (
    "Hola, buen día. Le escribe {vendedor} de Shalom. "
    "¿Le armo su pedido para la entrega de esta semana?"
)

ESTADOS_VENTA_CONFIRMADA = ("sale", "done")


class FSMOrderAviso(models.Model):
    _inherit = "fsm.order"

    x_aviso_enviado = fields.Datetime(
        string="Aviso de visita enviado",
        copy=False,
        help="Cuándo el vendedor marcó que avisó por WhatsApp de esta visita. "
        "Evita que el mismo aviso aparezca de nuevo en la lista de avisos.",
    )
    x_aviso_fecha = fields.Date(
        string="Fecha avisada",
        copy=False,
        help="Fecha de visita que se anunció en ese aviso. Si el reparto de "
        "carteras mueve la visita a otro día, el aviso anterior ya no vale y "
        "el cliente vuelve a la lista.",
    )

    def _shalom_fecha_aviso(self):
        """Día en que está planeada esta visita: el de la cartera si el
        cliente fue repartido; si no, el inicio del ciclo."""
        self.ensure_one()
        return self.x_cartera_fecha or self.x_route_schedule_id.date_start or False


class FSMLocationDistribuidora(models.Model):
    _inherit = "fsm.location"

    @api.model
    def shalom_puede_marcar_distribuidora(self):
        """La casilla "Es distribuidora" de la ficha del cliente solo la
        ve y la usa el dueño (gerente de Servicio de Campo)."""
        return self._shalom_es_dueno()

    @api.model
    def _shalom_es_dueno(self):
        usuario = self.env.user
        return usuario.has_group("fieldservice.group_fsm_manager") or usuario.has_group(
            "base.group_system"
        )

    def write(self, vals):
        # Marcar/desmarcar una distribuidora saca al cliente de las carteras
        # y de la ruta: no es algo que un vendedor deba poder hacer por su
        # cuenta, ni siquiera llamando a write() directo.
        if "x_es_distribuidora" in vals and not self.env.su and not self._shalom_es_dueno():
            raise AccessError(_("Solo el dueño puede marcar una distribuidora."))
        return super().write(vals)


class FSMPersonCampo(models.Model):
    _inherit = "fsm.person"

    # -- reglas de visibilidad ------------------------------------------

    @api.model
    def _shalom_ordenes_mias(self, persona, ordenes):
        """De `ordenes` (fsm.order con ciclo), las que le corresponden a
        `persona`: las mismas reglas de shalom_mis_rutas_programadas /
        _shalom_mapa_ciclos. En un ciclo con reparto de carteras son las
        de mi cartera; en uno sin reparto, todas si la ruta es mía."""
        if not ordenes or not persona:
            return ordenes.browse()
        Orden = self.env["fsm.order"]
        con_cartera = set()
        for ciclo, _n in Orden._read_group(
            [
                ("x_route_schedule_id", "in", ordenes.mapped("x_route_schedule_id").ids),
                ("x_cartera_person_id", "!=", False),
            ],
            ["x_route_schedule_id"],
            ["__count"],
        ):
            con_cartera.add(ciclo.id)
        return ordenes.filtered(
            lambda o: (
                o.x_cartera_person_id == persona
                if o.x_route_schedule_id.id in con_cartera
                else o.x_route_schedule_id.fsm_person_id == persona
            )
        )

    # -- avisos a 3 días -------------------------------------------------

    @api.model
    def shalom_avisos_proximos(self):
        """Clientes grandes de MI cartera / mis rutas cuya visita está
        planeada entre mañana y dentro de 3 días, para avisarles por
        WhatsApp. Lista ordenada por valor esperado (el mayor primero):

        {order_id, location_id, nombre, clase, esperado, fecha (ISO),
         fecha_texto, dias, ruta, telefono (dígitos con 507),
         telefono_texto, mensaje, url, avisado}

        Reglas: solo clases A / A2, u otra clase con valor esperado >= el
        umbral (parámetro `shalom.aviso_min_esperado`, 500 por defecto);
        nunca distribuidoras (solo se les escribe, ver
        shalom_distribuidoras); nunca clientes de reserva ni sin teléfono
        usable. `avisado` = ya se marcó avisado para esa fecha (sigue en
        la lista para que el vendedor vea que ya está hecho)."""
        persona = self._shalom_persona_actual()
        if not persona:
            return []
        Orden = self.env["fsm.order"]
        hoy = tz_utils.hoy_local(self.env)
        manana = fields.Date.add(hoy, days=1)
        limite = fields.Date.add(hoy, days=campo_utils.DIAS_AVISO)
        # El dominio acota por fecha; la regla exacta se vuelve a aplicar
        # en Python con campo_utils.en_ventana_aviso (una sola definición).
        candidatas = Orden.search(
            [
                ("stage_id.is_closed", "=", False),
                ("x_route_schedule_id", "!=", False),
                ("location_id", "!=", False),
                ("x_cartera_reserva", "=", False),
                "|",
                "&", ("x_cartera_fecha", ">=", manana), ("x_cartera_fecha", "<=", limite),
                "&", ("x_cartera_fecha", "=", False),
                "&", ("x_route_schedule_id.date_start", ">=", manana),
                ("x_route_schedule_id.date_start", "<=", limite),
            ]
        )
        mias = self._shalom_ordenes_mias(persona, candidatas)
        mias = mias.filtered(
            lambda o: campo_utils.en_ventana_aviso(o._shalom_fecha_aviso(), hoy)
            and not o.location_id.x_es_distribuidora
        )
        if not mias:
            return []
        locations = mias.mapped("location_id")
        perfiles = Orden._shalom_perfiles_clientes(locations)
        params = self.env["ir.config_parameter"].sudo()
        umbral = campo_utils.umbral_valido(params.get_param(PARAM_UMBRAL))
        plantilla = params.get_param(PARAM_PLANTILLA_AVISO) or campo_utils.PLANTILLA_DEFECTO
        vendedor = persona.name or self.env.user.name
        avisos = []
        vistos = set()
        for orden in mias:
            loc = orden.location_id
            if loc.id in vistos:
                continue  # un cliente, un aviso (aunque tenga dos visitas abiertas)
            perfil = perfiles.get(loc.id)
            if not perfil or not campo_utils.es_cliente_grande(
                perfil["clase"], perfil["esperado"], umbral
            ):
                continue
            telefono = campo_utils.elegir_telefono(
                loc.partner_id.mobile, loc.phone, loc.partner_id.phone
            )
            if not telefono:
                continue
            vistos.add(loc.id)
            fecha = orden._shalom_fecha_aviso()
            fecha_texto = campo_utils.fecha_larga_es(fecha)
            mensaje = campo_utils.armar_mensaje(plantilla, loc.name, fecha_texto, vendedor)
            avisos.append(
                {
                    "order_id": orden.id,
                    "location_id": loc.id,
                    "nombre": loc.name,
                    "clase": perfil["clase"],
                    "esperado": perfil["esperado"],
                    "fecha": fecha.isoformat(),
                    "fecha_texto": fecha_texto,
                    "dias": (fecha - hoy).days,
                    "ruta": orden.x_route_schedule_id.route_id.name or "",
                    "telefono": telefono,
                    "telefono_texto": campo_utils.telefono_legible(telefono),
                    "mensaje": mensaje,
                    "url": campo_utils.url_whatsapp(telefono, mensaje),
                    "avisado": bool(orden.x_aviso_enviado and orden.x_aviso_fecha == fecha),
                }
            )
        avisos.sort(key=lambda a: (-a["esperado"], a["fecha"], a["nombre"]))
        return avisos

    @api.model
    def shalom_marcar_avisado(self, order_ids):
        """Marca como avisadas las visitas dadas (solo las mías y abiertas)
        para que no vuelvan a salir como pendientes. Idempotente: marcar
        dos veces la misma visita para la misma fecha no cambia la hora
        del primer aviso. Devuelve los ids que quedaron avisados."""
        persona = self._shalom_persona_actual()
        if not persona or not order_ids:
            return []
        ids = [int(i) for i in order_ids if isinstance(i, int) or str(i).isdigit()]
        ordenes = self.env["fsm.order"].browse(ids).exists().filtered(
            lambda o: o.x_route_schedule_id and not o.stage_id.is_closed
        )
        ordenes = self._shalom_ordenes_mias(persona, ordenes)
        ahora = fields.Datetime.now()
        for orden in ordenes:
            fecha = orden._shalom_fecha_aviso()
            if orden.x_aviso_enviado and orden.x_aviso_fecha == fecha:
                continue
            orden.sudo().write({"x_aviso_enviado": ahora, "x_aviso_fecha": fecha})
        return ordenes.ids

    # -- distribuidoras --------------------------------------------------

    @api.model
    def shalom_distribuidoras(self):
        """Distribuidoras (fsm.location con x_es_distribuidora): nunca se
        visitan, solo se les escribe. Para cada una: nombre, teléfono,
        fecha y monto (sin impuesto) de su último pedido confirmado y el
        enlace de WhatsApp. Las que llevan más tiempo sin comprar, primero;
        las que nunca han comprado, al final."""
        Location = self.env["fsm.location"]
        locations = Location.search([("x_es_distribuidora", "=", True)])
        if not locations:
            return []
        persona = self._shalom_persona_actual()
        vendedor = (persona.name if persona else "") or self.env.user.name
        params = self.env["ir.config_parameter"].sudo()
        plantilla = params.get_param(PARAM_PLANTILLA_DISTRIBUIDORA) or PLANTILLA_DISTRIBUIDORA_DEFECTO
        hoy = tz_utils.hoy_local(self.env)
        # sudo: el último pedido de la distribuidora debe verse sin importar
        # qué vendedor lo hizo (regla "Personal Orders" de Ventas). Solo sale
        # fecha y monto sin impuesto, nunca costo ni margen.
        comercial_de = {
            loc.id: loc.partner_id.commercial_partner_id.id for loc in locations if loc.partner_id
        }
        ultimo = {}
        if comercial_de:
            ordenes = self.env["sale.order"].sudo().search_read(
                [
                    ("partner_id.commercial_partner_id", "in", list(set(comercial_de.values()))),
                    ("state", "in", list(ESTADOS_VENTA_CONFIRMADA)),
                ],
                ["partner_id", "amount_untaxed", "date_order"],
                order="date_order desc",
                load="",
            )
            partners = self.env["res.partner"].sudo().browse({o["partner_id"] for o in ordenes})
            comercial_de_partner = {p.id: p.commercial_partner_id.id for p in partners}
            for orden in ordenes:  # ya vienen del más reciente al más viejo
                ultimo.setdefault(comercial_de_partner.get(orden["partner_id"]), orden)
        resultado = []
        for loc in locations:
            orden = ultimo.get(comercial_de.get(loc.id))
            fecha = (
                tz_utils.a_local(self.env, orden["date_order"]).date() if orden else False
            )
            telefono = campo_utils.elegir_telefono(
                loc.partner_id.mobile, loc.phone, loc.partner_id.phone
            )
            mensaje = campo_utils.armar_mensaje(plantilla, loc.name, "", vendedor)
            resultado.append(
                {
                    "location_id": loc.id,
                    "nombre": loc.name,
                    "telefono": telefono,
                    "telefono_texto": campo_utils.telefono_legible(telefono),
                    "ultimo_fecha": fecha.isoformat() if fecha else False,
                    "ultimo_monto": round(orden["amount_untaxed"], 2) if orden else 0.0,
                    "dias": (hoy - fecha).days if fecha else False,
                    "mensaje": mensaje,
                    "url": campo_utils.url_whatsapp(telefono, mensaje),
                }
            )
        # más días sin comprar primero; sin pedidos al final
        resultado.sort(key=lambda r: (r["dias"] is False, -(r["dias"] or 0), r["nombre"]))
        return resultado
