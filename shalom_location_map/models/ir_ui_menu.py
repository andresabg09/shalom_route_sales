# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
El menú nativo "Tablero" (fieldservice.dashboard) viene con
noupdate=True en el ir.model.data que le puso el propio módulo OCA
fieldservice -- confirmado en producción: sobrescribirle name/action
con un <record id="fieldservice.dashboard"> normal en un XML de este
módulo se cargaba sin error, pero Odoo lo ignoraba en silencio en
cada -u (el noupdate del REGISTRO OWNER, no el de este módulo, es el
que manda). Bug real reportado: tras varias rondas de "Ruta Shalom
reemplaza el Tablero" desplegadas, el menú seguía diciendo "Tablero"
sin cambiar nunca.

La salida: un write() directo por ORM (llamado desde un <function> en
ruta_shalom_action.xml, sin noupdate, así corre en cada -u) -- eso
esquiva el mecanismo de diff de <record>/noupdate por completo, que
solo aplica al cargar datos declarativos, no a una escritura común.
"""
from odoo import api, models


class IrUiMenu(models.Model):
    _inherit = "ir.ui.menu"

    @api.model
    def shalom_reemplazar_tablero_por_ruta_shalom(self, *_args):
        # *_args: el <function> de ruta_shalom_action.xml manda un
        # <value eval="[]"/> -- confirmado en producción que Odoo SÍ lo
        # pasa como argumento posicional (un TypeError lo delató acá,
        # justo por no aceptarlo), a diferencia de lo que sugeriría el
        # mismo patrón ya usado en data/migrar_orden_ruta.xml. Se
        # acepta y se ignora, en vez de apostar a ajustar el XML exacto.
        tablero = self.env.ref("fieldservice.dashboard", raise_if_not_found=False)
        accion = self.env.ref(
            "shalom_location_map.ruta_shalom_client_action", raise_if_not_found=False
        )
        if tablero and accion:
            # ir.ui.menu.action es un campo Reference (polimórfico) --
            # necesita el string "modelo,id", no un id suelto (eso
            # tiró el ValueError real en producción).
            tablero.sudo().write({
                "name": "Ruta Shalom",
                "action": f"ir.actions.client,{accion.id}",
            })
        return True
