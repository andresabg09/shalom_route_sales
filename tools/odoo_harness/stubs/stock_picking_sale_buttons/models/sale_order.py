from odoo import _, fields, models
from odoo.exceptions import UserError

# Misma constante (mismo path de import) que usa fsm_order.py en su try/except.
PAYMENT_METHOD_SELECTION = [
    ("efectivo", "Efectivo"),
    ("tarjeta", "Tarjeta"),
    ("cheque", "Cheque"),
    ("credito_1_semana", "Crédito 1 semana"),
    ("credito_2_semanas", "Crédito 2 semanas"),
    ("transferencia", "Transferencia"),
    ("yappy", "Yappy"),
    ("otro", "Otro"),
]


class SaleOrder(models.Model):
    _inherit = "sale.order"

    custom_payment_method = fields.Selection(PAYMENT_METHOD_SELECTION, string="Forma de pago")
    custom_special_delivery_date = fields.Date(string="Fecha especial de entrega")
    custom_itbms_required = fields.Boolean(string="Incluye ITBMS", default=False)

    def action_confirm(self):
        # Imita al módulo real: sin forma de pago y sin el contexto
        # skip_payment_method_check, el original devolvía un pop-up y NO
        # confirmaba. Aquí lo hacemos explícito con un UserError.
        if not self.env.context.get("skip_payment_method_check"):
            for orden in self:
                if not orden.custom_payment_method:
                    raise UserError(_("STUB: falta forma de pago (pop-up del módulo real)."))
        return super().action_confirm()


class SaleOrderLine(models.Model):
    _inherit = "sale.order.line"

    custom_promo_status = fields.Char(string="Estado promo")
