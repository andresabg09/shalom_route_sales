# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Agrega a fsm.route:

1. La acción "Generar visitas de esta ruta": crea SIEMPRE una
   fsm.order por cada fsm.location activa de la ruta, en el orden dado
   por el campo x_orden_ruta (Orden de Ruta), usando el propio campo
   sequence de fsm.order para reflejar ese orden en las vistas nativas
   de Field Service. A oficina no le importa si un cliente fue o no
   atendido en el ciclo anterior para decidir si le toca visita nueva
   -- SIEMPRE le toca, a todos los clientes de la ruta, cada vez que
   se aprieta este botón: si alguno todavía tiene una fsm.order
   abierta (de este ciclo o de cualquier otro, incluso de antes de que
   existiera este sistema), esa visita vieja se cierra sola como "No
   atendido" antes de crear la nueva -- nunca bloquea ni se saltea a
   nadie. Acepta un fsm.route.schedule opcional (ver ese modelo) para
   taggear las visitas creadas con la ocurrencia que las generó, y
   para copiarles su rango de fechas a scheduled_date_start/
   scheduled_date_end (así el calendario nativo de Field Service las
   ubica bien).

2. La acción "Archivar visitas cerradas": archiva (active=False) las
   fsm.order ya completadas/canceladas de la ruta, para poder generar
   el ciclo del mes siguiente sin perder el historial.

3. El campo x_ruta_trazado (GeoLine) y la acción "Calcular trazado de
   ruta": llama a la API de Directions de Mapbox con las coordenadas
   de los clientes de la ruta, en el orden de x_orden_ruta, y guarda
   la geometría de la ruta real (siguiendo calles) devuelta por Mapbox.
   Requiere la variable de entorno MAPBOX_ACCESS_TOKEN configurada en
   el servidor (nunca hardcodeada en el módulo).

4. El campo x_duracion_dias: cuántos días dura típicamente un
   recorrido completo de esta ruta. Solo se usa para sugerir la fecha
   de fin al crear/renovar una fsm.route.schedule (ver ese modelo) --
   la fecha real de cada programación concreta siempre es editable.
"""
import json
import logging
import os
from datetime import datetime, time

import requests

from odoo import _, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Límite de waypoints por solicitud del plan estándar de Mapbox
# Directions API. Rutas con más clientes que esto necesitan dividirse
# en tramos -- no implementado todavía (ver documento de contexto).
MAPBOX_MAX_WAYPOINTS = 25


class FSMRoute(models.Model):
    _inherit = "fsm.route"

    x_ruta_trazado = fields.GeoLine(
        string="Trazado de Ruta",
        srid=4326,
        help="Geometría de la ruta real (siguiendo calles) calculada "
        "por Mapbox Directions API, uniendo los clientes en el orden "
        "de su Orden de Ruta. Se actualiza con el botón 'Calcular "
        "trazado de ruta'.",
    )
    x_duracion_dias = fields.Integer(
        string="Duración típica del ciclo (días)",
        default=7,
        help="Cuántos días suele durar un recorrido completo de esta "
        "ruta (1, 2, 3, una semana...) -- no todas las rutas duran lo "
        "mismo. Se usa solo para SUGERIR la fecha de fin al crear una "
        "fsm.route.schedule nueva para esta ruta (ver "
        "_onchange_date_start_sugerir_fin en fsm_route_schedule.py) y "
        "al generar el ciclo siguiente con 'Generar próximo ciclo'; la "
        "fecha de fin de cada programación concreta siempre se puede "
        "editar a mano si ese mes es distinto.",
    )

    def _shalom_etapas_generar_visitas(self):
        """Etapas 'Nueva' y 'No atendido' que necesita tanto
        action_generar_visitas_ruta() (masivo) como
        _shalom_crear_visita_para_location() (una sola, ver
        fsm_route_schedule.py / shalom_agregar_visita_wizard.py) --
        extraído para no duplicar esta búsqueda en los dos lados."""
        stage_nueva = self.env.ref(
            "shalom_location_map.shalom_fsm_stage_order_new", raise_if_not_found=False
        )
        if not stage_nueva:
            stage_nueva = self.env["fsm.stage"].search(
                [("stage_type", "=", "order"), ("is_closed", "=", False)],
                limit=1,
                order="sequence asc",
            )
        if not stage_nueva:
            raise UserError(
                _("No se encontró ninguna etapa de tipo Orden de Servicio "
                  "que no esté marcada como cerrada. Revisá la "
                  "configuración de fsm.stage (debe existir al menos una "
                  "etapa con stage_type='order' e is_closed=False).")
            )
        stage_no_atendido = self.env.ref(
            "shalom_location_map.shalom_fsm_stage_no_atendido", raise_if_not_found=False
        )
        if not stage_no_atendido:
            raise UserError(
                _("No se encontró la etapa 'No atendido'. Revisá que el "
                  "módulo esté actualizado (data/fsm_stage_no_atendido.xml).")
            )
        return stage_nueva, stage_no_atendido

    def _shalom_crear_visita_para_location(
        self, location, stage_nueva, stage_no_atendido, schedule=None, sequence=1
    ):
        """Núcleo compartido: crea UNA fsm.order para `location`,
        cerrando primero como 'No atendido' cualquier visita vieja que
        haya quedado abierta para ese mismo cliente (mismo criterio
        que el generado masivo, acotado acá a un solo cliente). Usado
        por action_generar_visitas_ruta() (bucle sobre todos los
        clientes de la ruta) y por
        fsm.route.schedule.action_agregar_visita() (un cliente
        puntual agregado a una ocurrencia ya generada, ver
        shalom_agregar_visita_wizard.py) -- así las dos vías quedan
        con exactamente la misma lógica, sin duplicarla.

        Devuelve (fsm.order creada, cantidad de visitas viejas
        cerradas como 'No atendido')."""
        abiertas = self.env["fsm.order"].search(
            [
                ("location_id", "=", location.id),
                ("stage_id.is_closed", "=", False),
            ]
        )
        if abiertas:
            abiertas.write({"stage_id": stage_no_atendido.id})

        vals = {
            "name": f"{self.name} - {location.name}",
            "location_id": location.id,
            "fsm_route_id": self.id,
            "stage_id": stage_nueva.id,
            "sequence": sequence,
        }
        if schedule:
            vals["x_route_schedule_id"] = schedule.id
            if schedule.date_start:
                vals["scheduled_date_start"] = datetime.combine(
                    schedule.date_start, time.min
                )
            if schedule.date_end:
                vals["scheduled_date_end"] = datetime.combine(
                    schedule.date_end, time.max
                )
        orden = self.env["fsm.order"].create(vals)
        return orden, len(abiertas)

    def action_generar_visitas_ruta(self, schedule=None):
        """Botón: crea SIEMPRE una fsm.order por cada fsm.location
        activa de esta ruta -- no se saltea a nadie por historial. Si
        un cliente ya tiene una fsm.order abierta (de este ciclo, de
        otro, o de antes de que existiera este sistema), esa visita
        vieja se cierra sola como "No atendido" antes de crear la
        nueva: así queda explícito para administración quién no fue
        atendido, sin que eso bloquee la generación del ciclo nuevo.

        schedule: fsm.route.schedule opcional (una ocurrencia
        programada) -- si se pasa, cada fsm.order creada queda
        vinculada a esa ocurrencia via x_route_schedule_id, y se le
        copia el rango de fechas del ciclo a scheduled_date_start/
        scheduled_date_end (así el calendario nativo de Field Service
        la ubica bien). Llamado desde fsm.route.schedule.
        action_generar_visitas(); el botón nativo del formulario de
        Ruta sigue llamando a este mismo método sin schedule.

        Para agregar (o sacar) UN cliente puntual a una ocurrencia YA
        generada sin volver a tocar a los demás -- caso típico: un
        cliente se agregó a la ruta después de generar el ciclo, o hay
        que sumarlo a mitad de camino -- ver
        fsm.route.schedule.action_agregar_visita() en
        fsm_route_schedule.py, que reusa
        _shalom_crear_visita_para_location() de acá abajo en vez de
        pasar por este método masivo."""
        self.ensure_one()

        locations = self.env["fsm.location"].search(
            [("fsm_route_id", "=", self.id)]
        )
        if not locations:
            raise UserError(
                _("Esta ruta no tiene ninguna Ubicación de Servicio asignada.")
            )

        # Ordenar por x_orden_ruta; los que están en 0 (sin dato real
        # cargado todavía) quedan al final, no al principio.
        locations = locations.sorted(
            key=lambda loc: loc.x_orden_ruta if loc.x_orden_ruta else 999999
        )

        stage_nueva, stage_no_atendido = self._shalom_etapas_generar_visitas()

        creadas = 0
        cerradas_como_no_atendido = 0
        for idx, location in enumerate(locations, start=1):
            _orden, cantidad_cerradas = self._shalom_crear_visita_para_location(
                location, stage_nueva, stage_no_atendido, schedule=schedule, sequence=idx
            )
            creadas += 1
            cerradas_como_no_atendido += cantidad_cerradas

        mensaje = _(
            "Ruta '%(ruta)s': %(creadas)s visita(s) generada(s) (todos "
            "los clientes de la ruta). %(cerradas)s visita(s) vieja(s) "
            "que seguían abiertas se cerraron como 'No atendido'.",
            ruta=self.name,
            creadas=creadas,
            cerradas=cerradas_como_no_atendido,
        )
        _logger.info(mensaje)

        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Visitas generadas"),
                "message": mensaje,
                "sticky": False,
                "type": "success",
            },
        }

    def action_archivar_visitas_cerradas(self):
        """Botón: archiva (active=False) las fsm.order de esta ruta que
        ya están cerradas (Completado, No quiso o Cancelado), para poder volver a
        generar visitas nuevas del ciclo siguiente sin perder el
        historial (las archivadas siguen consultables, solo salen de
        la vista/kanban activo)."""
        self.ensure_one()

        cerradas = self.env["fsm.order"].search(
            [
                ("fsm_route_id", "=", self.id),
                ("stage_id.is_closed", "=", True),
            ]
        )
        if not cerradas:
            mensaje = _(
                "Ruta '%(ruta)s': no había visitas cerradas para archivar.",
                ruta=self.name,
            )
        else:
            cerradas.write({"active": False})
            mensaje = _(
                "Ruta '%(ruta)s': %(cantidad)s visita(s) cerrada(s) "
                "archivada(s). El historial sigue disponible con el "
                "filtro de archivados.",
                ruta=self.name,
                cantidad=len(cerradas),
            )
        _logger.info(mensaje)

        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Visitas archivadas"),
                "message": mensaje,
                "sticky": False,
                "type": "success",
            },
        }

    def action_calcular_trazado_ruta(self):
        """Botón: calcula el trazado real (siguiendo calles) de la
        ruta, uniendo los clientes en el orden de x_orden_ruta, usando
        Mapbox Directions API. Guarda el resultado en x_ruta_trazado.

        Requiere: variable de entorno MAPBOX_ACCESS_TOKEN configurada
        en el servidor. Solo funciona con rutas de hasta
        MAPBOX_MAX_WAYPOINTS clientes con coordenadas válidas (el plan
        estándar de Mapbox no admite más waypoints por solicitud;
        dividir en tramos queda pendiente para una versión posterior).
        """
        self.ensure_one()

        token = os.environ.get("MAPBOX_ACCESS_TOKEN")
        if not token:
            raise UserError(
                _("No se encontró la variable de entorno "
                  "MAPBOX_ACCESS_TOKEN en el servidor. Configurala antes "
                  "de calcular el trazado.")
            )

        locations = self.env["fsm.location"].search(
            [
                ("fsm_route_id", "=", self.id),
                ("partner_latitude", "!=", 0),
                ("partner_longitude", "!=", 0),
            ]
        )
        locations = locations.sorted(
            key=lambda loc: loc.x_orden_ruta if loc.x_orden_ruta else 999999
        )

        if len(locations) < 2:
            raise UserError(
                _("Esta ruta tiene menos de 2 clientes con coordenadas "
                  "GPS reales cargadas. Hacen falta al menos 2 para "
                  "calcular un trazado.")
            )

        if len(locations) > MAPBOX_MAX_WAYPOINTS:
            raise UserError(
                _("Esta ruta tiene %(cantidad)s clientes con "
                  "coordenadas, y el límite por solicitud de Mapbox es "
                  "%(limite)s. Dividir rutas grandes en tramos todavía "
                  "no está implementado.",
                  cantidad=len(locations),
                  limite=MAPBOX_MAX_WAYPOINTS)
            )

        coordenadas = ";".join(
            f"{loc.partner_longitude},{loc.partner_latitude}"
            for loc in locations
        )
        url = (
            f"https://api.mapbox.com/directions/v5/mapbox/driving/"
            f"{coordenadas}"
        )

        try:
            response = requests.get(
                url,
                params={
                    "geometries": "geojson",
                    "overview": "full",
                    "access_token": token,
                },
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
        except requests.RequestException as exc:
            _logger.error(
                "Error llamando a Mapbox Directions API para fsm.route "
                "id=%s: %s", self.id, exc,
            )
            raise UserError(
                _("No se pudo contactar a Mapbox. Verificá tu conexión "
                  "y que el token sea válido. Detalle: %(detalle)s",
                  detalle=str(exc))
            )

        if not data.get("routes"):
            raise UserError(
                _("Mapbox no devolvió ninguna ruta para estos puntos. "
                  "Respuesta: %(respuesta)s",
                  respuesta=data.get("message", "sin detalle"))
            )

        geometry = data["routes"][0]["geometry"]
        # GeoJSON LineString -> WKT LINESTRING, formato que espera el
        # campo GeoLine de base_geoengine.
        coords_wkt = ", ".join(
            f"{lng} {lat}" for lng, lat in geometry["coordinates"]
        )
        wkt = f"LINESTRING({coords_wkt})"
        self.x_ruta_trazado = wkt

        _logger.info(
            "Trazado de ruta calculado para fsm.route id=%s (%s "
            "puntos, %s clientes).",
            self.id, len(geometry["coordinates"]), len(locations),
        )

        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Trazado calculado"),
                "message": _(
                    "Trazado de ruta actualizado para '%(ruta)s' "
                    "(%(clientes)s clientes).",
                    ruta=self.name,
                    clientes=len(locations),
                ),
                "sticky": False,
                "type": "success",
            },
        }
