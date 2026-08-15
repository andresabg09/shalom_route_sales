# -*- coding: utf-8 -*-
from odoo import api, fields, models

WEEKDAYS = [
    ('0', 'Monday'),
    ('1', 'Tuesday'),
    ('2', 'Wednesday'),
    ('3', 'Thursday'),
    ('4', 'Friday'),
    ('5', 'Saturday'),
    ('6', 'Sunday'),
]


class ShalomRouteLine(models.Model):
    _name = 'shalom.route.line'
    _description = 'Route Customer Stop (template)'
    _order = 'route_id, sequence, id'

    route_id = fields.Many2one('shalom.route.route', required=True, ondelete='cascade')
    sequence = fields.Integer(default=10)
    partner_id = fields.Many2one('res.partner', string='Customer', required=True)
    weekday = fields.Selection(WEEKDAYS, string='Day of Week', required=True, default='0')
    note = fields.Char()
    active = fields.Boolean(default=True)
    company_id = fields.Many2one(related='route_id.company_id', store=True)
