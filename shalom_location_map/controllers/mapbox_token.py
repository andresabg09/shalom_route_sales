# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Expone el token de Mapbox (leído de la variable de entorno del
servidor MAPBOX_ACCESS_TOKEN) al JS del navegador, para usarlo como
capa base del mapa (tiles visuales). Requiere sesión autenticada de
Odoo -- no es un endpoint público sin restricciones.

El token que se expone acá es el mismo token público (pk.xxx) que ya
se usa para Directions API: los tokens públicos de Mapbox están
diseñados para ser usados del lado del cliente (así funcionan sus
propios ejemplos oficiales), por eso no representa un riesgo mayor
exponerlo a usuarios ya autenticados en este Odoo.
"""
import os

from odoo import http
from odoo.http import request


class ShalomMapboxController(http.Controller):
    @http.route(
        "/shalom_location_map/mapbox_public_token",
        type="json",
        auth="user",
        methods=["POST"],
    )
    def mapbox_public_token(self):
        return os.environ.get("MAPBOX_ACCESS_TOKEN", "")
