# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
fsm.route.schedule: una "ocurrencia" de una fsm.route para un ciclo
concreto (no siempre una semana: cada ruta tiene su propia duración
típica -- puede ser 1 día, 3 días, una semana...). La fsm.route en sí
sigue siendo solo la lista ordenada de clientes (no cambia); este
modelo nuevo es lo que permite decir "la Ruta Zona Este se recorre del
1 al 5 de septiembre", que es lo que la pestaña "Rutas" de la app del
vendedor necesita mostrar agrupado/filtrado por ciclo o mes.

date_end es 100% editable a mano (antes era un compute fijo a
date_start + 6 días) -- solo se SUGIERE con x_duracion_dias de la ruta
(ver fsm_route.py) cuando se completa date_start con date_end todavía
vacío (ver _onchange_date_start_sugerir_fin), sin pisar nunca un valor
ya cargado. Esa sugerencia es SOLO para la primera vez que se arma una
programación de una ruta que nunca tuvo un ciclo anterior; "Generar
próximo ciclo" (ver más abajo) no la usa -- copia la duración real del
ciclo que se está cerrando.

Un mismo vendedor puede recorrer la misma ruta muchas veces al año
(ej. mensual): "Generar próximo ciclo" (ver action_generar_proximo_
ciclo) crea la fsm.route.schedule del ciclo siguiente para la misma
ruta en un solo paso:
  - date_start del ciclo nuevo = la fecha REAL en que se aprieta el
    botón (hoy), nunca calculada desde cuándo terminó el ciclo
    anterior -- si oficina se atrasa en regenerar, no queremos fechas
    ya pasadas.
  - date_end del ciclo nuevo = esa fecha + la misma cantidad de días
    que duró el ciclo anterior de esa ruta (date_end - date_start del
    que se cierra), para no tener que volver a escribir la duración a
    mano cada vez.
  - La generación de visitas en sí (quién recibe visita nueva, quién
    queda "No atendido") la resuelve por completo
    action_generar_visitas_ruta() en fsm_route.py -- este método no
    duplica esa lógica, solo arma la fecha y delega.

x_tiempo_estimado ya NO es un valor que carga oficina a mano: se
calcula solo, a partir del historial real de cambios de etapa de las
visitas (ver _compute_tiempo_estimado), como las horas transcurridas
entre que se cerró el primer cliente del ciclo y que se cerró el
último. La capacidad esperada de venta y el estado de avance también
se calculan solos.
"""
import logging
from datetime import timedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Mismo criterio que fsm_order.py: "venta real" = confirmada, no
# borrador ni cancelada.
ESTADOS_VENTA_CONFIRMADA = ("sale", "done")

# Cuántas ventas confirmadas recientes de cada cliente se promedian
# para "capacidad" (ver _compute_capacidad). Antes se usaba solo la
# ÚLTIMA venta -- se reportó que eso distorsiona el número para un
# cliente irregular: puede comprar $3k normalmente y que la última
# venta puntual haya sido de $100 (o al revés, una compra excepcional
# que no es representativa). Promediar las últimas 3 (o las que tenga,
# si son menos) amortigua eso sin depender de una ventana de fechas
# fija -- útil porque el ritmo de compra de cada cliente es distinto
# (uno compra cada 2 semanas, otro cada 2 meses).
TOPE_VENTAS_PROMEDIO_CAPACIDAD = 3

# Días hábiles de BODEGA (lunes a viernes -- bodega no despacha
# sábado ni domingo, a diferencia del recorrido de venta que sí es
# lunes a sábado) que tarda un pedido en llegarle al cliente desde
# que se toma en la visita. Fijo para toda la operación, no varía por
# ruta. Usado por _shalom_reponer_rutas_vencidas para no contar la
# periodicidad del ciclo desde que se TOMA el pedido, sino desde que
# el cliente lo TIENE en mano.
SHALOM_DIAS_ENTREGA_HABILES_BODEGA = 4


class FSMRouteSchedule(models.Model):
    _name = "fsm.route.schedule"
    _description = "Programación de Ruta (ciclo)"
    _order = "date_start desc, route_id"

    route_id = fields.Many2one(
        "fsm.route",
        string="Ruta",
        required=True,
        ondelete="cascade",
    )
    date_start = fields.Date(
        string="Inicio del ciclo",
        required=True,
        help="Primer día en que se recorre esta ruta en este ciclo.",
    )
    date_end = fields.Date(
        string="Fin del ciclo",
        required=True,
        help="Último día en que se recorre esta ruta en este ciclo. "
        "Editable siempre a mano -- no todas las rutas duran una "
        "semana. Se sugiere solo (a partir de la Duración típica del "
        "ciclo configurada en la ruta) la primera vez que se completa "
        "Inicio del ciclo con este campo todavía vacío.",
    )
    x_tiempo_estimado = fields.Float(
        string="Tiempo real (horas)",
        compute="_compute_tiempo_estimado",
        store=True,
        help="Horas reales transcurridas entre el momento en que se "
        "cerró el primer cliente de este ciclo (Completado/No quiso/"
        "Cancelado/No atendido) y el momento en que se cerró el "
        "último. Se calcula solo, a partir del historial real de "
        "cambios de etapa de cada visita (ver stage_id en "
        "fsm_order.py, con tracking habilitado, y "
        "_shalom_fecha_primer_cierre) -- ya no es un valor que carga "
        "oficina a mano. Si hay menos de 2 cierres con historial "
        "registrado, queda en 0.",
    )
    capacidad = fields.Monetary(
        string="Capacidad de la ruta",
        compute="_compute_capacidad",
        currency_field="currency_id",
        help="Suma, por cada cliente de la ruta, del PROMEDIO de sus "
        "últimas %(tope)s ventas CONFIRMADAS (no borrador; menos de "
        "%(tope)s si no tiene tantas): una estimación de cuánto puede "
        "vender el vendedor si visita a todos, basada en el "
        "comportamiento reciente típico de cada cliente en vez de una "
        "sola venta puntual que puede no ser representativa. Se "
        "recalcula al leerse, no queda guardada en la base." % {
            "tope": TOPE_VENTAS_PROMEDIO_CAPACIDAD
        },
    )
    currency_id = fields.Many2one(
        "res.currency",
        default=lambda self: self.env.company.currency_id,
    )
    estado = fields.Selection(
        [
            ("por_iniciar", "Por iniciar"),
            ("en_curso", "En curso"),
            ("completada", "Completada"),
        ],
        string="Estado",
        compute="_compute_estado",
        store=True,
        help="Por iniciar: ninguna visita generada tiene todavía una "
        "etapa cerrada. En curso: alguna sí y otras no. Completada: "
        "todas las visitas generadas para esta ocurrencia ya están "
        "cerradas (Completada, No quiso, Cancelado o No atendido). "
        "Queda guardado (store=True) para poder filtrar por él desde "
        "shalom_mis_rutas_programadas en fsm_person.py.",
    )
    x_reposicion_incompleta = fields.Boolean(
        string="Repuesta sin completar",
        default=False,
        readonly=True,
        help="Se marca sola cuando el cron de reposición automática "
        "(_shalom_reponer_rutas_vencidas) generó el ciclo SIGUIENTE a "
        "este mientras este todavía no estaba 'completada' -- señal "
        "para Administración de que el vendedor pudo dejar clientes "
        "sin atender; el sistema no bloqueó ni esperó, el ciclo "
        "siguiente se generó igual en su fecha exacta.",
    )
    x_visitas_pendientes_al_reponer = fields.Integer(
        string="Visitas sin cerrar al reponer",
        default=0,
        readonly=True,
        help="Cuántas fsm.order de este ciclo seguían sin cerrar en "
        "el momento exacto en que se generó el ciclo siguiente. Queda "
        "fijo aunque esas visitas se cierren o archiven después.",
    )
    fsm_order_ids = fields.One2many(
        "fsm.order",
        "x_route_schedule_id",
        string="Visitas generadas",
    )
    cantidad_clientes = fields.Integer(
        string="Clientes",
        compute="_compute_cantidad_clientes",
        help="Cantidad de Ubicaciones de Servicio de la ruta (no de "
        "visitas ya generadas).",
    )
    fsm_person_id = fields.Many2one(
        related="route_id.fsm_person_id",
        string="Vendedor",
        store=True,
    )
    company_id = fields.Many2one(
        "res.company", default=lambda self: self.env.company
    )
    active = fields.Boolean(default=True)

    @api.onchange("date_start", "route_id")
    def _onchange_date_start_sugerir_fin(self):
        """Sugiere date_end a partir de la Duración típica del ciclo
        (días) de la ruta -- SOLO si date_end todavía está vacío, para
        no pisar nunca un valor ya cargado a mano (ej. al editar una
        programación existente, o si oficina ya escribió su propia
        fecha de fin antes de terminar de completar date_start). Solo
        aplica para armar una programación nueva a mano, sin ciclo
        anterior del cual copiar duración -- "Generar próximo ciclo"
        no pasa por acá."""
        for rec in self:
            if rec.date_start and rec.route_id and not rec.date_end:
                dias = rec.route_id.x_duracion_dias or 7
                rec.date_end = rec.date_start + timedelta(days=max(dias - 1, 0))

    @api.depends("fsm_order_ids.stage_id.is_closed")
    def _compute_estado(self):
        for rec in self:
            orders = rec.fsm_order_ids
            if not orders:
                rec.estado = "por_iniciar"
                continue
            cerradas = orders.filtered(lambda o: o.stage_id.is_closed)
            if not cerradas:
                rec.estado = "por_iniciar"
            elif len(cerradas) == len(orders):
                rec.estado = "completada"
            else:
                rec.estado = "en_curso"

    @api.depends("fsm_order_ids.stage_id")
    def _compute_tiempo_estimado(self):
        for rec in self:
            cerradas = rec.fsm_order_ids.filtered(lambda o: o.stage_id.is_closed)
            fechas = [
                fecha
                for fecha in (o._shalom_fecha_primer_cierre() for o in cerradas)
                if fecha
            ]
            if len(fechas) >= 2:
                delta = max(fechas) - min(fechas)
                rec.x_tiempo_estimado = delta.total_seconds() / 3600.0
            else:
                rec.x_tiempo_estimado = 0.0

    @api.depends("route_id")
    def _compute_cantidad_clientes(self):
        for rec in self:
            rec.cantidad_clientes = self.env["fsm.location"].search_count(
                [("fsm_route_id", "=", rec.route_id.id)]
            )

    @api.depends("route_id")
    def _compute_capacidad(self):
        for rec in self:
            locations = self.env["fsm.location"].search(
                [("fsm_route_id", "=", rec.route_id.id)]
            )
            total = 0.0
            for location in locations:
                partner = location.partner_id
                if not partner:
                    continue
                # Últimas TOPE_VENTAS_PROMEDIO_CAPACIDAD ventas
                # confirmadas (o menos, si el cliente no tiene tantas)
                # -- promedio en vez de solo la última, ver el
                # comentario grande de la constante más arriba.
                recientes = self.env["sale.order"].search(
                    [
                        ("partner_id", "=", partner.id),
                        ("state", "in", list(ESTADOS_VENTA_CONFIRMADA)),
                    ],
                    order="date_order desc",
                    limit=TOPE_VENTAS_PROMEDIO_CAPACIDAD,
                )
                if recientes:
                    total += sum(recientes.mapped("amount_total")) / len(recientes)
            rec.capacidad = total

    def action_abrir_agregar_visita_wizard(self):
        """Botón 'Agregar cliente a esta ocurrencia': abre el wizard
        chiquito (shalom.agregar.visita.wizard) para sumar UN cliente
        puntual sin volver a generar toda la ocurrencia -- caso típico:
        un cliente se agregó a la ruta después de generar el ciclo, o
        hay que sumarlo a mitad de camino, sin resetear a "No
        atendido" a los que ya se visitaron o a los que todavía
        quedan pendientes de este ciclo."""
        self.ensure_one()
        return {
            "type": "ir.actions.act_window",
            "res_model": "shalom.agregar.visita.wizard",
            "view_mode": "form",
            "views": [[False, "form"]],
            "target": "new",
            "context": {"default_schedule_id": self.id},
        }

    def action_agregar_visita(self, location_id):
        """Crea UNA fsm.order para `location_id`, vinculada a esta
        ocurrencia, sin tocar ninguna otra visita -- llamado desde el
        wizard (ver action_abrir_agregar_visita_wizard()). Reusa
        _shalom_crear_visita_para_location() de fsm.route (mismo
        criterio que el generado masivo: si el cliente ya tenía una
        visita vieja abierta, se cierra sola como 'No atendido').

        Bloquea el caso obvio de duplicado -- este cliente ya con una
        visita ABIERTA dentro de ESTA MISMA ocurrencia -- para no
        generar dos visitas activas del mismo cliente en el mismo
        ciclo por un click de más; no bloquea si la visita existente
        ya está cerrada (ese caso son visitas legítimas repetidas,
        p.ej. una segunda pasada al mismo cliente en el ciclo)."""
        self.ensure_one()
        location = self.env["fsm.location"].browse(location_id)
        if not location.exists():
            raise UserError(_("No se encontró esa Ubicación de Servicio."))
        if location.fsm_route_id.id != self.route_id.id:
            raise UserError(
                _("'%(cliente)s' no pertenece a la ruta '%(ruta)s' de esta "
                  "ocurrencia.",
                  cliente=location.name, ruta=self.route_id.name)
            )
        ya_abierta = self.fsm_order_ids.filtered(
            lambda o: o.location_id.id == location.id and not o.stage_id.is_closed
        )
        if ya_abierta:
            raise UserError(
                _("'%(cliente)s' ya tiene una visita abierta en esta "
                  "ocurrencia.", cliente=location.name)
            )

        stage_nueva, stage_no_atendido = (
            self.route_id._shalom_etapas_generar_visitas()
        )
        orden, _cerradas = self.route_id._shalom_crear_visita_para_location(
            location,
            stage_nueva,
            stage_no_atendido,
            schedule=self,
            sequence=len(self.fsm_order_ids) + 1,
        )
        _logger.info(
            "Visita agregada a mano a fsm.route.schedule id=%s: "
            "fsm.order id=%s para '%s'.",
            self.id, orden.id, location.name,
        )
        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Visita agregada"),
                "message": _(
                    "Se generó la visita de '%(cliente)s' en esta "
                    "ocurrencia, sin tocar las demás.",
                    cliente=location.name,
                ),
                "sticky": False,
                "type": "success",
            },
        }

    def action_generar_visitas(self):
        """Botón: igual que 'Generar visitas de esta ruta' en fsm.route,
        pero taggeando cada fsm.order creada con esta ocurrencia
        (x_route_schedule_id) y con las fechas del ciclo, para que la
        app del vendedor sepa qué visitas corresponden a qué ciclo."""
        self.ensure_one()
        return self.route_id.action_generar_visitas_ruta(schedule=self)

    def _shalom_crear_ciclo_siguiente(self, date_start_nuevo=None):
        """Núcleo compartido entre 'Generar próximo ciclo' (botón
        manual, ver action_generar_proximo_ciclo) y el cron de
        reposición automática (ver _shalom_reponer_rutas_vencidas más
        abajo). Arma la fsm.route.schedule del ciclo siguiente a self
        y le genera las visitas:
          - date_end = date_start_nuevo + la misma cantidad de días
            que duró ESTE ciclo (date_end - date_start de la
            programación que se está cerrando), para heredar la
            duración real sin volver a escribirla a mano.
          - Si date_start_nuevo es None (botón manual), se usa HOY
            (fields.Date.context_today) -- si oficina se atrasa en
            regenerar, no queremos que arranque con fechas ya
            pasadas. Si se pasa un valor (cron), se usa tal cual,
            DETERMINÍSTICO -- el cron necesita que la grilla de
            fechas de cada ruta no se corra según cuándo corrió el
            cron ese día.
        Toda la lógica de "quién recibe visita nueva, quién queda No
        atendido" vive en action_generar_visitas_ruta() (fsm_route.py),
        no acá -- ese método ya garantiza que se genera SIEMPRE para
        todos los clientes de la ruta, cerrando solo lo que haya
        quedado colgado.

        Devuelve la fsm.route.schedule nueva, ya con las visitas
        generadas."""
        self.ensure_one()

        if not self.date_start or not self.date_end:
            raise UserError(
                _("Esta programación no tiene fecha de inicio y fin "
                  "cargadas. Completalas antes de generar el ciclo "
                  "siguiente.")
            )

        duracion_dias = (self.date_end - self.date_start).days
        if date_start_nuevo is None:
            date_start_nuevo = fields.Date.context_today(self)
        date_end_nuevo = date_start_nuevo + timedelta(days=duracion_dias)

        nueva = self.create({
            "route_id": self.route_id.id,
            "date_start": date_start_nuevo,
            "date_end": date_end_nuevo,
        })
        nueva.action_generar_visitas()
        return nueva

    def action_generar_proximo_ciclo(self):
        """Botón: arranca el ciclo siguiente de esta misma ruta en un
        solo paso, para no tener que reprogramar cada ruta a mano cada
        vez que se repite (ej. mensual). Delega el armado a
        _shalom_crear_ciclo_siguiente() (sin fecha fija, o sea "hoy")
        y solo arma el mensaje de notificación."""
        self.ensure_one()
        nueva = self._shalom_crear_ciclo_siguiente()

        mensaje = _(
            "Ciclo siguiente de '%(ruta)s' generado (%(inicio)s - "
            "%(fin)s).",
            ruta=self.route_id.name,
            inicio=nueva.date_start.strftime("%d/%m"),
            fin=nueva.date_end.strftime("%d/%m"),
        )
        _logger.info(mensaje)

        return {
            "type": "ir.actions.client",
            "tag": "display_notification",
            "params": {
                "title": _("Próximo ciclo generado"),
                "message": mensaje,
                "sticky": False,
                "type": "success",
            },
        }

    @api.model
    def _shalom_sumar_dias_habiles_bodega(self, fecha, dias_habiles):
        """Suma `dias_habiles` días hábiles de BODEGA (lunes a
        viernes -- no lunes a sábado como el recorrido de venta) a
        `fecha`, saltando sábado y domingo. Usado por
        _shalom_reponer_rutas_vencidas para calcular cuándo le llega
        la mercadería al cliente después de tomarle el pedido."""
        actual = fecha
        restantes = dias_habiles
        while restantes > 0:
            actual += timedelta(days=1)
            if actual.weekday() < 5:  # 0=lunes ... 4=viernes
                restantes -= 1
        return actual

    @api.model
    def _shalom_reponer_rutas_vencidas(self):
        """Cron diario (ver data/reponer_rutas_cron.xml). Recorre las
        fsm.route activas que NO son Visita Exprés
        (x_es_visita_express=False) y con periodicidad configurada
        (x_periodicidad_dias > 0); para cada una mira su última
        fsm.route.schedule (por date_start desc).

        El vencimiento NO se cuenta desde date_start directo: primero
        se calcula cuándo le llega la mercadería al cliente
        (date_start + SHALOM_DIAS_ENTREGA_HABILES_BODEGA días hábiles
        de bodega) y RECIÉN sobre esa fecha de llegada se suma
        route.x_periodicidad_dias (calendario) -- el "mes" de
        periodicidad se cuenta desde que el cliente TIENE la
        mercadería en mano, no desde que se le tomó el pedido.

        Si hoy >= ese vencimiento, genera el ciclo siguiente con
        date_start DETERMINÍSTICO (el vencimiento calculado, nunca
        "hoy") -- exacto, sin margen extra, se haya completado o no
        el ciclo anterior. Si no se había completado, deja constancia
        (x_reposicion_incompleta / x_visitas_pendientes_al_reponer)
        para que Administración lo revise en Seguimiento de Visitas:
        nunca bloquea ni espera, el ciclo nuevo se genera siempre."""
        hoy = fields.Date.context_today(self)
        rutas = self.env["fsm.route"].search([
            ("x_es_visita_express", "=", False),
            ("x_periodicidad_dias", ">", 0),
        ])
        generados = 0
        for route in rutas:
            ultima = self.search(
                [("route_id", "=", route.id)],
                order="date_start desc",
                limit=1,
            )
            if not ultima or not ultima.date_start:
                continue

            fecha_llegada = self._shalom_sumar_dias_habiles_bodega(
                ultima.date_start, SHALOM_DIAS_ENTREGA_HABILES_BODEGA
            )
            vence = fecha_llegada + timedelta(days=route.x_periodicidad_dias)
            if hoy < vence:
                continue

            # No duplicar si el cron corre más de una vez el mismo
            # día o hay reintentos.
            if self.search_count([
                ("route_id", "=", route.id),
                ("date_start", ">=", vence),
            ]):
                continue

            if ultima.estado != "completada":
                pendientes = len(
                    ultima.fsm_order_ids.filtered(
                        lambda o: not o.stage_id.is_closed
                    )
                )
                ultima.write({
                    "x_reposicion_incompleta": True,
                    "x_visitas_pendientes_al_reponer": pendientes,
                })
                _logger.warning(
                    "Reposición automática fsm.route id=%s ('%s'): "
                    "el ciclo anterior (schedule id=%s) no estaba "
                    "completado (%s visita(s) sin cerrar). Se generó "
                    "igual el ciclo siguiente.",
                    route.id, route.name, ultima.id, pendientes,
                )

            ultima._shalom_crear_ciclo_siguiente(date_start_nuevo=vence)
            generados += 1

        _logger.info(
            "Reposición automática de rutas: %s ciclo(s) generado(s).",
            generados,
        )

    def name_get(self):
        result = []
        for rec in self:
            rango = ""
            if rec.date_start and rec.date_end:
                rango = f" ({rec.date_start.strftime('%d/%m')} - {rec.date_end.strftime('%d/%m')})"
            result.append((rec.id, f"{rec.route_id.name}{rango}"))
        return result
