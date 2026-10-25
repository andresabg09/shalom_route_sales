# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Estrategias del día ("qué empujar" / "no ofrezcas"), editables por el
dueño desde Administración. Las ve el vendedor en el botón Estrategias
de la pestaña Rutas, y el catálogo marca los productos afectados.

Son avisos, NUNCA bloqueos: un producto "no ofrezcas" se puede agregar
al pedido igual si el vendedor decide.
"""
from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError


class ShalomEstrategia(models.Model):
    _name = "shalom.estrategia"
    _description = "Estrategia de venta (qué empujar / no ofrezcas)"
    _order = "sequence, id"

    name = fields.Char(string="Título", required=True)
    tipo = fields.Selection(
        [("empujar", "Qué empujar"), ("no_ofrecer", "No ofrezcas")],
        string="Tipo",
        required=True,
        default="empujar",
    )
    texto = fields.Text(
        string="Explicación",
        help="Frase corta para el vendedor: por qué se empuja o por qué "
        "no se ofrece.",
    )
    product_ids = fields.Many2many(
        "product.product",
        string="Productos",
        help="Se marcan en el catálogo con EMPUJAR / NO OFRECER.",
    )
    date_from = fields.Date(string="Desde", help="Vacío = ya vigente.")
    date_to = fields.Date(string="Hasta", help="Vacío = sin fecha de fin.")
    sequence = fields.Integer(default=10)
    active = fields.Boolean(default=True)

    @api.model
    def shalom_estrategias_vigentes(self):
        """Estrategias activas hoy, para la app del vendedor.

        sudo(): cualquier vendedor las lee aunque no tenga permisos
        sobre el modelo. Devuelve {"empujar": [...], "no_ofrecer": [...],
        "productos": {product_id: "empujar"|"no_ofrecer"}}; si un
        producto está en ambas listas, gana "no_ofrecer"."""
        hoy = fields.Date.context_today(self)
        vigentes = self.sudo().search(
            [
                ("active", "=", True),
                "|", ("date_from", "=", False), ("date_from", "<=", hoy),
                "|", ("date_to", "=", False), ("date_to", ">=", hoy),
            ]
        )
        resultado = {"empujar": [], "no_ofrecer": [], "productos": {}}
        for estrategia in vigentes:
            resultado[estrategia.tipo].append(
                {
                    "id": estrategia.id,
                    "titulo": estrategia.name,
                    "texto": estrategia.texto or "",
                    "productos": [
                        {"id": p.id, "nombre": p.display_name}
                        for p in estrategia.product_ids
                    ],
                }
            )
            for producto in estrategia.product_ids:
                if estrategia.tipo == "no_ofrecer" or producto.id not in resultado["productos"]:
                    resultado["productos"][producto.id] = estrategia.tipo
        return resultado

    @api.model
    def shalom_admin_estrategias(self):
        """Todas las estrategias (activas o no) para la pestaña de
        Administración. Solo para el rol Administrador de Servicio."""
        self._shalom_exigir_admin()
        return [
            {
                "id": e.id,
                "titulo": e.name,
                "tipo": e.tipo,
                "texto": e.texto or "",
                "activa": e.active,
                "date_from": fields.Date.to_string(e.date_from) if e.date_from else False,
                "date_to": fields.Date.to_string(e.date_to) if e.date_to else False,
                "productos": [{"id": p.id, "nombre": p.display_name} for p in e.product_ids],
            }
            for e in self.with_context(active_test=False).search([])
        ]

    @api.model
    def shalom_admin_guardar_estrategia(self, estrategia_id, datos):
        """Crea (estrategia_id falso) o edita una estrategia. `datos`:
        {titulo, tipo, texto, activa, date_from, date_to, product_ids}."""
        self._shalom_exigir_admin()
        vals = {
            "name": (datos.get("titulo") or "").strip(),
            "tipo": datos.get("tipo") or "empujar",
            "texto": datos.get("texto") or False,
            "active": bool(datos.get("activa", True)),
            "date_from": datos.get("date_from") or False,
            "date_to": datos.get("date_to") or False,
            "product_ids": [(6, 0, datos.get("product_ids") or [])],
        }
        if not vals["name"]:
            raise UserError(_("La estrategia necesita un título."))
        if estrategia_id:
            self.with_context(active_test=False).browse(estrategia_id).write(vals)
            return estrategia_id
        return self.create(vals).id

    @api.model
    def shalom_admin_borrar_estrategia(self, estrategia_id):
        self._shalom_exigir_admin()
        self.with_context(active_test=False).browse(estrategia_id).unlink()
        return True

    @api.model
    def _shalom_exigir_admin(self):
        if not self.env.user.has_group("fieldservice.group_fsm_manager"):
            raise AccessError(
                _("Esta acción es solo para el rol Administrador de Servicio de Campo.")
            )
