# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""Registro de carritos descartados (Administración → Registro).

Antes, "Salir y perder el carrito" en el catálogo de la app vaciaba el
carrito sin dejar rastro. Ahora, justo antes de vaciarlo, se guarda una
copia aquí (qué productos, cuánto, quién, a qué cliente) durante
DIAS_RETENCION_REGISTRO días. Si el total pasa el umbral, se avisa a
oficina. Desde Administración se puede restaurar: vuelve al carrito de
la visita si sigue abierta, o se crea una cotización en borrador.

El vendedor no escribe esta tabla directo (solo lectura/escritura para
el administrador): se crea con sudo desde fsm.order.shalom_limpiar_carrito.
"""
import json
import logging
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError

from . import offline_utils

_logger = logging.getLogger(__name__)

PARAMETRO_UMBRAL = "shalom.registro_umbral_aviso"


class ShalomCotizacionRegistro(models.Model):
    _name = "shalom.cotizacion.registro"
    _description = "Carrito descartado en la app del vendedor"
    _order = "fecha desc, id desc"

    tipo = fields.Selection(
        [("descartado", "Carrito descartado")],
        required=True, default="descartado",
    )
    fecha = fields.Datetime(required=True, default=fields.Datetime.now, index=True)
    order_id = fields.Many2one("fsm.order", string="Visita", ondelete="set null", index=True)
    location_id = fields.Many2one("fsm.location", string="Cliente", ondelete="set null")
    person_id = fields.Many2one("fsm.person", string="Vendedor de la visita", ondelete="set null")
    user_id = fields.Many2one(
        "res.users", string="Descartado por", ondelete="set null",
        default=lambda self: self.env.user,
    )
    lineas_json = fields.Text(string="Carrito (JSON)")
    cantidad_items = fields.Float(string="Ítems")
    total = fields.Float(string="Total")
    destacado = fields.Boolean(
        help="El total pasó el umbral de aviso (parámetro del sistema "
        "shalom.registro_umbral_aviso, $100 si no está cargado).",
    )
    uuid = fields.Char(
        string="Id del dispositivo", index=True, copy=False,
        help="Id único que generó el teléfono para este descarte: si el "
        "mismo aviso llega dos veces (cola offline), no se duplica.",
    )
    restaurado = fields.Boolean()
    restaurado_por = fields.Many2one("res.users", ondelete="set null")
    restaurado_en = fields.Datetime()
    restaurado_como = fields.Selection(
        [("carrito", "Devuelto al carrito de la visita"), ("cotizacion", "Cotización en borrador")],
    )
    sale_id = fields.Many2one("sale.order", string="Cotización creada", ondelete="set null")

    _sql_constraints = [
        ("uuid_unico", "unique(uuid)", "Este descarte ya está registrado."),
    ]

    # ------------------------------------------------------------------
    # Alta (desde la app del vendedor)
    # ------------------------------------------------------------------

    @api.model
    def _shalom_umbral_aviso(self):
        valor = self.env["ir.config_parameter"].sudo().get_param(PARAMETRO_UMBRAL)
        try:
            return float(valor) if valor not in (None, False, "") else offline_utils.UMBRAL_AVISO_DEFAULT
        except (TypeError, ValueError):
            return offline_utils.UMBRAL_AVISO_DEFAULT

    @api.model
    def _shalom_registrar_descarte(self, visita, carrito, uuid=False):
        """Guarda la copia del carrito descartado de `visita`. Nunca debe
        impedir el descarte: cualquier error se registra en el log y se
        sigue. Devuelve el registro creado (o el ya existente con ese
        uuid), o un recordset vacío si el carrito estaba vacío."""
        cantidad_items, total, lineas = offline_utils.resumen_carrito(carrito)
        if not lineas:
            return self.browse()
        if uuid:
            existente = self.sudo().search([("uuid", "=", uuid)], limit=1)
            if existente:
                return existente
        persona = visita.x_cartera_person_id or visita.fsm_route_id.fsm_person_id
        destacado = offline_utils.es_destacado(total, self._shalom_umbral_aviso())
        registro = self.sudo().create({
            "order_id": visita.id,
            "location_id": visita.location_id.id or False,
            "person_id": persona.id or False,
            "user_id": self.env.user.id,
            "lineas_json": json.dumps(carrito),
            "cantidad_items": cantidad_items,
            "total": total,
            "destacado": destacado,
            "uuid": uuid or False,
        })
        if destacado:
            registro._shalom_avisar_oficina(visita)
        return registro

    def _shalom_avisar_oficina(self, visita):
        """Nota en la visita, con aviso en la bandeja de entrada de los
        administradores de Servicio de Campo. A prueba de fallos: un
        problema de correo/notificación no frena el descarte."""
        self.ensure_one()
        try:
            with self.env.cr.savepoint():
                grupo = self.env.ref("fieldservice.group_fsm_manager", raise_if_not_found=False)
                socios = grupo.sudo().users.partner_id if grupo else self.env["res.partner"]
                visita.sudo().message_post(
                    body=_(
                        "Carrito descartado en la app por %(usuario)s: %(items)s ítem(s), "
                        "$%(total).2f. Se puede restaurar desde Administración → Registro "
                        "durante %(dias)s días.",
                        usuario=self.env.user.name,
                        items=f"{self.cantidad_items:g}",
                        total=self.total,
                        dias=offline_utils.DIAS_RETENCION_REGISTRO,
                    ),
                    partner_ids=socios.ids,
                    subtype_xmlid="mail.mt_note",
                )
        except Exception:  # noqa: BLE001 -- jamás frenar el descarte
            _logger.exception("No se pudo avisar a oficina del carrito descartado id=%s", self.id)

    # ------------------------------------------------------------------
    # Administración → Registro
    # ------------------------------------------------------------------

    @api.model
    def shalom_admin_registro(self):
        """Carritos descartados de los últimos DIAS_RETENCION_REGISTRO días."""
        self.env["fsm.order"]._shalom_verificar_admin()
        limite = fields.Datetime.now() - timedelta(days=offline_utils.DIAS_RETENCION_REGISTRO)
        registros = self.search([("fecha", ">=", limite)])
        resultado = []
        for r in registros:
            _cantidad, _total, lineas = offline_utils.resumen_carrito(
                offline_utils.carrito_desde_json(r.lineas_json)
            )
            visita = r.order_id
            resultado.append({
                "id": r.id,
                "fecha": fields.Datetime.to_string(r.fecha),
                "cliente_nombre": r.location_id.name or (visita.location_id.name if visita else "") or "",
                "ruta_nombre": visita.fsm_route_id.name if visita and visita.fsm_route_id else "",
                "vendedor_nombre": r.person_id.name or "",
                "usuario_nombre": r.user_id.name or "",
                "cantidad_items": r.cantidad_items,
                "total": r.total,
                "destacado": r.destacado,
                "lineas": lineas,
                "restaurado": r.restaurado,
                "restaurado_como": r.restaurado_como or False,
                "restaurado_por": r.restaurado_por.name or "",
                "restaurado_en": fields.Datetime.to_string(r.restaurado_en) if r.restaurado_en else False,
                "sale_id": r.sale_id.id or False,
                "sale_nombre": r.sale_id.name or "",
                "visita_abierta": bool(visita and visita.active and not visita.stage_id.is_closed),
            })
        return resultado

    def shalom_admin_restaurar(self):
        """Restaura un carrito descartado:
        - Si la visita sigue abierta y su carrito está vacío, vuelve a
          ese carrito (el vendedor lo ve al abrir "Tomar pedido").
        - Si no, crea una cotización en borrador para el cliente con los
          mismos productos y cantidades (los precios los pone Odoo, con la
          lista de precios del cliente, como cualquier cotización).
        Devuelve {modo: "carrito"} o {modo: "cotizacion", sale_order_id,
        sale_order_name}."""
        self.env["fsm.order"]._shalom_verificar_admin()
        self.ensure_one()
        if self.restaurado:
            raise UserError(_("Este carrito ya se restauró."))
        carrito = offline_utils.carrito_desde_json(self.lineas_json)
        _cantidad, _total, lineas = offline_utils.resumen_carrito(carrito)
        if not lineas:
            raise UserError(_("Este registro no tiene productos para restaurar."))

        visita = self.order_id
        ahora = fields.Datetime.now()
        if (
            visita and visita.active and not visita.stage_id.is_closed
            and not visita._shalom_carrito_dict()
        ):
            visita.write({"x_carrito_borrador": json.dumps(carrito), "x_carrito_actualizado": ahora})
            visita.message_post(body=_(
                "Carrito descartado restaurado por %(usuario)s desde Administración.",
                usuario=self.env.user.name,
            ))
            self.write({
                "restaurado": True, "restaurado_por": self.env.user.id,
                "restaurado_en": ahora, "restaurado_como": "carrito",
            })
            return {"modo": "carrito"}

        socio = (self.location_id or visita.location_id).partner_id
        if not socio:
            raise UserError(_("El cliente de este carrito ya no tiene contacto: no se puede crear la cotización."))
        productos = self.env["product.product"].with_context(active_test=False)
        lineas_venta = []
        omitidos = []
        for linea in lineas:
            if linea["es_recompensa"]:
                continue  # las promos las vuelve a calcular Odoo en la cotización
            producto = productos.browse(linea["product_id"]).exists() if linea["product_id"] else productos
            if not producto or not producto.sale_ok:
                omitidos.append(linea["nombre"])
                continue
            lineas_venta.append((0, 0, {"product_id": producto.id, "product_uom_qty": linea["cantidad"]}))
        if not lineas_venta:
            raise UserError(_("Ninguno de los productos de este carrito se puede vender hoy."))
        cotizacion = self.env["sale.order"].create({"partner_id": socio.id, "order_line": lineas_venta})
        nota = _(
            "Cotización creada al restaurar un carrito descartado en la app (registro del %(fecha)s, "
            "descartado por %(usuario)s).",
            fecha=fields.Datetime.to_string(self.fecha), usuario=self.user_id.name or "?",
        )
        if omitidos:
            nota += " " + _("No se pudieron agregar: %(lista)s.", lista=", ".join(omitidos))
        cotizacion.message_post(body=nota)
        if visita and not visita.sale_id:
            visita.write({"sale_id": cotizacion.id})
        self.write({
            "restaurado": True, "restaurado_por": self.env.user.id, "restaurado_en": ahora,
            "restaurado_como": "cotizacion", "sale_id": cotizacion.id,
        })
        return {"modo": "cotizacion", "sale_order_id": cotizacion.id, "sale_order_name": cotizacion.name}

    # ------------------------------------------------------------------
    # Limpieza (cron diario)
    # ------------------------------------------------------------------

    @api.model
    def _shalom_limpiar_registro_viejo(self):
        limite = fields.Datetime.now() - timedelta(days=offline_utils.DIAS_RETENCION_REGISTRO)
        viejos = self.sudo().search([("fecha", "<", limite)])
        if viejos:
            _logger.info("Registro de carritos: %s descarte(s) de más de %s días borrados.",
                         len(viejos), offline_utils.DIAS_RETENCION_REGISTRO)
            viejos.unlink()
