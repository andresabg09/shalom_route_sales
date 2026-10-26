"""Stub: define fields.GeoLine como un Text normal que acepta srid=..."""
from odoo import fields


class GeoLine(fields.Text):
    # atributos que el módulo real acepta; aquí solo se guardan
    srid = 4326
    dim = 2
    gist_index = True


fields.GeoLine = GeoLine
