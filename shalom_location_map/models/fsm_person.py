# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Extiende fsm.person (el vendedor) con métodos "mis datos" que usa la
app de ruta del vendedor (Owl) para pedir, en una sola llamada, todo lo
que le corresponde ver al usuario logueado: sus rutas programadas, su
directorio de clientes y sus cotizaciones -- sin que el frontend tenga
que reconstruir esos dominios a mano en cada pantalla.

"Asignado a mí" se resuelve siempre igual: el fsm.person del usuario
logueado (fsm.person.user_id = uid), y de ahí las fsm.route donde
fsm_person_id sea ese fsm.person -- reutiliza el mismo campo que ya usa
el resto del stack de Field Service, sin pedirle a oficina que cargue
un dato nuevo de asignación.
"""
import logging

from odoo import _, api, models
from odoo.exceptions import AccessError

from . import juego_utils, tz_utils

_logger = logging.getLogger(__name__)

# Mismo criterio que fsm_order.py y fsm_route_schedule.py.
ESTADOS_VENTA_CONFIRMADA = ("sale", "done")


class FSMPerson(models.Model):
    _inherit = "fsm.person"

    @api.model
    def _shalom_persona_actual(self):
        """fsm.person del usuario logueado, o recordset vacío si no
        tiene ninguno vinculado (por ejemplo, un admin sin fsm.person
        propio)."""
        return self.search([("user_id", "=", self.env.uid)], limit=1)

    @api.model
    def shalom_mis_rutas_programadas(self, date_start=None, date_end=None):
        """Ciclos (fsm.route.schedule) con AL MENOS UN cliente pendiente
        (una visita en una etapa no cerrada), sin importar sus fechas. Los
        vendedores eligen qué ruta atender: ya no se filtra por semana.
        Un ciclo donde todos los clientes tienen etiqueta (Completado, No
        atendido, No quiso, Cancelado) no aparece, aunque sea de esta
        semana; uno viejo con clientes pendientes, sí. date_start y
        date_end ya no se usan (se aceptan por compatibilidad).

        Caso aparte, solo para Visita Exprés: si Administración archivó
        (no cerró, ARCHIVÓ) a todos los clientes de un lote -- ver
        archivarVisitaExpress() en admin_gestion.js --, fsm_order_ids
        queda vacío (un One2many no trae los archivados) y _compute_estado
        de fsm_route_schedule.py, al no tener NINGUNA visita para mirar,
        cae en 'por_iniciar' (no 'completada') -- por diseño correcto
        para una ruta normal recién creada, pero acá da un falso "todavía
        activa" que la dejaba visible para siempre en la app del
        vendedor. Por eso, para rutas de Visita Exprés en particular, se
        chequea directo si tienen alguna visita ABIERTA ahora mismo --
        no alcanza con mirar 'estado'.

        Devuelve datos ya listos para la pestaña 'Rutas' de la app,
        sin que el frontend tenga que hacer una segunda llamada por
        ruta."""
        persona = self._shalom_persona_actual()
        if not persona:
            return []
        # Las rutas son LIBRES: cualquier vendedor ve todas y elige cuál
        # atender; la marca de quién la está trabajando sale en
        # "tomada_por" (ver shalom_ruta_toma.py). La Visita Exprés sigue
        # siendo solo de su vendedor.
        con_pendientes = [
            ciclo.id
            for (ciclo,) in self.env["fsm.order"]._read_group(
                [("x_route_schedule_id", "!=", False), ("stage_id.is_closed", "=", False)],
                ["x_route_schedule_id"],
            )
        ]
        schedules = self.env["fsm.route.schedule"].search(
            [("id", "in", con_pendientes)], order="date_start asc"
        )
        schedules = schedules.filtered(
            lambda s: not s.route_id.x_es_visita_express
            or (
                s.fsm_person_id == persona
                and s.fsm_order_ids.filtered(lambda o: not o.stage_id.is_closed)
            )
        )
        # Ciclos que ya tienen clientes repartidos (una sola consulta
        # agrupada; recorrer fsm_order_ids de cada ciclo cargaba todas las
        # columnas de miles de visitas al abrir la pestaña Rutas).
        con_cartera = set()
        if schedules:
            for ciclo, _n in self.env["fsm.order"]._read_group(
                [
                    ("x_route_schedule_id", "in", schedules.ids),
                    ("x_cartera_person_id", "!=", False),
                ],
                ["x_route_schedule_id"],
                ["__count"],
            ):
                con_cartera.add(ciclo.id)
        # Una sola pasada de visitas y de historial de ventas para el mapa
        # y para el filtro de "sin ventas" (antes cada uno lo pedía aparte).
        locs_por_ciclo, abiertas, perfiles = self._shalom_datos_ciclos(schedules)
        centros, mios = self._shalom_mapa_ciclos(persona, schedules, con_cartera, abiertas, perfiles)
        con_ventas = self._shalom_clientes_con_ventas_por_ciclo(locs_por_ciclo, abiertas, perfiles)
        tomas = self.env["shalom.ruta.toma"]._shalom_vigentes(schedules.ids, persona)
        return [
            {
                "id": s.id,
                "route_id": s.route_id.id,
                "route_name": s.route_id.name,
                "date_start": s.date_start.isoformat(),
                "date_end": s.date_end.isoformat(),
                "tiempo_estimado": s.x_tiempo_estimado,
                "capacidad": s.capacidad,
                "estado": s.estado,
                "cantidad_clientes": s.cantidad_clientes,
                # Cuántos clientes del ciclo ya compraron alguna vez: la app
                # oculta por defecto las rutas donde son 0.
                "clientes_con_ventas": con_ventas.get(s.id, (0, 0))[0],
                # Visitas por atender de clientes que ya compraron: si es 0 la
                # ruta no tiene nada que vender y la app la oculta.
                "pendientes_con_ventas": con_ventas.get(s.id, (0, 0))[1],
                # Quién está trabajando esta ruta (ver shalom_ruta_toma.py).
                "tomada_por": tomas.get(s.id, []),
                "es_mia": s.fsm_person_id == persona,
                # Para que la tarjeta de Visita Exprés se resalte con
                # el halo de marca en la app del vendedor -- ver
                # rutas_hub.js/.xml. x_es_visita_express vive en
                # fsm.route (ver fsm_route.py).
                "es_visita_express": s.route_id.x_es_visita_express,
                # Reparto de carteras: mi id y si este ciclo ya tiene
                # clientes repartidos (RutaDetalle muestra entonces el
                # filtro "Mi cartera / Toda la ruta").
                "mi_persona_id": persona.id,
                "tiene_cartera": s.id in con_cartera,
                # Mapa de rutas (Fase 5): centro de los clientes con GPS y lo
                # que me toca de este ciclo (pendientes y valor esperado).
                "centro_lat": centros.get(s.id, (0.0, 0.0))[0],
                "centro_lng": centros.get(s.id, (0.0, 0.0))[1],
                "pendientes_mios": mios.get(s.id, {}).get("pendientes", 0),
                "esperado_mio": mios.get(s.id, {}).get("esperado", 0.0),
            }
            for s in schedules
        ]

    @api.model
    def _shalom_datos_ciclos(self, schedules):
        """(locs_por_ciclo, abiertas, perfiles) de varios ciclos con pocas
        consultas: clientes de cada ciclo, visitas abiertas y el perfil de
        ventas de todos esos clientes (UNA consulta de pedidos)."""
        if not schedules:
            return {}, [], {}
        Orden = self.env["fsm.order"]
        locs_por_ciclo = {}
        for ciclo, loc in Orden._read_group(
            [("x_route_schedule_id", "in", schedules.ids), ("location_id", "!=", False)],
            ["x_route_schedule_id", "location_id"],
        ):
            locs_por_ciclo.setdefault(ciclo.id, set()).add(loc.id)
        abiertas = Orden.search_read(
            [("x_route_schedule_id", "in", schedules.ids), ("stage_id.is_closed", "=", False)],
            ["x_route_schedule_id", "location_id", "x_cartera_person_id"],
            load="",
        )
        todas = set().union(*locs_por_ciclo.values()) if locs_por_ciclo else set()
        perfiles = Orden._shalom_perfiles_clientes(
            self.env["fsm.location"].browse(list(todas)).exists()
        )
        return locs_por_ciclo, abiertas, perfiles

    @api.model
    def _shalom_clientes_con_ventas_por_ciclo(self, locs_por_ciclo, abiertas, perfiles):
        """{schedule_id: (clientes del ciclo que ya compraron, visitas por
        atender de clientes que ya compraron)}. Ventas = pedidos confirmados
        sin la empresa de Nevada (misma regla del juego)."""
        con_ventas = lambda loc_id: bool(perfiles.get(loc_id, {}).get("n"))  # noqa: E731
        resultado = {
            ciclo_id: [sum(1 for loc_id in locs if con_ventas(loc_id)), 0]
            for ciclo_id, locs in locs_por_ciclo.items()
        }
        for o in abiertas:
            if o["location_id"] and con_ventas(o["location_id"]) and o["x_route_schedule_id"] in resultado:
                resultado[o["x_route_schedule_id"]][1] += 1
        return {k: tuple(v) for k, v in resultado.items()}

    @api.model
    def _shalom_mapa_ciclos(self, persona, schedules, con_cartera, abiertas, perfiles):
        """Datos para el mapa de rutas de la pestaña Rutas.

        Devuelve (centros, mios): centros = {schedule_id: (lat, lng)}
        promedio de los clientes con GPS del ciclo; mios = {schedule_id:
        {"pendientes", "esperado"}} con lo que le toca a `persona`: los
        clientes de su cartera si el ciclo ya está repartido, o todo el
        ciclo si la ruta es suya y no hay reparto. Solo cuentan clientes
        que compran (clases A, A2, B, B2) y no son distribuidoras."""
        centros, mios = {}, {}
        if not schedules:
            return centros, mios
        Orden = self.env["fsm.order"]
        for ciclo, lat, lng in Orden._read_group(
            [
                ("x_route_schedule_id", "in", schedules.ids),
                ("x_cliente_lat", "!=", 0),
                ("x_cliente_lng", "!=", 0),
            ],
            ["x_route_schedule_id"],
            ["x_cliente_lat:avg", "x_cliente_lng:avg"],
        ):
            centros[ciclo.id] = (lat, lng)
        mias = [
            o for o in abiertas
            if o["location_id"]
            and (
                o["x_cartera_person_id"] == persona.id
                if o["x_route_schedule_id"] in con_cartera
                else True  # ruta libre sin reparto: todo el ciclo está disponible
            )
        ]
        locations = self.env["fsm.location"].browse({o["location_id"] for o in mias}).exists()
        distribuidoras = set(locations.filtered("x_es_distribuidora").ids)
        for o in mias:
            perfil = perfiles.get(o["location_id"])
            if (
                not perfil
                or perfil["clase"] not in juego_utils.CLASES_CARTERA
                or o["location_id"] in distribuidoras
            ):
                continue
            dato = mios.setdefault(o["x_route_schedule_id"], {"pendientes": 0, "esperado": 0.0})
            dato["pendientes"] += 1
            dato["esperado"] = round(dato["esperado"] + perfil["esperado"], 2)
        return centros, mios

    @api.model
    def shalom_mis_rutas(self):
        """Rutas (fsm.route) para el selector de ruta del formulario
        ampliado de cliente (Editar cliente / Alta rápida). Distinto de
        shalom_mis_rutas_programadas(): acá se listan las rutas en sí,
        no sus ocurrencias semanales.

        Un Administrador de Servicio de Campo ve TODAS las rutas
        activas -- necesita poder reasignar cualquier cliente a
        cualquier ruta, no solo a las que él mismo tenga asignadas como
        vendedor (un admin también puede tener su propio fsm.person, con
        las rutas que haya manejado antes -- mismo criterio que ya usa
        shalom_admin_rutas_programadas() para esta misma distinción).
        Cualquier otro usuario sigue viendo solo las rutas asignadas a
        su propio fsm.person, como siempre."""
        if self.env.user.has_group("fieldservice.group_fsm_manager"):
            rutas = self.env["fsm.route"].search([], order="name asc")
        else:
            persona = self._shalom_persona_actual()
            if not persona:
                return []
            rutas = self.env["fsm.route"].search(
                [("fsm_person_id", "=", persona.id)], order="name asc"
            )
        return [{"id": r.id, "name": r.name} for r in rutas]

    @api.model
    def shalom_buscar(self, texto):
        """Búsqueda de clientes en TODAS las rutas (rutas libres), solo por el
        NOMBRE del cliente (buscar también en dirección/teléfono/RUC traía
        demasiados resultados que no se buscaban). Para cada cliente dice en qué ruta y parada
        está, el estado de su visita en el ciclo vigente de esa ruta y quién la
        está atendiendo, más un `schedule` listo para abrir esa ruta. Máximo 30
        resultados."""
        texto = (texto or "").strip()
        if len(texto) < 2:
            return []
        persona = self._shalom_persona_actual()
        locations = self.env["fsm.location"].search(
            [("name", "ilike", texto), ("fsm_route_id", "!=", False)],
            limit=30,
            order="name",
        )
        if not locations:
            return []
        Ciclo = self.env["fsm.route.schedule"]
        ciclos = Ciclo.search(
            [("route_id", "in", locations.fsm_route_id.ids)], order="date_start desc, id desc"
        )
        # Ciclo vigente de cada ruta: el más reciente que no esté completado
        # (si todos lo están, el más reciente).
        vigente = {}
        for c in ciclos:
            actual = vigente.get(c.route_id.id)
            if actual is None or (actual.estado == "completada" and c.estado != "completada"):
                vigente[c.route_id.id] = c
        visitas = {}
        if vigente:
            for o in self.env["fsm.order"].search(
                [
                    ("x_route_schedule_id", "in", [c.id for c in vigente.values()]),
                    ("location_id", "in", locations.ids),
                ],
                order="id asc",
            ):
                visitas[(o.x_route_schedule_id.id, o.location_id.id)] = o
        tomas = self.env["shalom.ruta.toma"]._shalom_vigentes([c.id for c in vigente.values()], persona)
        hoy = tz_utils.hoy_local(self.env)
        resultado = []
        for loc in locations:
            ciclo = vigente.get(loc.fsm_route_id.id)
            orden = visitas.get((ciclo.id, loc.id)) if ciclo else None
            atendio = ""
            atendio_hoy = False
            if orden and orden.stage_id.is_closed:
                persona_orden = self.search([("user_id", "=", orden.write_uid.id)], limit=1)
                atendio = persona_orden.name or ""
                atendio_hoy = bool(orden.write_date) and tz_utils.a_local(self.env, orden.write_date).date() == hoy
            resultado.append(
                {
                    "location_id": loc.id,
                    "name": loc.name,
                    "street": loc.street or "",
                    "street2": loc.street2 or "",
                    "phone": loc.phone or (loc.partner_id.mobile if loc.partner_id else "") or "",
                    "route_id": loc.fsm_route_id.id,
                    "route_name": loc.fsm_route_id.name,
                    "parada": loc.x_orden_ruta or 0,
                    "stage_name": orden.stage_id.name if orden else "",
                    "cerrada": bool(orden and orden.stage_id.is_closed),
                    "atendido_por": atendio,
                    "atendido_hoy": atendio_hoy,
                    "tomada_por": tomas.get(ciclo.id, []) if ciclo else [],
                    "schedule": {
                        "id": ciclo.id,
                        "route_id": ciclo.route_id.id,
                        "route_name": ciclo.route_id.name,
                        "date_start": ciclo.date_start.isoformat() if ciclo.date_start else "",
                        "date_end": ciclo.date_end.isoformat() if ciclo.date_end else "",
                        "estado": ciclo.estado,
                        "cantidad_clientes": ciclo.cantidad_clientes,
                        "es_visita_express": False,
                        "mi_persona_id": persona.id,
                        "tiene_cartera": bool(
                            self.env["fsm.order"].search_count(
                                [("x_route_schedule_id", "=", ciclo.id), ("x_cartera_person_id", "!=", False)]
                            )
                        ),
                        "tomada_por": tomas.get(ciclo.id, []),
                    } if ciclo else False,
                }
            )
        return resultado

    @api.model
    def shalom_mis_clientes(self):
        """Directorio de TODAS las fsm.location que están en una ruta (las
        rutas son libres: ya no se limita a las asignadas al vendedor).
        Se incluye a cuál ruta pertenece cada cliente
        (fsm_route_id/fsm_route_name) para mostrarlo en la lista y para
        el formulario ampliado de edición (RUC/celular/correo vienen
        del contacto, res.partner)."""
        # Rutas libres: todos los vendedores ven todos los clientes (no solo
        # los de las rutas que tienen asignadas) para poder vender, llamar o
        # corregir datos de cualquiera.
        rutas = self.env["fsm.route"].search([])
        # Ordenados por ruta y después por posición dentro de la ruta
        locations = self.env["fsm.location"].search(
            [("fsm_route_id", "in", rutas.ids)],
            order="fsm_route_id, x_orden_ruta asc",
        )
        return [
            {
                "id": loc.id,
                "name": loc.name,
                "phone": loc.phone,
                "street": loc.street,
                "street2": loc.street2,
                "partner_id": loc.partner_id.id if loc.partner_id else False,
                "x_orden_ruta": loc.x_orden_ruta,
                "fsm_route_id": loc.fsm_route_id.id if loc.fsm_route_id else False,
                "fsm_route_name": loc.fsm_route_id.name if loc.fsm_route_id else "",
                "vat": loc.partner_id.vat if loc.partner_id else False,
                "mobile": loc.partner_id.mobile if loc.partner_id else False,
                "email": loc.partner_id.email if loc.partner_id else False,
            }
            for loc in locations
        ]

    @api.model
    def shalom_mis_cotizaciones(self):
        """sale.order hechas por el vendedor logueado (a su nombre), de
        cualquier cliente, de más reciente a más antigua. Incluye borradores y confirmadas; excluye
        canceladas."""
        # Solo las cotizaciones del propio usuario (vendedor del pedido o quien
        # la creó), de cualquier cliente.
        orders = self.env["sale.order"].search(
            [
                ("state", "!=", "cancel"),
                "|",
                ("user_id", "=", self.env.uid),
                ("create_uid", "=", self.env.uid),
            ],
            order="date_order desc",
            limit=300,
        )
        return [
            {
                "id": o.id,
                "name": o.name,
                "partner_name": o.partner_id.name,
                "date_order": o.date_order.isoformat() if o.date_order else False,
                "amount_total": o.amount_total,
                "confirmada": o.state in ESTADOS_VENTA_CONFIRMADA,
            }
            for o in orders
        ]

    @api.model
    def shalom_admin_rutas_programadas(self):
        """Administración → Rutas de mis vendedores: TODAS las
        ocurrencias de fsm.route.schedule todavía no completadas, de
        TODOS los vendedores (no solo el usuario logueado), agrupadas
        por vendedor -- para el selector "vendedor primero, en
        cascada" (Opción A del mockup). Mismo criterio de "abierta"
        que shalom_mis_rutas_programadas(), sin la restricción de
        fsm_person_id."""
        if not self.env.user.has_group("fieldservice.group_fsm_manager"):
            raise AccessError(_(
                "Esta acción es solo para el rol Administrador de "
                "Servicio de Campo."
            ))
        # Solo ciclos ACTIVOS: con al menos un cliente pendiente (visita en
        # etapa no cerrada). Pedido explícito: los que ya tienen a todos
        # sus clientes con etiqueta (Completado, No atendido, No quiso,
        # Cancelado) no se muestran, aunque el cron los haya marcado como
        # reposición incompleta -- antes se acumulaban todos los ciclos.
        con_pendientes = [
            ciclo.id
            for (ciclo,) in self.env["fsm.order"]._read_group(
                [("x_route_schedule_id", "!=", False), ("stage_id.is_closed", "=", False)],
                ["x_route_schedule_id"],
            )
        ]
        schedules = self.env["fsm.route.schedule"].search(
            [("id", "in", con_pendientes)],
            order="fsm_person_id, date_start asc",
        )
        vendedores = {}
        for s in schedules:
            persona = s.fsm_person_id
            if not persona:
                continue
            if persona.id not in vendedores:
                vendedores[persona.id] = {
                    "persona_id": persona.id,
                    "persona_nombre": persona.name,
                    "rutas": [],
                }
            vendedores[persona.id]["rutas"].append(
                {
                    "id": s.id,
                    "route_id": s.route_id.id,
                    "route_name": s.route_id.name,
                    "cantidad_clientes": s.cantidad_clientes,
                    "estado": s.estado,
                    # Para resaltar la pastilla de esta ruta con el
                    # halo de marca en Administración -- ver
                    # admin_gestion.js/.xml (misma idea que ya se hizo
                    # en rutas_hub.js/.xml para la app del vendedor).
                    "es_visita_express": s.route_id.x_es_visita_express,
                    # Mismo campo que ya se muestra en "Ruta Shalom" (app
                    # del vendedor, rutas_hub.xml) -- acá para que
                    # Administración pueda ver de un vistazo qué rutas
                    # conviene partir por ser demasiado grandes.
                    "capacidad": s.capacidad,
                    # Marcados por _shalom_reponer_rutas_vencidas
                    # (fsm_route_schedule.py) cuando el cron generó el
                    # ciclo siguiente sin que este se completara --
                    # ver admin_gestion.xml para el ícono de alerta.
                    "x_reposicion_incompleta": s.x_reposicion_incompleta,
                    "x_visitas_pendientes_al_reponer": s.x_visitas_pendientes_al_reponer,
                }
            )
        return list(vendedores.values())
