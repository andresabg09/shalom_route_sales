# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Administración → pestaña "Gerente" (Fase 7 del juego de ventas): la vista
del dueño. Todo es SOLO para el rol Administrador de Servicio de Campo
(fieldservice.group_fsm_manager) y se lee con sudo() lo que haga falta,
porque son totales de toda la empresa. Es la única vista que devuelve
costo y utilidad en dólares: el vendedor nunca los ve.

Métodos (todos @api.model, colgados de fsm.route para no crear un modelo
nuevo ni permisos nuevos):

- shalom_admin_reasignar_ruta(route_id, person_id, simular=False):
  pasa una ruta a otro vendedor.
- shalom_admin_reparto_rutas(): valor esperado mensual de cada ruta,
  agrupado por vendedor ("Reparto de rutas").
- shalom_admin_gerente_mes(): cómo va el mes (ventas contra piso y
  meta, margen, oxigenta por cada 100 tintes, estrellas y XP).
- shalom_admin_salud_datos(): ubicaciones sin GPS, clientes buenos sin
  ruta, GPS prioritario ordenado por valor.

Los cálculos puros (porcentajes, oxigenta/100, agrupación del reparto)
están en gerente_utils.py y se prueban fuera de Odoo.
"""
import logging

from odoo import _, api, fields, models
from odoo.exceptions import UserError

from . import gerente_utils, juego_utils, tz_utils

_logger = logging.getLogger(__name__)

# Mismo criterio que el resto del módulo: "venta real" = confirmada.
ESTADOS_VENTA_CONFIRMADA = ("sale", "done")


class FSMRouteGerente(models.Model):
    _inherit = "fsm.route"

    # ------------------------------------------------------------------
    # Reasignar una ruta a otro vendedor
    # ------------------------------------------------------------------

    @api.model
    def _shalom_gerente_exigir(self):
        # Mismo guardia que el reparto de carteras y las estrategias.
        self.env["fsm.route.schedule"]._shalom_exigir_admin()

    @api.model
    def _shalom_visitas_de_ruta(self, ruta):
        """Visitas (fsm.order, sin archivadas) de una ruta: las que hoy
        apuntan a la ruta por su cliente o las que nacieron de un ciclo
        de esa ruta (el cliente pudo cambiarse de ruta después)."""
        return [
            "|",
            ("fsm_route_id", "=", ruta.id),
            ("x_route_schedule_id.route_id", "=", ruta.id),
        ]

    @api.model
    def _shalom_pasar_visitas(self, visitas, persona):
        """Pone a `persona` como responsable (person_id) de las `visitas`.

        NO usa write(): fieldservice_route reacciona a un cambio de
        person_id en una visita con fecha programada armando una "ruta del
        día" (fsm.route.dayroute) y exige que la ruta corra ese día de la
        semana (ValidationError "The route X does not run on Monday!").
        Esta app no usa rutas del día -- las visitas llevan la fecha de
        inicio del ciclo -- y ese error abortaría la reasignación entera.
        Por eso se escribe la columna con _write() (igual que haría
        `unassigning` del propio fieldservice_route) y se suelta la visita
        de la ruta del día que pudiera tener, borrando las que queden
        vacías."""
        dayroutes = visitas.mapped("dayroute_id") if "dayroute_id" in visitas._fields else visitas.browse()
        valores = {
            "person_id": persona.id,
            "write_uid": self.env.uid,
            "write_date": fields.Datetime.now(),
        }
        if "dayroute_id" in visitas._fields:
            valores["dayroute_id"] = False
        visitas._write(valores)
        visitas.invalidate_recordset(list(valores))
        if dayroutes and hasattr(dayroutes, "_unlink_removable"):
            dayroutes._unlink_removable()

    @api.model
    def shalom_admin_reasignar_ruta(self, route_id, person_id, simular=False):
        """Pasa la ruta `route_id` al vendedor `person_id` (fsm.person).

        1. Cambia fsm_person_id de la ruta.
        2. Pasa al vendedor nuevo el person_id de las visitas ABIERTAS de
           la ruta que seguían a nombre del anterior (el person_id de una
           visita se calcula una sola vez, al crearla: cambiar el dueño de
           la ruta no lo mueve solo, y el vendedor nuevo no las vería a su
           nombre en Field Service).
        3. NO toca visitas cerradas ni archiva nada.
        4. Si había cartera repartida (x_cartera_*) en visitas abiertas de
           la ruta, la limpia: el reparto se hizo entre los vendedores
           anteriores y ya no vale. Hay que volver a repartir.

        Rechaza las rutas de Visita Exprés (son una por vendedor, se
        crean solas). Con simular=True no escribe nada y devuelve el
        mismo resumen en condicional: sirve para la confirmación de la
        pantalla ("esto es lo que va a cambiar")."""
        self._shalom_gerente_exigir()
        ruta = self.sudo().browse(route_id).exists()
        persona = self.env["fsm.person"].sudo().browse(person_id).exists()
        if not ruta:
            raise UserError(_("La ruta no existe."))
        if not persona:
            raise UserError(_("El vendedor no existe."))
        if ruta.x_es_visita_express:
            raise UserError(
                _("«%(ruta)s» es una Visita Exprés: se crea sola para cada "
                  "vendedor y no se reasigna.", ruta=ruta.name)
            )
        anterior = ruta.fsm_person_id
        if anterior == persona:
            raise UserError(
                _("«%(ruta)s» ya es de %(persona)s.", ruta=ruta.name, persona=persona.name)
            )

        Visita = self.env["fsm.order"].sudo()
        base = self._shalom_visitas_de_ruta(ruta)
        abiertas = Visita.search(base + [("stage_id.is_closed", "=", False)])
        a_pasar = abiertas.filtered(
            lambda v: (v.person_id == anterior) if anterior else not v.person_id
        )
        con_cartera = abiertas.filtered("x_cartera_person_id")
        cerradas = Visita.search_count(base + [("stage_id.is_closed", "=", True)])
        ciclos_con_cartera = sorted(
            {self._shalom_nombre_ciclo(v.x_route_schedule_id) for v in con_cartera if v.x_route_schedule_id}
        )
        resumen = {
            "simulado": bool(simular),
            "ruta_id": ruta.id,
            "ruta": ruta.name,
            "anterior": {"id": anterior.id, "nombre": anterior.name} if anterior else None,
            "nuevo": {"id": persona.id, "nombre": persona.name},
            "visitas_abiertas": len(abiertas),
            "visitas_pasadas": len(a_pasar),
            "visitas_de_otro": len(abiertas) - len(a_pasar),
            "visitas_cerradas_intactas": cerradas,
            "cartera_limpiada": len(con_cartera),
            "ciclos_con_cartera": ciclos_con_cartera,
        }
        if simular:
            return resumen

        # Se escribe como el gerente (no sudo): queda su nombre en el
        # historial de cambios de la ruta y las visitas.
        ruta_usuario = self.browse(ruta.id)
        ruta_usuario.write({"fsm_person_id": persona.id})
        if a_pasar:
            self._shalom_pasar_visitas(self.env["fsm.order"].browse(a_pasar.ids), persona)
        if con_cartera:
            self.env["fsm.order"].browse(con_cartera.ids).write({
                "x_cartera_person_id": False,
                "x_cartera_fecha": False,
                "x_cartera_orden": 0,
                "x_cartera_reserva": False,
            })
        _logger.info(
            "Ruta '%s' (id=%s) reasignada de %s a %s por %s: %s visita(s) abierta(s) "
            "pasadas, %s con cartera limpiada.",
            ruta.name, ruta.id, anterior.name or "nadie", persona.name,
            self.env.user.login, len(a_pasar), len(con_cartera),
        )
        return resumen

    # ------------------------------------------------------------------
    # Datos compartidos: una sola pasada por todas las ubicaciones
    # ------------------------------------------------------------------

    @api.model
    def _shalom_gerente_universo(self):
        """Todas las ubicaciones activas con su perfil de ventas, en
        BLOQUE (una lectura de ubicaciones y una consulta de pedidos, no
        una por cliente): ([{id, name, fsm_route_id, x_es_distribuidora,
        partner_latitude, partner_longitude, phone, mobile, category_id}],
        {location_id: perfil de fsm.order._shalom_perfiles_clientes})."""
        Ubicacion = self.env["fsm.location"].sudo()
        filas = Ubicacion.search_read(
            [],
            [
                "name", "fsm_route_id", "x_es_distribuidora", "partner_latitude",
                "partner_longitude", "phone", "mobile", "category_id",
            ],
            load="",
        )
        perfiles = self.env["fsm.order"]._shalom_perfiles_clientes(
            Ubicacion.browse([f["id"] for f in filas])
        )
        return filas, perfiles

    # ------------------------------------------------------------------
    # Reparto de rutas entre vendedores
    # ------------------------------------------------------------------

    @api.model
    def shalom_admin_reparto_rutas(self):
        """Tarjeta "Reparto de rutas (propuesta)": por vendedor, sus rutas
        con el valor esperado MENSUAL (visitando una vez a cada cliente
        que compra: suma del valor esperado de los clientes de clase A,
        A2, B y B2 que no son distribuidoras) y los días de venta que eso
        pide (valor / $2,000 por día, el mismo mínimo de las carteras).
        Más las rutas sin dueño o sin ventas y los clientes buenos sin
        ruta. Las rutas de Visita Exprés no entran.

        Devuelve {"vendedores": [...], "sin_dueno_o_ventas": [...],
        "total_mes", "sin_ruta": {"clientes", "valor", "top": [...]},
        "personas": [{"id", "name"}] (a quién se puede pasar una ruta),
        "por_dia"}. Ver gerente_utils.armar_reparto."""
        self._shalom_gerente_exigir()
        filas, perfiles = self._shalom_gerente_universo()
        valor, clientes, sin_ruta = {}, {}, []
        for fila in filas:
            if fila["x_es_distribuidora"]:
                continue
            perfil = perfiles.get(fila["id"])
            if not perfil or not gerente_utils.es_cliente_bueno(perfil["clase"]):
                continue
            ruta_id = fila["fsm_route_id"]
            if not ruta_id:
                sin_ruta.append({
                    "id": fila["id"], "name": fila["name"],
                    "clase": perfil["clase"], "valor": perfil["esperado"],
                })
                continue
            valor[ruta_id] = valor.get(ruta_id, 0.0) + perfil["esperado"]
            clientes[ruta_id] = clientes.get(ruta_id, 0) + 1
        rutas = self.sudo().search([("x_es_visita_express", "=", False)])
        reparto = gerente_utils.armar_reparto([
            {
                "id": r.id,
                "name": r.name,
                "person_id": r.fsm_person_id.id,
                "person_name": r.fsm_person_id.name,
                "valor": valor.get(r.id, 0.0),
                "clientes": clientes.get(r.id, 0),
                "dias_ciclo": r.x_duracion_dias,
            }
            for r in rutas
        ])
        reparto["sin_ruta"] = {
            "clientes": len(sin_ruta),
            "valor": round(sum(c["valor"] for c in sin_ruta), 2),
            "top": gerente_utils.ordenar_gps_prioritario(sin_ruta, 10),
        }
        reparto["personas"] = [
            {"id": p.id, "name": p.name}
            for p in self.env["fsm.person"].sudo().search([], order="name")
        ]
        reparto["por_dia"] = gerente_utils.VALOR_POR_DIA
        return reparto

    # ------------------------------------------------------------------
    # Cómo va el mes
    # ------------------------------------------------------------------

    @api.model
    def shalom_admin_gerente_mes(self):
        """Tarjetas "Mes en curso" de la vista del gerente (mes calendario
        en hora de Panamá):

        - ventas SIN impuestos de los pedidos confirmados del mes contra
          el piso y la meta (parámetros shalom.juego.piso_mes = 60000 y
          shalom.juego.meta_mes = 80000).
        - utilidad, costo y margen % del mes y margen % del año (campo
          `margin` de sale_margin; sin ese módulo quedan en None). Son
          dólares: esta es la vista del dueño.
        - unidades de oxigenta por cada 100 de tinte (productos por
          nombre, ver gerente_utils.oxigenta_por_100_tintes).
        - pedidos, estrellas y XP por vendedor (libro shalom.juego.evento,
          solo los pedidos confirmados desde la app) y el total del
          equipo."""
        self._shalom_gerente_exigir()
        env = self.env
        hoy = tz_utils.hoy_local(env)
        inicio, siguiente = gerente_utils.limites_mes(hoy)
        desde = tz_utils.inicio_de_dia_utc(env, inicio)
        hasta = tz_utils.inicio_de_dia_utc(env, siguiente)

        Orden = env["sale.order"].sudo()
        con_margen = "margin" in Orden._fields
        estados = list(ESTADOS_VENTA_CONFIRMADA)
        ordenes = Orden.search([
            ("state", "in", estados), ("date_order", ">=", desde), ("date_order", "<", hasta),
        ])
        ventas = round(sum(ordenes.mapped("amount_untaxed")), 2)
        utilidad = round(sum(ordenes.mapped("margin")), 2) if con_margen else None

        # Margen del año (enero a hoy), por la misma regla.
        margen_anio = None
        if con_margen:
            inicio_anio = tz_utils.inicio_de_dia_utc(env, inicio.replace(month=1))
            [(neto_anio, util_anio)] = Orden._read_group(
                [("state", "in", estados), ("date_order", ">=", inicio_anio), ("date_order", "<", hasta)],
                [],
                ["amount_untaxed:sum", "margin:sum"],
            )
            margen_anio = gerente_utils.margen_pct(util_anio or 0.0, neto_anio or 0.0)

        piso, meta = self._shalom_gerente_metas()

        # Oxigenta por cada 100 tintes: unidades por línea de pedido.
        lineas = env["sale.order.line"].sudo().search_read(
            [("order_id", "in", ordenes.ids), ("product_id", "!=", False), ("product_uom_qty", ">", 0)],
            ["order_id", "product_id", "product_uom_qty"],
            load="",
        )
        nombres = {
            p["id"]: p["name"]
            for p in env["product.product"].sudo().with_context(active_test=False)
            .browse(list({li["product_id"] for li in lineas})).read(["name"])
        }
        por_pedido = {}
        for li in lineas:
            por_pedido.setdefault(li["order_id"], []).append(
                (nombres.get(li["product_id"], ""), li["product_uom_qty"])
            )

        # Pedidos, estrellas y XP por vendedor.
        eventos = env["shalom.juego.evento"].sudo().search([("fecha", ">=", desde), ("fecha", "<", hasta)])
        por_persona = {}
        for ev in eventos:
            fila = por_persona.setdefault(ev.person_id.id, {
                "persona_id": ev.person_id.id, "persona_nombre": ev.person_id.name or "",
                "pedidos": 0, "ventas": 0.0, "estrellas": 0, "oro": 0, "xp": 0,
            })
            fila["pedidos"] += 1
            fila["ventas"] = round(fila["ventas"] + ev.total, 2)
            fila["estrellas"] += ev.estrellas
            fila["oro"] += 1 if ev.estrellas >= 3 else 0
            fila["xp"] += ev.xp
        vendedores = sorted(por_persona.values(), key=lambda f: f["persona_nombre"].lower())

        resultado = {
            "mes": fields.Date.to_string(inicio),
            "hasta": fields.Date.to_string(siguiente),
            "pedidos": len(ordenes),
            "ventas": ventas,
            "utilidad": utilidad,
            "costo": round(ventas - utilidad, 2) if utilidad is not None else None,
            "margen_pct": gerente_utils.margen_pct(utilidad, ventas) if utilidad is not None else None,
            "margen_anio_pct": margen_anio,
            "piso": piso,
            "meta": meta,
            "oxigenta": gerente_utils.oxigenta_por_100_tintes(por_pedido.values()),
            "vendedores": vendedores,
            "equipo": {
                "pedidos": sum(f["pedidos"] for f in vendedores),
                "estrellas": sum(f["estrellas"] for f in vendedores),
                "oro": sum(f["oro"] for f in vendedores),
                "xp": sum(f["xp"] for f in vendedores),
            },
        }
        resultado.update(gerente_utils.avance_mes(ventas, piso, meta))
        return resultado

    # ------------------------------------------------------------------
    # Salud de los datos y GPS prioritario
    # ------------------------------------------------------------------

    @staticmethod
    def _shalom_nombre_ciclo(ciclo):
        """'Ruta (26/10 - 30/10)' -- name_get de fsm.route.schedule ya no
        alimenta display_name en Odoo 18, así que se arma aquí."""
        rango = ""
        if ciclo.date_start and ciclo.date_end:
            rango = f" ({ciclo.date_start:%d/%m} - {ciclo.date_end:%d/%m})"
        return f"{ciclo.route_id.name}{rango}"

    @api.model
    def shalom_admin_salud_datos(self):
        """Tarjeta "Salud de los datos" y lista "GPS prioritario".

        - sin_gps: ubicaciones activas sin coordenadas (vacías o en 0).
        - gps_prioritario: los clientes BUENOS (A, A2, B, B2, que no son
          distribuidoras: los que de verdad se visitan y compran) sin
          GPS, de mayor a menor valor esperado, con nombre, ruta, clase y
          valor (hasta 300). La pantalla muestra los primeros
          `gps_n` (30) y la cobertura: qué % del valor que falta cubren.
        - buenos_sin_ruta: clientes buenos que no están en ninguna ruta,
          con el valor esperado que se pierde.
        - sin_tipo (sin etiquetas de contacto: súper, farmacia...) y
          sin_telefono (ni teléfono ni celular).
        - distribuidoras marcadas y cuánto pesan en las ventas históricas.
        - ciclos_sin_cartera: ciclos abiertos con visitas abiertas donde
          no se ha repartido cartera (es normal en rutas de un solo
          vendedor; es informativo).

        Una sola pasada (ver _shalom_gerente_universo): sin consultas por
        cliente."""
        self._shalom_gerente_exigir()
        filas, perfiles = self._shalom_gerente_universo()
        nombre_ruta = {r.id: r.name for r in self.sudo().search([])}
        total = len(filas)
        sin_gps = sin_tipo = sin_telefono = 0
        buenos = buenos_con_gps = 0
        buenos_sin_ruta = []
        prioritarios = []
        dist = {"cantidad": 0, "ventas": 0.0, "sin_gps": 0}
        ventas_total = 0.0
        for fila in filas:
            perfil = perfiles.get(fila["id"]) or {}
            ventas = (perfil.get("n") or 0) * (perfil.get("ticket_promedio") or 0.0)
            ventas_total += ventas
            falta_gps = not fila["partner_latitude"] or not fila["partner_longitude"]
            sin_gps += 1 if falta_gps else 0
            sin_tipo += 0 if fila["category_id"] else 1
            sin_telefono += 0 if (fila["phone"] or fila["mobile"]) else 1
            if fila["x_es_distribuidora"]:
                dist["cantidad"] += 1
                dist["ventas"] += ventas
                dist["sin_gps"] += 1 if falta_gps else 0
                continue
            if not gerente_utils.es_cliente_bueno(perfil.get("clase")):
                continue
            buenos += 1
            ruta_id = fila["fsm_route_id"]
            if not ruta_id:
                buenos_sin_ruta.append(perfil["esperado"])
            if falta_gps:
                prioritarios.append({
                    "id": fila["id"],
                    "name": fila["name"],
                    "ruta_id": ruta_id or False,
                    "ruta": nombre_ruta.get(ruta_id, "") if ruta_id else "",
                    "clase": perfil["clase"],
                    "valor": perfil["esperado"],
                    "sin_ruta": not ruta_id,
                })
            else:
                buenos_con_gps += 1
        valor_falta = sum(p["valor"] for p in prioritarios)
        gps_n = gerente_utils.N_GPS_PRIORITARIO

        # Ciclos abiertos: ¿tienen cartera repartida?
        Visita = self.env["fsm.order"].sudo()
        abiertas = Visita._read_group(
            [("x_route_schedule_id", "!=", False), ("stage_id.is_closed", "=", False)],
            ["x_route_schedule_id"], ["__count"],
        )
        con_cartera = {
            ciclo.id for ciclo, _n in Visita._read_group(
                [("x_route_schedule_id", "!=", False), ("stage_id.is_closed", "=", False),
                 ("x_cartera_person_id", "!=", False)],
                ["x_route_schedule_id"], ["__count"],
            )
        }
        abiertos = [(c, n) for c, n in abiertas if not c.route_id.x_es_visita_express]
        sin_cartera = sorted(
            ((c, n) for c, n in abiertos if c.id not in con_cartera), key=lambda t: -t[1]
        )
        return {
            "total_ubicaciones": total,
            "sin_gps": sin_gps,
            "sin_tipo": sin_tipo,
            "sin_telefono": sin_telefono,
            "buenos": {
                "total": buenos,
                "con_gps": buenos_con_gps,
                "sin_gps": len(prioritarios),
                "valor_sin_gps": round(valor_falta, 2),
            },
            "gps_n": gps_n,
            "gps_cobertura_pct": gerente_utils.cobertura_primeros(
                [p["valor"] for p in prioritarios], gps_n),
            "gps_prioritario": gerente_utils.ordenar_gps_prioritario(prioritarios),
            "buenos_sin_ruta": {
                "total": len(buenos_sin_ruta),
                "valor": round(sum(buenos_sin_ruta), 2),
            },
            "distribuidoras": {
                "cantidad": dist["cantidad"],
                "sin_gps": dist["sin_gps"],
                "ventas": round(dist["ventas"], 2),
                "pct_ventas": round(dist["ventas"] * 100.0 / ventas_total, 1) if ventas_total else 0.0,
            },
            "ciclos_sin_cartera": {
                "abiertos": len(abiertos),
                "sin_cartera": len(sin_cartera),
                "lista": [
                    {"id": c.id, "name": self._shalom_nombre_ciclo(c), "visitas": n}
                    for c, n in sin_cartera[:15]
                ],
            },
        }

    @api.model
    def _shalom_gerente_metas(self):
        """(piso, meta) del mes de ir.config_parameter."""
        param = self.env["ir.config_parameter"].sudo()
        return (
            gerente_utils.parametro_numero(
                param.get_param("shalom.juego.piso_mes"), gerente_utils.PISO_MES_DEFECTO),
            gerente_utils.parametro_numero(
                param.get_param("shalom.juego.meta_mes"), gerente_utils.META_MES_DEFECTO),
        )
