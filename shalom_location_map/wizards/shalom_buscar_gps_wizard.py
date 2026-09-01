# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Wizard de administración: ayuda a completar el GPS de clientes
(fsm.location) buscando por NOMBRE en Google Places (Text Search) --
el mismo truco que ya se usa a mano en Waze/Google Maps para encontrar
un comercio sin tener la dirección exacta. Se usa Google en vez de
Mapbox (que sí se sigue usando para el trazado de rutas en
fsm_route.py) porque Mapbox no tiene buena cobertura de comercios
chicos en Panamá.

La búsqueda es POR CLIENTE, a pedido -- no hay un botón que busque
todo de una. Cada fila de la lista tiene:
- "Buscar opciones en Google": llama a Google en el momento SOLO para
  ese cliente y abre un popup con hasta TOPE_OPCIONES_POR_CLIENTE (20)
  resultados para elegir (Google no siempre acierta con el primero --
  puede haber un cliente que cambió de nombre o de local). Antes el
  tope era 3 -- se reportó que Google podía tener más candidatos
  válidos y esas opciones de más nunca se veían, ni volviendo a
  buscar el mismo cliente. Cada opción del popup tiene su propio
  botón "Ver mapa" para chequear en un mapa real antes de elegirla, y
  "Usar esta opción" para guardarla de una.
- "Dejar como está": no busca nada, pero saca a este cliente de la
  cola (no vuelve a aparecer) -- para los casos que ya se sabe que no
  van a aparecer en Google.
- "Borrar coordenada actual": vacía el GPS de este cliente (para
  cuando la coordenada actual está mal) y lo DEJA en la cola -- sigue
  apareciendo en próximas corridas hasta que alguien le encuentre una
  coordenada real. A diferencia de "Dejar como está", acá la intención
  es seguir intentando, no abandonar el cliente.

Nunca escribe una coordenada sin que el usuario la elija a mano. Reusa
fsm.location.shalom_actualizar_gps() para el guardado real, en vez de
duplicar el write -- mismo criterio de "nunca inventar datos" que ya
sigue geo_localize() en models/fsm_location.py.

La cola de "a quién mostrar" por defecto es "clientes SIN coordenadas"
(partner_latitude/partner_longitude vacíos o en 0) -- NO se basa en si
ya se "revisó" antes: un cliente al que ya se le encontró GPS deja de
aparecer solo porque ya tiene coordenada, no por ninguna marca aparte.
Esto es a propósito (versión anterior excluía por
fsm.location.x_gps_wizard_revisado, que sacaba de la cola incluso a
clientes que seguían sin GPS real; se sacó ese filtro por pedido
explícito). El toggle "Solo sin GPS" (mostrar_solo_sin_gps) prende/apaga
ese filtro -- apagado, muestra TODOS los de la ruta/búsqueda, útil para
encontrar y corregir un cliente al que se le puso una coordenada
equivocada. El campo "Buscar cliente por nombre" (busqueda_nombre)
busca por nombre sin importar el toggle, para el mismo caso.

Se puede abrir de tres formas:
- Desde el menú, sin nada seleccionado: carga las primeras
  LIMITE_UBICACIONES_POR_CORRIDA ubicaciones sin GPS.
- Desde la lista de Ubicaciones de Servicio, con una selección hecha
  a mano (acción disponible en el menú "Acción" de esa lista): carga
  solo esas ubicaciones, sin filtrar nada.
- Con el selector de Ruta (opcional) + el toggle "Solo sin GPS" +/o el
  campo de búsqueda por nombre + botón "Buscar / recargar lista": para
  atender ruta por ruta, o encontrar un cliente puntual.
"""
import logging
import math
import os

import requests

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Tope de ubicaciones a cargar en una sola corrida del wizard cuando se
# abre desde el menú (sin selección previa de registros).
LIMITE_UBICACIONES_POR_CORRIDA = 200

# Cuántos resultados de Google se muestran como opciones al buscar un
# cliente puntual. Antes era 3 -- se reportó que Google Places Text
# Search puede devolver más candidatos válidos que eso, y con el tope
# viejo esas opciones de más nunca se veían (ni volviendo a buscar el
# mismo cliente). Google Places Text Search devuelve hasta 20
# resultados en UNA sola llamada (sin costo ni llamada extra) -- 20
# es el tope real de esa llamada, así que ponerlo acá no trunca nada
# que Google no haya truncado ya solo.
TOPE_OPCIONES_POR_CLIENTE = 20

# Contexto que se agrega a cada búsqueda para que Google priorice
# resultados en Panamá, igual que se escribiría a mano "nombre del
# cliente, Panamá" en Waze/Google Maps.
CONTEXTO_BUSQUEDA = "Panamá"

GOOGLE_PLACES_TEXTSEARCH_URL = (
    "https://maps.googleapis.com/maps/api/place/textsearch/json"
)


def _buscar_en_google(nombre_cliente, token):
    """Llama a Google Places API (Text Search) buscando el nombre del
    cliente + contexto de Panamá -- es literalmente el mismo motor que
    Waze/Google Maps. Devuelve hasta TOPE_OPCIONES_POR_CLIENTE
    candidatos (nombre, dirección, lat, lng) de los que trae esa única
    llamada (Google ya trae como máximo 20 en una llamada de Text
    Search), o [] si no hay resultados o falla la llamada."""
    if not nombre_cliente:
        return []
    query = f"{nombre_cliente}, {CONTEXTO_BUSQUEDA}"
    try:
        response = requests.get(
            GOOGLE_PLACES_TEXTSEARCH_URL,
            params={"query": query, "region": "pa", "key": token},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        _logger.warning(
            "No se pudo buscar en Google Places el nombre '%s': %s",
            nombre_cliente, exc,
        )
        return []

    estado = data.get("status")
    if estado not in ("OK", "ZERO_RESULTS"):
        _logger.warning(
            "Google Places devolvió un estado inesperado para '%s': %s (%s)",
            nombre_cliente, estado, data.get("error_message", ""),
        )
        return []

    resultados = [
        {
            "nombre": result.get("name", nombre_cliente),
            "direccion": result.get("formatted_address", ""),
            "lat": result["geometry"]["location"]["lat"],
            "lng": result["geometry"]["location"]["lng"],
        }
        for result in data.get("results", [])
        if result.get("geometry", {}).get("location")
    ]
    return resultados[:TOPE_OPCIONES_POR_CLIENTE]


def _distancia_km(lat1, lng1, lat2, lng2):
    """Distancia en línea recta (fórmula de Haversine, sin depender de
    ninguna API paga) entre dos puntos GPS. Devuelve False si falta
    algún dato (por ejemplo, si todavía no se capturó "mi ubicación")."""
    if not (lat1 and lng1 and lat2 and lng2):
        return False
    radio_tierra_km = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return radio_tierra_km * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class ShalomBuscarGpsWizard(models.TransientModel):
    _name = "shalom.buscar.gps.wizard"
    _description = "Buscar GPS de clientes por nombre (Google Places)"

    route_id = fields.Many2one(
        "fsm.route",
        string="Ruta (opcional)",
        help="Si elegís una ruta y apretás 'Buscar / recargar lista', la "
        "lista se reemplaza por los clientes de ESA ruta (filtrados "
        "además por 'Solo sin GPS' y/o el nombre buscado) -- para poder "
        "ir ruta por ruta en el orden que prefieras.",
    )
    mostrar_solo_sin_gps = fields.Boolean(
        string="Solo sin GPS",
        default=True,
        help="Marcado (por defecto): la lista muestra solo clientes sin "
        "coordenadas. Desmarcalo para ver TODOS los de la ruta/búsqueda "
        "-- por ejemplo, para encontrar uno puntual al que se le puso "
        "una coordenada equivocada y corregírsela.",
    )
    busqueda_nombre = fields.Char(
        string="Buscar cliente por nombre",
        help="Busca por nombre SIN IMPORTAR si el cliente ya tiene GPS "
        "o no (ignora el toggle 'Solo sin GPS' mientras haya algo "
        "escrito acá) -- para encontrar y corregir un cliente puntual.",
    )
    line_ids = fields.One2many(
        "shalom.buscar.gps.wizard.line", "wizard_id", string="Ubicaciones"
    )
    mi_lat = fields.Float(digits=(16, 7), readonly=True)
    mi_lng = fields.Float(digits=(16, 7), readonly=True)

    @api.model
    def default_get(self, fields_list):
        vals = super().default_get(fields_list)
        location_ids = self.env.context.get("active_ids")
        if self.env.context.get("active_model") == "fsm.location" and location_ids:
            locations = self.env["fsm.location"].browse(location_ids)
        else:
            locations = self.env["fsm.location"].search(
                ["|", ("partner_latitude", "=", False), ("partner_longitude", "=", False)],
                limit=LIMITE_UBICACIONES_POR_CORRIDA,
            )
        vals["line_ids"] = [(0, 0, {"location_id": loc.id}) for loc in locations]
        return vals

    def _dominio_ubicaciones(self):
        """Arma el domain de fsm.location según Ruta + 'Solo sin GPS' +
        búsqueda por nombre, usado tanto por action_cargar_ubicaciones()
        como (indirectamente) por el docstring de arriba. Si hay texto
        en busqueda_nombre, el filtro de GPS se ignora a propósito --
        el objetivo de buscar por nombre es justamente encontrar un
        cliente puntual sin importar si ya tiene coordenada o no."""
        self.ensure_one()
        domain = []
        if self.route_id:
            domain.append(("fsm_route_id", "=", self.route_id.id))
        if self.busqueda_nombre and self.busqueda_nombre.strip():
            domain.append(("name", "ilike", self.busqueda_nombre.strip()))
        elif self.mostrar_solo_sin_gps:
            domain += ["|", ("partner_latitude", "=", False), ("partner_longitude", "=", False)]
        return domain

    def action_cargar_ubicaciones(self):
        """Botón 'Buscar / recargar lista': reemplaza la lista actual
        según Ruta + 'Solo sin GPS' + nombre buscado (ver
        _dominio_ubicaciones())."""
        self.ensure_one()
        domain = self._dominio_ubicaciones()
        locations = self.env["fsm.location"].search(
            domain, limit=LIMITE_UBICACIONES_POR_CORRIDA
        )
        self.line_ids.unlink()
        self.write(
            {"line_ids": [(0, 0, {"location_id": loc.id}) for loc in locations]}
        )
        _logger.info(
            "Wizard de GPS: cargadas %s ubicación(es) (ruta='%s', "
            "solo_sin_gps=%s, busqueda='%s').",
            len(locations), self.route_id.name if self.route_id else "-",
            self.mostrar_solo_sin_gps, self.busqueda_nombre or "-",
        )
        return {
            "type": "ir.actions.act_window",
            "res_model": self._name,
            "res_id": self.id,
            "view_mode": "form",
            "views": [[False, "form"]],
            "target": "new",
        }

    def action_abrir_captura_mi_ubicacion(self):
        """Botón 'Capturar mi ubicación': dispara la acción cliente
        que lee el GPS real del navegador (sin pedir confirmación --
        es de solo lectura, no sobreescribe nada de un cliente, solo
        se usa para calcular distancias) y la guarda en este wizard."""
        self.ensure_one()
        return {
            "type": "ir.actions.client",
            "tag": "shalom_capturar_mi_ubicacion",
            "params": {"wizard_id": self.id},
        }

    def action_guardar_mi_ubicacion(self, lat, lng):
        """Llamado desde el JS de 'Capturar mi ubicación' con el GPS
        real del dispositivo."""
        self.ensure_one()
        self.write({"mi_lat": lat, "mi_lng": lng})
        return True


class ShalomBuscarGpsWizardLine(models.TransientModel):
    _name = "shalom.buscar.gps.wizard.line"
    _description = "Cliente a revisar en el wizard de GPS"

    wizard_id = fields.Many2one(
        "shalom.buscar.gps.wizard", required=True, ondelete="cascade"
    )
    # readonly a nivel de vista (no de campo) + force_save: con
    # readonly=True a nivel de campo, o sin force_save en la vista, el
    # cliente web no reenvía el valor al guardar un registro nuevo
    # armado por default_get -- causaba un NOT NULL al abrir el wizard.
    location_id = fields.Many2one("fsm.location", required=True)
    location_direccion_actual = fields.Char(
        related="location_id.street", string="Dirección actual"
    )

    def action_buscar_opciones(self):
        """Botón 'Buscar opciones en Google': busca EN EL MOMENTO,
        solo para este cliente, y abre un popup con hasta 3 resultados
        para elegir a mano (o descartar/borrar desde ahí mismo)."""
        self.ensure_one()
        token = os.environ.get("GOOGLE_PLACES_API_KEY")
        if not token:
            raise UserError(
                _("No se encontró la variable de entorno "
                  "GOOGLE_PLACES_API_KEY en el servidor. Configurala "
                  "antes de buscar.")
            )
        candidatos = _buscar_en_google(self.location_id.name, token)
        mi_lat, mi_lng = self.wizard_id.mi_lat, self.wizard_id.mi_lng
        opcion = self.env["shalom.buscar.gps.wizard.opcion"].create(
            {
                "location_id": self.location_id.id,
                # guardado para poder recalcular distancia_km si se
                # vuelve a buscar desde el popup (action_buscar_de_nuevo).
                "wizard_id": self.wizard_id.id,
                # precargada con el nombre guardado del cliente -- el
                # usuario la puede reescribir a mano y volver a buscar
                # desde el popup (action_buscar_de_nuevo) si el nombre
                # tal cual está guardado no encuentra el local correcto.
                "query_busqueda": self.location_id.name,
                "candidato_ids": [
                    (0, 0, {
                        "nombre": c["nombre"],
                        "direccion": c["direccion"],
                        "lat": c["lat"],
                        "lng": c["lng"],
                        "distancia_km": _distancia_km(
                            mi_lat, mi_lng, c["lat"], c["lng"]
                        ) or 0.0,
                    })
                    for c in candidatos
                ],
            }
        )
        return {
            "type": "ir.actions.act_window",
            "res_model": "shalom.buscar.gps.wizard.opcion",
            "res_id": opcion.id,
            "view_mode": "form",
            "views": [[False, "form"]],
            "target": "new",
        }

    def action_dejar_como_esta(self):
        """Botón 'Dejar como está': no busca ni cambia el GPS, pero
        saca a este cliente de la cola para siempre (hasta que alguien
        lo revise de nuevo a mano) -- y de esta misma lista, para que
        el progreso se vea reflejado al toque sin tener que recargar."""
        self.ensure_one()
        nombre = self.location_id.name
        self.location_id.x_gps_wizard_revisado = True
        self.unlink()
        return _notificacion(_("'%s' no va a volver a aparecer.") % nombre)

    def action_borrar_coordenada(self):
        """Botón 'Borrar coordenada actual': vacía el GPS de este
        cliente pero lo DEJA en la cola (a diferencia de 'Dejar como
        está') -- la intención es seguir buscándole una coordenada
        real más adelante, no abandonarlo."""
        self.ensure_one()
        self.location_id.shalom_actualizar_gps(0.0, 0.0)
        self.location_id.x_gps_wizard_revisado = False
        return _notificacion(
            _("Coordenada de '%s' borrada. Sigue en la cola.") % self.location_id.name
        )


class ShalomBuscarGpsWizardOpcion(models.TransientModel):
    _name = "shalom.buscar.gps.wizard.opcion"
    _description = "Opciones de GPS encontradas para un cliente"

    location_id = fields.Many2one("fsm.location", required=True, readonly=True)
    # Opcional a propósito (a diferencia de location_id): solo se usa
    # para recalcular distancia_km al rebuscar; si por lo que sea no
    # está, action_buscar_de_nuevo() simplemente no calcula distancia.
    wizard_id = fields.Many2one("shalom.buscar.gps.wizard")
    # Coordenada YA GUARDADA en Odoo para este cliente (si tiene) --
    # se muestra al lado de las opciones de Google para poder comparar,
    # pedido explícito: "mantener la ubicación de las opciones de
    # Google Maps eso me gusta" + mostrar también la actual.
    location_lat = fields.Float(
        related="location_id.partner_latitude", string="Latitud actual", readonly=True
    )
    location_lng = fields.Float(
        related="location_id.partner_longitude", string="Longitud actual", readonly=True
    )
    location_direccion_actual = fields.Char(
        related="location_id.street",
        string="Dirección guardada en Odoo",
        readonly=True,
        help="La dirección que este cliente tiene guardada en Odoo AHORA "
        "-- para comparar de un vistazo contra la dirección de cada "
        "opción de Google, no solo el nombre.",
    )
    query_busqueda = fields.Char(
        string="Buscar en Google Maps",
        help="Precargado con el nombre guardado del cliente. Si Google "
        "no encuentra el local correcto con ese nombre tal cual (typo, "
        "alias, local que cambió de nombre...), reescribí acá lo que "
        "haga falta -- una calle, una referencia, otro nombre -- y "
        "apretá 'Buscar' de nuevo para traer opciones nuevas, sin "
        "salir de este popup.",
    )
    candidato_ids = fields.One2many(
        "shalom.buscar.gps.wizard.candidato", "opcion_id", string="Opciones"
    )

    def action_buscar_de_nuevo(self):
        """Botón 'Buscar': repite la búsqueda en Google con
        query_busqueda (editado a mano por el usuario, no
        necesariamente el nombre guardado del cliente) y reemplaza
        candidato_ids con los resultados nuevos, sin cerrar el popup."""
        self.ensure_one()
        if not self.query_busqueda or not self.query_busqueda.strip():
            raise UserError(_("Escribí algo para buscar."))
        token = os.environ.get("GOOGLE_PLACES_API_KEY")
        if not token:
            raise UserError(
                _("No se encontró la variable de entorno "
                  "GOOGLE_PLACES_API_KEY en el servidor. Configurala "
                  "antes de buscar.")
            )
        candidatos = _buscar_en_google(self.query_busqueda.strip(), token)
        mi_lat = self.wizard_id.mi_lat if self.wizard_id else False
        mi_lng = self.wizard_id.mi_lng if self.wizard_id else False
        self.candidato_ids.unlink()
        self.write(
            {
                "candidato_ids": [
                    (0, 0, {
                        "nombre": c["nombre"],
                        "direccion": c["direccion"],
                        "lat": c["lat"],
                        "lng": c["lng"],
                        "distancia_km": _distancia_km(
                            mi_lat, mi_lng, c["lat"], c["lng"]
                        ) or 0.0,
                    })
                    for c in candidatos
                ]
            }
        )
        if not candidatos:
            return _notificacion(
                _("Google no encontró nada para '%s'. Probá reescribir "
                  "la búsqueda.") % self.query_busqueda
            )
        return {
            "type": "ir.actions.act_window",
            "res_model": self._name,
            "res_id": self.id,
            "view_mode": "form",
            "views": [[False, "form"]],
            "target": "new",
        }

    def action_dejar_como_esta(self):
        self.ensure_one()
        self.location_id.x_gps_wizard_revisado = True
        return self._volver_al_wizard_o_cerrar(
            _("'%s' no va a volver a aparecer.") % self.location_id.name
        )

    def action_borrar_coordenada(self):
        self.ensure_one()
        self.location_id.shalom_actualizar_gps(0.0, 0.0)
        self.location_id.x_gps_wizard_revisado = False
        return self._volver_al_wizard_o_cerrar(
            _("Coordenada de '%s' borrada. Sigue en la cola.") % self.location_id.name,
            sacar_de_la_lista=False,
        )

    def action_ver_mapa_actual(self):
        """Botón 'Ver mapa' de la coordenada YA GUARDADA en Odoo para
        este cliente (para comparar contra las opciones de Google)."""
        self.ensure_one()
        if not self.location_lat and not self.location_lng:
            raise UserError(_("Este cliente todavía no tiene coordenada guardada."))
        url = (
            f"https://www.google.com/maps/search/?api=1"
            f"&query={self.location_lat}%2C{self.location_lng}"
        )
        return {"type": "ir.actions.act_url", "url": url, "target": "new"}

    def action_cerrar_popup(self):
        """Botón 'Cerrar sin elegir' del footer: antes era un botón
        nativo special='cancel', que -- por cómo Odoo apila (o más
        bien NO apila) diálogos target='new' abiertos desde dentro de
        otro diálogo -- terminaba sacando al usuario del wizard
        principal en vez de solo cerrar este popup. Ahora vuelve al
        wizard igual que las otras acciones del popup, sin tocar nada
        de este cliente (no se saca de la lista: no se decidió nada)."""
        self.ensure_one()
        return self._volver_al_wizard_o_cerrar(
            _("Sin cambios en '%s'.") % self.location_id.name,
            sacar_de_la_lista=False,
        )

    def _volver_al_wizard_o_cerrar(self, mensaje, sacar_de_la_lista=True):
        """Después de manejar un cliente desde este popup (usar una
        coordenada, dejar como está, borrar coordenada), en vez de
        cerrar todo y mandar al usuario de vuelta al menú -- vuelve a
        abrir el wizard principal (mismo wizard_id, con su Ruta y "mi
        ubicación" ya cargadas) para poder seguir con el próximo
        cliente de la lista sin tener que reconfigurar nada. Reportado:
        con 100+ clientes en una ruta, tener que reabrir el wizard y
        volver a elegir Ruta + capturar ubicación por cada cliente
        hacía la tarea impracticable.

        sacar_de_la_lista=True quita la línea de ESTE cliente de la
        lista del wizard (ya se terminó de revisar); False la deja
        (ej. "Borrar coordenada", donde la intención es que siga
        apareciendo para seguir intentando).

        Si por lo que sea no hay wizard_id (dato viejo, de antes de
        este cambio), cae al comportamiento anterior de solo cerrar."""
        self.ensure_one()
        if not self.wizard_id:
            return _notificacion_y_cerrar(mensaje)
        if sacar_de_la_lista:
            linea = self.wizard_id.line_ids.filtered(
                lambda l: l.location_id.id == self.location_id.id
            )
            linea.unlink()
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Listo"),
                "message": mensaje,
                "sticky": False,
                "type": "success",
                "next": {
                    "type": "ir.actions.act_window",
                    "res_model": "shalom.buscar.gps.wizard",
                    "res_id": self.wizard_id.id,
                    "view_mode": "form",
                    # "views" es obligatorio acá -- a diferencia de un
                    # action devuelto DIRECTO por un botón (que Odoo
                    # completa solo), este "next" adentro de una
                    # notificación se pasa tal cual a doAction() y sin
                    # "views" tira "Cannot read properties of
                    # undefined (reading 'map')" en el cliente.
                    "views": [[False, "form"]],
                    "target": "new",
                },
            },
        }


class ShalomBuscarGpsWizardCandidato(models.TransientModel):
    _name = "shalom.buscar.gps.wizard.candidato"
    _description = "Una opción de Google para un cliente"

    opcion_id = fields.Many2one(
        "shalom.buscar.gps.wizard.opcion", required=True, ondelete="cascade"
    )
    nombre = fields.Char(readonly=True)
    direccion = fields.Char(readonly=True)
    lat = fields.Float(digits=(16, 7), readonly=True)
    lng = fields.Float(digits=(16, 7), readonly=True)
    distancia_km = fields.Float(
        digits=(10, 2),
        readonly=True,
        string="Distancia",
        help="Distancia en línea recta desde 'mi ubicación' (capturada "
        "con el botón del wizard) hasta esta opción. Vacío (0) si "
        "todavía no se capturó la ubicación.",
    )

    def action_ver_mapa(self):
        """Botón 'Ver mapa': abre Google Maps (pestaña nueva) centrado
        en esta opción, para chequear a ojo si cae en el lugar
        correcto antes de elegirla."""
        self.ensure_one()
        url = f"https://www.google.com/maps/search/?api=1&query={self.lat}%2C{self.lng}"
        return {"type": "ir.actions.act_url", "url": url, "target": "new"}

    def action_usar_esta(self):
        """Botón 'Usar esta opción': guarda esta coordenada en el
        cliente, lo saca de la cola, y vuelve al wizard principal
        (ver _volver_al_wizard_o_cerrar) para seguir con el próximo
        cliente sin tener que reabrir/reconfigurar nada."""
        self.ensure_one()
        location = self.opcion_id.location_id
        location.shalom_actualizar_gps(self.lat, self.lng)
        location.x_gps_wizard_revisado = True
        _logger.info(
            "GPS por nombre aplicado a fsm.location id=%s vía Google Places "
            "('%s').", location.id, self.nombre,
        )
        return self.opcion_id._volver_al_wizard_o_cerrar(
            _("GPS de '%s' actualizado.") % location.name
        )


def _notificacion(mensaje):
    return {
        "type": "ir.actions.client",
        "tag": "display_notification",
        "params": {"title": _("Listo"), "message": mensaje, "sticky": False, "type": "success"},
    }


def _notificacion_y_cerrar(mensaje):
    return {
        "type": "ir.actions.client",
        "tag": "display_notification",
        "params": {
            "title": _("Listo"),
            "message": mensaje,
            "sticky": False,
            "type": "success",
            "next": {"type": "ir.actions.act_window_close"},
        },
    }
