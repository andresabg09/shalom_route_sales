# -*- coding: utf-8 -*-
from odoo import api, fields, models


class ShalomRouteRoute(models.Model):
    _name = 'shalom.route.route'
    _description = 'Street Sales Route'
    _order = 'name'

    name = fields.Char(required=True)
    code = fields.Char(help='Short internal code, e.g. R-01')
    active = fields.Boolean(default=True)
    salesperson_id = fields.Many2one(
        'res.users', string='Salesperson', default=lambda self: self.env.user,
        tracking=True,
    )
    vehicle_name = fields.Char(string='Vehicle', help='Free-text vehicle identifier (plate, code)')
    company_id = fields.Many2one(
        'res.company', default=lambda self: self.env.company, required=True,
    )
    line_ids = fields.One2many('shalom.route.line', 'route_id', string='Customers')
    line_count = fields.Integer(compute='_compute_line_count')
    visit_ids = fields.One2many('shalom.route.visit', 'route_id', string='Visits')
    visit_count = fields.Integer(compute='_compute_visit_count')
    note = fields.Text()

    @api.depends('line_ids')
    def _compute_line_count(self):
        for route in self:
            route.line_count = len(route.line_ids)

    @api.depends('visit_ids')
    def _compute_visit_count(self):
        for route in self:
            route.visit_count = len(route.visit_ids)

    def action_view_visits(self):
        self.ensure_one()
        action = self.env['ir.actions.act_window']._for_xml_id(
            'shalom_route_sales.action_route_visit'
        )
        action['domain'] = [('route_id', '=', self.id)]
        action['context'] = {'default_route_id': self.id}
        return action
