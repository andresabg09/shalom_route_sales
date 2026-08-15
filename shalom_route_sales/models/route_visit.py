# -*- coding: utf-8 -*-
from odoo import api, fields, models


class ShalomRouteVisit(models.Model):
    _name = 'shalom.route.visit'
    _description = "Route Sales Visit (a route's execution on a given day)"
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'date desc, id desc'

    name = fields.Char(default='New', copy=False, readonly=True)
    route_id = fields.Many2one('shalom.route.route', string='Route', required=True, tracking=True)
    date = fields.Date(default=fields.Date.context_today, required=True, tracking=True)
    salesperson_id = fields.Many2one(
        'res.users', string='Salesperson', tracking=True,
        default=lambda self: self.env.user,
    )
    company_id = fields.Many2one(
        'res.company', default=lambda self: self.env.company, required=True,
    )
    state = fields.Selection(
        [
            ('draft', 'Draft'),
            ('in_progress', 'In Progress'),
            ('done', 'Done'),
            ('cancelled', 'Cancelled'),
        ],
        default='draft', tracking=True, copy=False,
    )
    stop_ids = fields.One2many('shalom.route.visit.line', 'visit_id', string='Stops')
    stop_count = fields.Integer(compute='_compute_stop_stats')
    sold_count = fields.Integer(compute='_compute_stop_stats')
    amount_total = fields.Monetary(compute='_compute_stop_stats')
    currency_id = fields.Many2one(related='company_id.currency_id')

    @api.depends('stop_ids.state', 'stop_ids.sale_order_id.amount_total')
    def _compute_stop_stats(self):
        for visit in self:
            visit.stop_count = len(visit.stop_ids)
            visit.sold_count = len(visit.stop_ids.filtered(lambda s: s.state == 'sold'))
            visit.amount_total = sum(visit.stop_ids.mapped('sale_order_id.amount_total'))

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'New') == 'New':
                vals['name'] = self.env['ir.sequence'].next_by_code('shalom.route.visit') or 'New'
        return super().create(vals_list)

    def action_generate_stops(self):
        """Create one stop per route line scheduled for this visit's weekday."""
        for visit in self:
            if visit.stop_ids:
                continue
            weekday = str(fields.Date.from_string(visit.date).weekday())
            lines = visit.route_id.line_ids.filtered(lambda l: l.weekday == weekday and l.active)
            visit.stop_ids = [
                (0, 0, {
                    'partner_id': line.partner_id.id,
                    'sequence': line.sequence,
                    'note': line.note,
                })
                for line in lines
            ]

    def action_start(self):
        self.write({'state': 'in_progress'})

    def action_done(self):
        self.write({'state': 'done'})

    def action_cancel(self):
        self.write({'state': 'cancelled'})

    def action_reset_draft(self):
        self.write({'state': 'draft'})
