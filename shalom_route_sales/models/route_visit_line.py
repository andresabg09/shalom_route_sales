# -*- coding: utf-8 -*-
from odoo import api, fields, models


class ShalomRouteVisitLine(models.Model):
    _name = 'shalom.route.visit.line'
    _description = 'Route Visit Stop'
    _order = 'visit_id, sequence, id'

    visit_id = fields.Many2one('shalom.route.visit', required=True, ondelete='cascade')
    sequence = fields.Integer(default=10)
    partner_id = fields.Many2one('res.partner', string='Customer', required=True)
    state = fields.Selection(
        [
            ('pending', 'Pending'),
            ('sold', 'Sold'),
            ('no_sale', 'No Sale'),
        ],
        default='pending', required=True,
    )
    sale_order_id = fields.Many2one('sale.order', string='Sale Order', copy=False)
    amount_total = fields.Monetary(related='sale_order_id.amount_total', string='Amount')
    currency_id = fields.Many2one(related='visit_id.currency_id')
    note = fields.Char()
    company_id = fields.Many2one(related='visit_id.company_id', store=True)

    def action_create_sale_order(self):
        self.ensure_one()
        order = self.env['sale.order'].create({
            'partner_id': self.partner_id.id,
            'company_id': self.company_id.id,
        })
        self.write({'sale_order_id': order.id, 'state': 'sold'})
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'sale.order',
            'res_id': order.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def action_mark_no_sale(self):
        self.write({'state': 'no_sale'})

    def action_reset_pending(self):
        self.write({'state': 'pending'})
