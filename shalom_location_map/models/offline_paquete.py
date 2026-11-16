# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""Modo offline: "Preparar mi día". Una sola llamada por ruta que trae,
para cada visita del ciclo, lo mismo que la app pide pantalla por
pantalla (hoja de visita, aviso de datos faltantes, ficha de estrellas,
pedidos anteriores, última forma de pago), con los MISMOS métodos y la
misma forma de respuesta: el teléfono lo guarda bajo las mismas claves
que usan las pantallas, así que sin señal cada pantalla encuentra sus
datos como si los hubiera pedido ella.

Cada pieza es a prueba de fallos: si una visita o un cliente da error,
se omite esa pieza y el resto del paquete sale igual."""
import logging

from odoo import api, models

_logger = logging.getLogger(__name__)

# Mismos campos que leen visit_sheet.js (cargar) y order_screen.js.
CAMPOS_VISITA = [
    "location_id", "x_cliente_orden_ruta", "stage_name", "x_observaciones_visita",
    "x_cliente_lat", "x_cliente_lng", "sale_id",
]
CAMPOS_CLIENTE = ["name", "phone", "mobile", "street", "street2", "partner_id"]


class FsmRouteSchedule(models.Model):
    _inherit = "fsm.route.schedule"

    @api.model
    def shalom_paquete_offline(self, schedule_id):
        ciclo = self.browse(schedule_id).exists()
        if not ciclo:
            return {"visitas": {}, "faltantes": {}, "fichas": {}, "pedidos": {}, "ultima_fp": {}}
        Orden = self.env["fsm.order"]
        visitas = Orden.search([("x_route_schedule_id", "=", ciclo.id)])
        paquete = {"visitas": {}, "faltantes": {}, "fichas": {}, "pedidos": {}, "ultima_fp": {}}

        def seguro(descripcion, funcion):
            try:
                with self.env.cr.savepoint():
                    return True, funcion()
            except Exception:  # noqa: BLE001 -- una pieza rota no frena el paquete
                _logger.warning("Paquete offline: no se pudo armar %s", descripcion, exc_info=True)
                return False, None

        clientes = {}
        for visita in visitas:
            ok, orden = seguro(f"visita {visita.id}", lambda v=visita: v.read(CAMPOS_VISITA)[0])
            if not ok:
                continue
            location_id = orden["location_id"][0] if orden["location_id"] else False
            locacion = None
            if location_id:
                if location_id not in clientes:
                    _ok, datos = seguro(
                        f"cliente {location_id}",
                        lambda lid=location_id: self.env["fsm.location"].browse(lid).read(CAMPOS_CLIENTE)[0],
                    )
                    clientes[location_id] = datos
                locacion = clientes[location_id]
            ok, faltantes = seguro(f"faltantes {visita.id}", visita.shalom_campos_cliente_faltantes)
            faltantes = faltantes if ok else []
            paquete["visitas"][visita.id] = {"orden": orden, "locacion": locacion, "datosFaltantes": faltantes}
            paquete["faltantes"][visita.id] = {"locationId": location_id, "datosFaltantes": faltantes}

        for location_id in clientes:
            ok, ficha = seguro(f"ficha {location_id}", lambda lid=location_id: Orden.shalom_ficha_juego(lid))
            if ok:
                paquete["fichas"][location_id] = ficha
            ok, pedidos = seguro(f"pedidos {location_id}", lambda lid=location_id: Orden.shalom_pedidos_anteriores(lid))
            if ok:
                paquete["pedidos"][location_id] = pedidos
            ok, ultima = seguro(f"forma de pago {location_id}", lambda lid=location_id: Orden.shalom_ultima_forma_pago_e_itbms(lid))
            if ok:
                paquete["ultima_fp"][location_id] = ultima
        return paquete
