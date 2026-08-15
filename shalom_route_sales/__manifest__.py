{
    'name': 'Shalom Route Sales',
    'version': '18.0.1.0.0',
    'category': 'Sales/Sales',
    'summary': 'Street route sales: routes, daily visits and on-the-spot orders',
    'description': """
Shalom Route Sales
===================
Manage door-to-door / street route sales:

* Define sales routes with an ordered list of customers per weekday.
* Generate a daily route visit with one stop per scheduled customer.
* Track each stop's outcome (pending, sold, no sale) from the field.
* Create a sale order directly from a stop, linked back to the visit.
""",
    'author': 'Shalom',
    'license': 'LGPL-3',
    'depends': ['base', 'mail', 'sale_management'],
    'data': [
        'security/route_sales_security.xml',
        'security/ir.model.access.csv',
        'data/ir_sequence_data.xml',
        'views/route_views.xml',
        'views/route_visit_views.xml',
        'views/route_sales_menus.xml',
    ],
    'installable': True,
    'application': True,
}
