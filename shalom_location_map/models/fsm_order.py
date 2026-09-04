# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Extiende fsm.order (la tarea/orden de visita a un cliente) con:

1. Captura de GPS real del dispositivo del vendedor (botón separado del
   de "marcar como completada", con confirmación explícita, para evitar
   que se sobreescriba la ubicación real de un cliente por accidente).

2. "Jornada" (x_jornada): número de día de trabajo dentro de la ruta
   (jornada 1, jornada 2, ...), NO atado a un día calendario fijo.
   Se calcula automáticamente comparando cuándo se completó la última
   tarea de la MISMA ruta: si pasaron más de 6 horas, se asume que
   empezó una jornada nueva. La primera tarea completada de toda la
   ruta siempre arranca en jornada 1. También editable a mano.

3. Botón "Crear cotización": genera una sale.order nueva vinculada al
   cliente de esta visita (y a la propia fsm.order via sale_id), y abre
   esa cotización para cargar los productos ahí mismo. Se agrega porque
   el flujo nativo de fieldservice_sale asume el orden inverso (primero
   se vende, la venta genera la visita) -- acá se necesita lo opuesto:
   visitar primero, y solo si el cliente compra, generar la venta desde
   la misma visita.

4. Botón "Ir con Waze": abre Waze (en pestaña/app nueva) con la ruta
   hacia las coordenadas guardadas del cliente. No se construye un
   mapa propio dentro de Odoo -- se apoya en la app externa que la
   gente ya conoce y usa a diario (antes era Google Maps; cambiado por
   decisión explícita del usuario).

5. Historial de cotizaciones del cliente: contador + botón que abre
   todas las sale.order CONFIRMADAS (state in sale/done) del cliente
   de esta visita, más un gráfico embebido (widget Owl + Chart.js) de
   línea de tiempo con los productos más comprados y los olvidados.

6. Mini-mapa embebido con trazado dinámico: al abrir la tarjeta, pide
   el GPS del navegador automáticamente (sin botón, sin confirmación,
   ya que solo lee la posición y no escribe nada) y dibuja en vivo la
   ruta (Mapbox Directions + Mapbox GL JS) desde ahí hasta el cliente
   de esta visita. Si el navegador no tiene el permiso de ubicación
   concedido, no lo solicita de forma insistente: muestra un aviso.

7. x_route_schedule_id: vincula la visita a la ocurrencia semanal
   (fsm.route.schedule) que la generó, cuando corresponde.

8. shalom_confirmar_pedido(): llamado desde la app del vendedor con el
   carrito ya armado -- crea/reusa la cotización, carga sus líneas, la
   CONFIRMA (venta real, reserva stock) y cierra la visita, todo en una
   sola llamada. Es el equivalente "todo en uno" de action_crear_cotizacion
   pensado para el flujo de catálogo + carrito de la app.

9. shalom_estado_promociones_carrito(): calcula, para el carrito TODAVÍA
   en memoria de la app (antes de que exista ninguna sale.order.line
   real), el mismo estado de promociones "comprar X llevar Y" que ya
   muestra el módulo de Ventas (stock_picking_sale_buttons,
   sale.order.line.custom_promo_status) -- para que el vendedor lo vea
   mientras arma el pedido, no recién después de confirmarlo. Reimplementa
   el mismo criterio (no importa ese módulo, que es ajeno a este
   proyecto) contra loyalty.program/loyalty.rule directo.

10. stage_id con tracking=True + _shalom_fecha_primer_cierre(): agrega
    historial (mail.tracking.value) sobre los cambios de etapa, para
    poder leer el momento EXACTO en que una visita se cerró por primera
    vez. Lo usa fsm.route.schedule._compute_tiempo_estimado() para
    calcular solo (sin que oficina lo cargue a mano) las horas reales
    que tomó el ciclo: desde que se cerró el primer cliente hasta que
    se cerró el último.

Nota: "Orden de Ruta" (x_cliente_orden_ruta) es un campo related con
store=True hacia fsm.location.x_orden_ruta -- es literalmente el mismo
dato en ambos lados: editar el valor desde la tarjeta de visita o desde
la ficha del cliente actualiza el mismo registro subyacente.

El cálculo automático de Jornada SOLO se dispara cuando:
  - La escritura mueve el stage_id hacia una etapa cerrada de tipo
    "completado" (is_closed=True y no es la etapa de Cancelado), Y
  - El usuario no proporcionó ya un valor manual para x_jornada en
    la misma escritura (así se respeta la edición manual sin pisarla).

Corrección: la etapa de Cancelado se identifica por su xml_id
(fieldservice.fsm_stage_cancelled) en vez de por su nombre visible.
Antes se comparaba contra el string "Cancelled" (inglés), pero el
nombre real de la etapa en producción es "Cancelado" (español) -- esa
comparación nunca coincidía, así que una visita cancelada estaba
contando como completada para el correlativo de Jornada. Bug
preexistente, corregido junto con esta tanda de cambios.
"""
import json
import logging
from datetime import timedelta

from dateutil.relativedelta import relativedelta

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, UserError
from odoo.osv import expression

_logger = logging.getLogger(__name__)

# Umbral de inactividad para considerar que empezó una nueva jornada.
HORAS_INACTIVIDAD_NUEVA_JORNADA = 6

# Segundos sin un guardado nuevo de x_carrito_borrador para considerar
# que ya nadie tiene el catálogo abierto en esta visita ("Ver en
# vivo" deja de mostrarse). Ver shalom_leer_carrito().
# Antes se medía sobre x_carrito_actualizado (solo se movía al agregar/
# sacar un producto) -- ahora sobre x_catalogo_heartbeat, que se
# refresca cada ~1 seg tenga o no cambios de carrito, así que este
# umbral puede ser bien chico (el heartbeat nunca debería atrasarse
# más de 1-2 seg salvo problema real de red).
SHALOM_SEGUNDOS_CARRITO_ACTIVO = 3

# Días de antigüedad (desde el último guardado) para que la limpieza
# mensual borre un carrito abandonado. Ver shalom_limpiar_carritos_viejos().
SHALOM_DIAS_CARRITO_VIEJO = 30


# Estados de sale.order que cuentan como "venta real" para el
# historial de cotizaciones (se excluyen borradores/cancelados).
ESTADOS_VENTA_CONFIRMADA = ("sale", "done")

# Umbral de inactividad para considerar que un producto "se dejó de
# comprar".
MESES_SIN_COMPRA_PARA_ALERTA = 3

# Cantidad de productos a mostrar en el gráfico de línea de tiempo.
TOP_PRODUCTOS_GRAFICO_CANTIDAD = 6

# Mismo umbral que stock_picking_sale_buttons: los "TINTE NNP" tienen
# un precio mínimo especial para calificar a la promo.
PRECIO_MINIMO_TINTE_NNP = 1.16


class FSMOrder(models.Model):
    _inherit = "fsm.order"

    active = fields.Boolean(
        default=True,
        help="Las visitas archivadas (active=False) salen de las vistas "
        "y kanban por defecto, pero el historial sigue disponible "
        "activando el filtro de archivados. Se usa desde el botón "
        "'Archivar visitas cerradas' de la Ruta, para poder generar el "
        "ciclo de visitas del mes siguiente sin perder el historial.",
    )
    x_cliente_orden_ruta = fields.Integer(
        string="Orden de Ruta",
        related="location_id.x_orden_ruta",
        readonly=False,
        store=True,
        help="Mismo dato que el 'Orden de Ruta' de la Ubicación del "
        "cliente (fsm.location.x_orden_ruta) -- editar acá o en la "
        "ficha del cliente actualiza el mismo valor en ambos lados.",
    )
    x_jornada = fields.Integer(
        string="Jornada",
        help="Número de día de trabajo dentro de la ruta (jornada 1, "
        "jornada 2, ...). No corresponde a un día calendario fijo: "
        "se calcula automáticamente según la inactividad respecto a "
        "la última visita completada de la misma ruta, pero se puede "
        "editar manualmente.",
    )
    x_gps_capturado_lat = fields.Float(
        string="GPS capturado - Latitud",
        digits=(16, 7),
        help="Latitud capturada por el dispositivo del vendedor al "
        "presionar el botón de captura de GPS, en el momento de la visita.",
    )
    x_gps_capturado_lng = fields.Float(
        string="GPS capturado - Longitud",
        digits=(16, 7),
        help="Longitud capturada por el dispositivo del vendedor al "
        "presionar el botón de captura de GPS, en el momento de la visita.",
    )
    x_gps_capturado_fecha = fields.Datetime(
        string="GPS capturado - Fecha/hora",
    )
    x_cliente_lat = fields.Float(
        string="GPS guardado en el cliente - Latitud",
        related="location_id.partner_latitude",
        readonly=True,
    )
    x_cliente_lng = fields.Float(
        string="GPS guardado en el cliente - Longitud",
        related="location_id.partner_longitude",
        readonly=True,
    )
    x_cantidad_cotizaciones = fields.Integer(
        string="Cotizaciones confirmadas",
        compute="_compute_x_cantidad_cotizaciones",
        help="Cantidad de cotizaciones CONFIRMADAS (ventas reales, no "
        "borradores) que tiene el cliente de esta visita en su "
        "historial completo.",
    )
    x_route_schedule_id = fields.Many2one(
        "fsm.route.schedule",
        string="Programación de Ruta",
        help="Ocurrencia semanal de la ruta (fsm.route.schedule) que "
        "generó esta visita, si se creó desde ahí. Vacío para visitas "
        "generadas directamente desde el botón nativo de la Ruta (sin "
        "pasar por una ocurrencia programada).",
    )
    x_observaciones_visita = fields.Text(
        string="Observaciones de esta visita",
        help="Notas cargadas por el vendedor durante la visita (ej: "
        "mejor horario, pedir que dejen la entrada libre). Campo "
        "propio de la app del vendedor, independiente de otros campos "
        "de notas nativos del pedido.",
    )
    x_carrito_borrador = fields.Text(
        string="Carrito (borrador, JSON)",
        help="Snapshot del carrito de esta visita, guardado desde el "
        "catálogo de la app del vendedor (order_screen.js) -- para que "
        "sobreviva si el dispositivo se apaga/rompe (se recupera desde "
        "cualquier otro dispositivo con el mismo usuario) y para el "
        "'Ver en vivo' (dos dispositivos viendo/editando el mismo "
        "carrito casi en tiempo real). Formato: {clave: {product_id, "
        "name, list_price, cantidad, es_recompensa, regla_id}}, una "
        "entrada por producto/recompensa. No se usa para nada más "
        "(no crea sale.order.line -- eso sigue pasando solo al "
        "confirmar/revisar el pedido).",
    )
    x_carrito_actualizado = fields.Datetime(
        string="Carrito actualizado",
        help="Cuándo se guardó por última vez x_carrito_borrador -- "
        "usado SOLO para decidir cuál snapshot es más nuevo (servidor "
        "vs localStorage del dispositivo) al reabrir el catálogo. El "
        "heartbeat de 'Ver en vivo' usa x_catalogo_heartbeat, NO este "
        "campo (ver su docstring).",
    )
    x_catalogo_heartbeat = fields.Datetime(
        string="Catálogo abierto (heartbeat)",
        help="Se refresca solo, cada ~1 seg, mientras CUALQUIER "
        "dispositivo tiene el catálogo de esta visita abierto -- tenga "
        "o no cambios de carrito en ese momento (a diferencia de "
        "x_carrito_actualizado, que solo se mueve cuando se agrega/"
        "saca un producto). Bug real reportado: con el heartbeat "
        "atado al carrito, si el vendedor solo estaba navegando el "
        "catálogo sin tocar nada, 'Ver en vivo' tardaba en aparecer "
        "(o no aparecía) del lado del que mira. Separado a propósito: "
        "shalom_leer_carrito() usa ESTE campo para decidir 'activo', "
        "y solo lo escribe shalom_marcar_catalogo_abierto() -- nunca "
        "una simple lectura (si no, un dispositivo que solo está "
        "MIRANDO 'Ver en vivo', sin el catálogo abierto, marcaría "
        "presencia por error).",
    )
    x_catalogo_sesiones = fields.Text(
        string="Sesiones de catálogo abiertas (JSON)",
        help="Quién tiene el catálogo de esta visita abierto ahora, "
        "para decidir cuál es la sesión 'principal' -- la que ve la "
        "confirmación de 'guardar o descartar' al salir, y la única "
        "que puede de verdad vaciar el carrito compartido (ver "
        "shalom_limpiar_carrito). Formato: {sesion_id: {desde: "
        "datetime ISO, heartbeat: datetime ISO}}. 'Principal' = la "
        "sesión con 'desde' más antiguo entre las que siguen con "
        "heartbeat reciente -- si esa sesión se cierra, el rol pasa "
        "sola a la siguiente más antigua, en cadena (pedido explícito: "
        "riesgo real de que un vendedor/cliente mirando en paralelo "
        "descarte por error un pedido de otro). sesion_id lo genera "
        "order_screen.js una vez por pestaña del navegador (no hay "
        "forma de identificar 'el dispositivo físico' desde el "
        "navegador -- pestaña es la aproximación más cercana).",
    )
    x_revisado_admin = fields.Boolean(
        string="Revisado por oficina",
        help="Marcado desde Administración → Seguimiento de Visitas, "
        "para no tener que releer la misma observación de una visita "
        "Cancelado/No quiso dos veces. No afecta ningún flujo del "
        "vendedor ni cambia el estado de la visita.",
    )
    # Solo se agrega tracking=True -- el resto de la definición del
    # campo (comodel, relación con fsm.stage, etc.) la hereda de
    # fieldservice. Esto hace que Odoo registre en el historial
    # (mail.tracking.value) el momento exacto de cada cambio de etapa,
    # que es lo que usa _shalom_fecha_primer_cierre() más abajo -- sin
    # esto, fsm.route.schedule.x_tiempo_estimado no tendría de dónde
    # sacar una fecha/hora real de cierre.
    stage_id = fields.Many2one(tracking=True)

    def _shalom_fecha_primer_cierre(self):
        """Devuelve el datetime exacto (leído del historial de
        seguimiento del campo etapa, mail.tracking.value) en que esta
        visita pasó por primera vez a una etapa cerrada, o False si
        nunca se cerró o no hay historial registrado (ej. visitas
        creadas antes de que este módulo tuviera tracking=True en
        stage_id). Usado por fsm.route.schedule._compute_tiempo_
        estimado() para calcular las horas reales que tomó el ciclo."""
        self.ensure_one()
        if not self.stage_id.is_closed:
            return False
        ids_cerradas = self.env["fsm.stage"].search(
            [("is_closed", "=", True)]
        ).ids
        seguimiento = self.env["mail.tracking.value"].sudo().search(
            [
                ("mail_message_id.model", "=", "fsm.order"),
                ("mail_message_id.res_id", "=", self.id),
                ("field_id.name", "=", "stage_id"),
            ],
            order="create_date asc, id asc",
        )
        for valor in seguimiento:
            if valor.new_value_integer in ids_cerradas:
                return valor.create_date
        return False

    @api.depends("location_id.partner_id")
    def _compute_x_cantidad_cotizaciones(self):
        for order in self:
            partner = order.location_id.partner_id
            if not partner:
                order.x_cantidad_cotizaciones = 0
                continue
            order.x_cantidad_cotizaciones = self.env["sale.order"].search_count(
                [
                    ("partner_id", "=", partner.id),
                    ("state", "in", ESTADOS_VENTA_CONFIRMADA),
                ]
            )

    def action_capturar_gps(self, latitude, longitude):
        """Llamado desde el botón/JS de captura de GPS. Guarda el punto
        capturado en la propia orden Y actualiza la fsm.location del
        cliente, ya que este botón se usa exactamente para corregir una
        ubicación que no era precisa. Requiere confirmación explícita
        del usuario, manejada del lado del cliente (JS) antes de llamar
        a este método.
        """
        self.ensure_one()
        self.write(
            {
                "x_gps_capturado_lat": latitude,
                "x_gps_capturado_lng": longitude,
                "x_gps_capturado_fecha": fields.Datetime.now(),
            }
        )
        if self.location_id:
            self.location_id.write(
                {
                    "partner_latitude": latitude,
                    "partner_longitude": longitude,
                }
            )
            _logger.info(
                "GPS capturado y aplicado a fsm.location id=%s desde "
                "fsm.order id=%s: lat=%s lng=%s",
                self.location_id.id,
                self.id,
                latitude,
                longitude,
            )
        return True

    def shalom_abrir_captura_gps(self):
        """Botón del formulario: dispara la acción cliente que pide
        confirmación y lee el GPS real del navegador antes de llamar a
        action_capturar_gps."""
        self.ensure_one()
        return {
            "type": "ir.actions.client",
            "tag": "shalom_capturar_gps",
            "params": {
                "order_id": self.id,
                "cliente_nombre": self.location_id.name or "",
            },
        }

    def action_crear_cotizacion(self):
        """Botón 'Crear cotización': genera una sale.order nueva para el
        cliente de esta visita, la vincula a la fsm.order (sale_id), y
        abre esa cotización para cargar los productos. Si ya existe una
        cotización vinculada, simplemente la abre en vez de crear otra.

        Para evitar duplicados si el botón se aprieta más de una vez
        (por ejemplo si el usuario navegó antes de refrescar la vista),
        se relee el sale_id directo de la base de datos justo antes de
        decidir, en vez de confiar en el valor que pueda tener cacheado
        el registro en memoria de esta llamada.
        """
        self.ensure_one()
        if not self.location_id or not self.location_id.partner_id:
            raise UserError(
                _("Esta visita no tiene un cliente (Ubicación sin "
                  "contacto asociado). No se puede crear una cotización.")
            )

        # Releer sale_id directo de la base, sin cache, para evitar una
        # condición de carrera si el botón se apretó dos veces seguidas
        # antes de que la vista se refrescara.
        self.env.cr.execute(
            "SELECT sale_id FROM fsm_order WHERE id = %s", (self.id,)
        )
        sale_id_en_bd = self.env.cr.fetchone()[0]

        if sale_id_en_bd:
            sale_order = self.env["sale.order"].browse(sale_id_en_bd)
        else:
            sale_order = self.env["sale.order"].create(
                {"partner_id": self.location_id.partner_id.id}
            )
            self.write({"sale_id": sale_order.id})
            self.message_post(
                body=_(
                    "Cotización %(numero)s creada desde esta visita.",
                    numero=sale_order.name,
                )
            )
            _logger.info(
                "Cotización sale.order id=%s (%s) creada y vinculada a "
                "fsm.order id=%s",
                sale_order.id,
                sale_order.name,
                self.id,
            )

        return {
            "type": "ir.actions.act_window",
            "res_model": "sale.order",
            "res_id": sale_order.id,
            "view_mode": "form",
            "target": "current",
        }

    def shalom_guardar_borrador_pedido(self, lineas):
        """Llamado desde el carrito de la app al tocar "Revisar
        cotización": crea o reutiliza la cotización vinculada a esta
        visita (mismo criterio anti-duplicado que shalom_confirmar_pedido)
        y reemplaza sus líneas por las del carrito recibido, SIN
        confirmarla -- se deja en borrador para que el vendedor la
        termine de ajustar (precios especiales, promociones,
        descuentos) directo en el formulario nativo de Ventas, que es
        donde ya existe esa funcionalidad y no tiene sentido duplicarla
        en el carrito de la app.

        A diferencia de shalom_confirmar_pedido, acá el pedido queda
        como cotización de verdad en el módulo de Ventas (no
        desaparece si el vendedor no confirma) -- por decisión de
        producto explícita: es el mecanismo para que el vendedor pueda
        pasar el resto del trabajo de precios al módulo nativo antes
        de confirmar.

        SÍ cierra la visita (misma etapa Completada que
        shalom_confirmar_pedido) aunque la cotización quede en
        borrador: haber armado la cotización ya es prueba suficiente de
        que se atendió al cliente -- concretarla a orden de venta queda
        como responsabilidad del vendedor más adelante, no bloquea el
        cierre de la visita.

        lineas: mismo formato que shalom_confirmar_pedido (lista de
        dicts {"product_id": int, "qty": float, "es_recompensa": bool,
        "regla_id": int|False} -- los dos últimos solo importan para
        las líneas de recompensa, ver _crear_lineas_pedido).

        Devuelve la acción de ventana para abrir esa cotización.
        """
        self.ensure_one()
        if not lineas:
            raise UserError(_("El pedido no tiene productos."))
        if not self.location_id or not self.location_id.partner_id:
            raise UserError(
                _("Esta visita no tiene un cliente asociado (Ubicación "
                  "sin contacto). No se puede crear una cotización.")
            )

        self.env.cr.execute(
            "SELECT sale_id FROM fsm_order WHERE id = %s", (self.id,)
        )
        sale_id_en_bd = self.env.cr.fetchone()[0]
        if sale_id_en_bd:
            sale_order = self.env["sale.order"].browse(sale_id_en_bd)
        else:
            sale_order = self.env["sale.order"].create(
                {"partner_id": self.location_id.partner_id.id}
            )
            self.write({"sale_id": sale_order.id})
            self.message_post(
                body=_(
                    "Cotización %(numero)s creada como borrador desde el "
                    "carrito de la app del vendedor.",
                    numero=sale_order.name,
                )
            )

        sale_order.order_line.unlink()
        self._crear_lineas_pedido(sale_order, lineas)

        self._cerrar_visita_completada()
        self._shalom_limpiar_carrito_borrador()

        return {
            "type": "ir.actions.act_window",
            "res_model": "sale.order",
            "res_id": sale_order.id,
            "view_mode": "form",
            "target": "current",
        }

    def _crear_lineas_pedido(self, sale_order, lineas):
        """Crea las sale.order.line del carrito -- compartido entre
        shalom_confirmar_pedido y shalom_guardar_borrador_pedido.

        Las líneas marcadas "es_recompensa" (producto gratis de una
        promo "comprar X llevar Y" ya completa, elegido con el botón
        Recompensa del carrito) NO se crean acá como sale.order.line
        a mano -- eso dejaba una línea en $0 sin ninguna marca de que
        fuera un regalo (ni is_reward_line, ni reward_id/coupon_id), así
        que el motor de lealtad de Odoo nunca se enteraba de que la
        promo ya había sido canjeada (se podía volver a reclamar la
        misma promo después desde el formulario nativo de Ventas, sin
        que nada lo bloqueara). En vez de eso, se junta la loyalty.rule
        de cada una y se reclama de verdad vía
        _shalom_reclamar_recompensas_nativas() -- mismo mecanismo que
        el botón "Recompensas" del formulario nativo."""
        reglas_a_reclamar = self.env["loyalty.rule"]
        for linea in lineas:
            if linea.get("es_recompensa"):
                if linea.get("regla_id"):
                    reglas_a_reclamar |= self.env["loyalty.rule"].browse(
                        linea["regla_id"]
                    )
                continue
            vals = {
                "order_id": sale_order.id,
                "product_id": linea["product_id"],
                "product_uom_qty": linea.get("qty") or 1,
            }
            self.env["sale.order.line"].create(vals)
        if reglas_a_reclamar:
            self._shalom_reclamar_recompensas_nativas(sale_order, reglas_a_reclamar)

    def _shalom_reclamar_recompensas_nativas(self, sale_order, reglas):
        """Reclama de verdad, contra el motor nativo de lealtad de Odoo
        (sale_loyalty), las promociones "comprar X llevar Y" elegidas
        con el botón Recompensa del carrito -- mismo mecanismo que usa
        el botón "Recompensas" del formulario nativo de Ventas
        (action_open_reward_wizard), pero llamado directo para no abrir
        ningún wizard ni depender de que sea la única promo reclamable
        del pedido.

        _update_programs_and_rewards() (antes de reclamar nada) hace que
        Odoo detecte el programa automático como aplicable a las líneas
        pagas ya creadas y le calcule los puntos/canjes reales -- por
        eso NO hace falta mandar una cantidad de regalo calculada en el
        carrito: _apply_program_reward() (vía _get_reward_values_product)
        calcula sola cuántas unidades gratis corresponden según los
        puntos que el pedido tiene en ESTE momento, que es la fuente de
        verdad (no lo que el carrito alcanzó a estimar en el celular).

        reglas: recordset de loyalty.rule (una por regla_id distinta
        que venía marcada es_recompensa en el carrito)."""
        sale_order._update_programs_and_rewards()
        for regla in reglas:
            programa = regla.program_id
            recompensa = programa.reward_ids.filtered(
                lambda r: r.reward_type == "product" and r.reward_product_id
            )[:1]
            if not recompensa:
                raise UserError(
                    _("El programa '%(programa)s' ya no tiene un producto "
                      "de regalo configurado -- no se pudo aplicar la "
                      "promoción. Revisalo desde Ventas antes de "
                      "confirmar el pedido.",
                      programa=programa.name)
                )
            coupon = sale_order.coupon_point_ids.filtered(
                lambda p: p.coupon_id.program_id == programa
            ).coupon_id[:1]
            if not coupon:
                raise UserError(
                    _("La promoción '%(programa)s' ya no está completa en "
                      "este pedido -- revisá las cantidades antes de "
                      "confirmar.",
                      programa=programa.name)
                )
            resultado = sale_order._apply_program_reward(recompensa, coupon)
            if resultado.get("error"):
                raise UserError(
                    _("No se pudo aplicar la promoción '%(programa)s': "
                      "%(error)s",
                      programa=programa.name, error=resultado["error"])
                )
        sale_order._update_programs_and_rewards()

    def shalom_confirmar_pedido(self, lineas):
        """Llamado desde la app del vendedor al tocar "Confirmar
        pedido": crea o reutiliza la cotización vinculada a esta visita
        (mismo criterio anti-duplicado que action_crear_cotizacion),
        reemplaza sus líneas por las del carrito recibido, la CONFIRMA
        (action_confirm -- pasa a venta real y reserva stock) y cierra
        la visita moviéndola a la etapa Completada. La factura se
        genera después, aparte, en oficina -- este método no toca
        facturación.

        lineas: lista de dicts {"product_id": int, "qty": float,
        "es_recompensa": bool, "regla_id": int|False}, uno por producto
        agregado al carrito -- los dos últimos solo importan para las
        líneas de recompensa, ver _crear_lineas_pedido.

        A diferencia de action_crear_cotizacion (que abre el formulario
        completo de sale.order para cargar productos ahí), acá los
        productos ya vienen elegidos del catálogo de la app: este
        método hace todo el trabajo (crear/reusar cotización, cargar
        líneas, confirmar, cerrar visita) en una sola llamada.
        """
        self.ensure_one()
        if not lineas:
            raise UserError(_("El pedido no tiene productos."))
        if not self.location_id or not self.location_id.partner_id:
            raise UserError(
                _("Esta visita no tiene un cliente asociado (Ubicación "
                  "sin contacto). No se puede confirmar el pedido.")
            )

        # Mismo patrón anti-duplicado que action_crear_cotizacion: leer
        # sale_id directo de la base antes de decidir si crear una
        # cotización nueva o reusar la existente.
        self.env.cr.execute(
            "SELECT sale_id FROM fsm_order WHERE id = %s", (self.id,)
        )
        sale_id_en_bd = self.env.cr.fetchone()[0]
        if sale_id_en_bd:
            sale_order = self.env["sale.order"].browse(sale_id_en_bd)
        else:
            sale_order = self.env["sale.order"].create(
                {"partner_id": self.location_id.partner_id.id}
            )
            self.write({"sale_id": sale_order.id})

        sale_order.order_line.unlink()
        self._crear_lineas_pedido(sale_order, lineas)
        sale_order.action_confirm()
        self._cerrar_visita_completada()
        self._shalom_limpiar_carrito_borrador()

        self.message_post(
            body=_(
                "Pedido confirmado desde la app del vendedor: cotización "
                "%(numero)s (%(total)s).",
                numero=sale_order.name,
                total=sale_order.amount_total,
            )
        )
        _logger.info(
            "Pedido confirmado desde app para fsm.order id=%s: "
            "sale.order id=%s (%s), total=%s",
            self.id, sale_order.id, sale_order.name, sale_order.amount_total,
        )

        return {
            "sale_order_id": sale_order.id,
            "sale_order_name": sale_order.name,
            "total": sale_order.amount_total,
        }

    @api.model
    def shalom_estado_promociones_carrito(self, lineas):
        """Calcula el estado de las promociones "comprar X llevar Y"
        (loyalty.program, program_type='buy_x_get_y') para el carrito
        TODAVÍA en memoria de la app -- mismo criterio que
        sale.order.line.custom_promo_status de stock_picking_sale_buttons,
        pero sin necesitar que existan sale.order.line reales (ese
        cálculo depende de order_id.order_line, y acá el carrito recién
        se va a confirmar). No importa ese módulo (es ajeno a este
        proyecto, ver CLAUDE.md) -- reimplementa la misma lógica contra
        loyalty.program/loyalty.rule directo.

        A diferencia del original, acá SIEMPRE se usa el list_price del
        producto para el chequeo de precio mínimo (el carrito de la app
        no deja tocar precios) -- el criterio de "TINTE NNP" se
        preserva por si algún día ese producto tuviera un list_price
        más bajo que el mínimo.

        lineas: mismo formato que shalom_confirmar_pedido (lista de
        dicts {"product_id": int, "qty": float}).

        Devuelve {"mensajes": {product_id: "✅ Tienes 2 promos completas
        · Llevas 8 unidades válidas" / "⏳ Faltan 2 unidades · Llevas 6
        unidades válidas"}, "recompensas": [{"regla_id",
        "programa_nombre", "reward_product_id", "reward_product_name",
        "reward_qty", "disponibles"} ...]} -- "recompensas" solo incluye
        reglas con al menos 1 promo completa y una recompensa de tipo
        producto (reward_type='product'); "disponibles" es cuántas
        veces se completó la promo (el frontend descuenta las que el
        vendedor ya reclamó en esta sesión, ver order_screen.js)."""
        vacio = {"mensajes": {}, "recompensas": []}
        if not lineas:
            return vacio
        programas = self.env["loyalty.program"].search(
            [("program_type", "=", "buy_x_get_y"), ("active", "=", True)]
        )
        if not programas:
            return vacio

        def categoria_matchea(categ, categ_regla):
            while categ:
                if categ == categ_regla:
                    return True
                categ = categ.parent_id
            return False

        def regla_para_producto(producto):
            for programa in programas:
                for regla in programa.rule_ids:
                    if producto in regla.product_ids:
                        return programa, regla
                    if regla.product_category_id and categoria_matchea(
                        producto.categ_id, regla.product_category_id
                    ):
                        return programa, regla
            return None, None

        def precio_califica(producto, regla):
            es_tinte_nnp = "TINTE NNP" in (producto.name or "").upper()
            if regla.product_category_id and not es_tinte_nnp:
                categ = producto.categ_id
                while categ:
                    if (
                        categ.name
                        and "tinte" in categ.name.lower()
                        and "nnp" in categ.name.lower()
                    ):
                        es_tinte_nnp = True
                        break
                    categ = categ.parent_id
            if es_tinte_nnp:
                return producto.list_price >= PRECIO_MINIMO_TINTE_NNP
            return True

        # Agrupar cantidades por regla que matchea (varios productos
        # del carrito pueden aportar a la misma promo).
        regla_por_producto_id = {}
        total_por_regla = {}
        for linea in lineas:
            producto = self.env["product.product"].browse(linea["product_id"])
            if not producto.exists():
                continue
            _programa, regla = regla_para_producto(producto)
            if not regla or not precio_califica(producto, regla):
                continue
            regla_por_producto_id[producto.id] = regla
            total_por_regla[regla.id] = total_por_regla.get(regla.id, 0) + (
                linea.get("qty") or 1
            )

        mensajes = {}
        recompensas = []
        reglas_ya_agregadas = set()
        for product_id, regla in regla_por_producto_id.items():
            total_qty = total_por_regla[regla.id]
            min_qty = regla.minimum_qty
            if min_qty <= 0:
                continue
            promos_completas = int(total_qty // min_qty)
            resto = total_qty % min_qty
            if resto == 0 and total_qty >= min_qty:
                mensajes[product_id] = (
                    f"✅ Tienes {promos_completas} promos completas · "
                    f"Llevas {int(total_qty)} unidades válidas"
                )
            else:
                faltan = int(min_qty - resto) if resto > 0 else int(min_qty)
                mensajes[product_id] = (
                    f"⏳ Faltan {faltan} unidades · "
                    f"Llevas {int(total_qty)} unidades válidas"
                )

            if promos_completas < 1 or regla.id in reglas_ya_agregadas:
                continue
            reglas_ya_agregadas.add(regla.id)
            programa = regla.program_id
            recompensa = programa.reward_ids.filtered(
                lambda r: r.reward_type == "product" and r.reward_product_id
            )[:1]
            if not recompensa:
                continue
            recompensas.append(
                {
                    "regla_id": regla.id,
                    "programa_nombre": programa.name,
                    "reward_product_id": recompensa.reward_product_id.id,
                    "reward_product_name": recompensa.reward_product_id.display_name,
                    "reward_qty": int(recompensa.reward_product_qty or 1),
                    "disponibles": promos_completas,
                }
            )

        return {"mensajes": mensajes, "recompensas": recompensas}

    # ------------------------------------------------------------------
    # Carrito respaldado en el servidor (punto B) + "Ver en vivo"
    # (punto C) -- ver order_screen.js para el lado JS. El carrito
    # sigue viviendo solo en memoria/localStorage hasta que se
    # confirma o revisa (shalom_confirmar_pedido /
    # shalom_guardar_borrador_pedido, que son los que de verdad crean
    # sale.order.line); x_carrito_borrador es únicamente para que ese
    # estado en memoria sobreviva a un dispositivo que se rompe/apaga
    # y para reflejarlo casi en vivo en un segundo dispositivo.
    # ------------------------------------------------------------------

    def _shalom_carrito_dict(self):
        """Lee x_carrito_borrador como dict, tolerando vacío/corrupto
        (nunca revienta el catálogo por un JSON viejo o mal
        formado)."""
        self.ensure_one()
        if not self.x_carrito_borrador:
            return {}
        try:
            return json.loads(self.x_carrito_borrador) or {}
        except (ValueError, TypeError):
            _logger.warning(
                "x_carrito_borrador de fsm.order id=%s no es JSON "
                "válido -- se trata como carrito vacío.", self.id,
            )
            return {}

    def shalom_actualizar_carrito(self, cambios=None, eliminados=None):
        """Llamado desde order_screen.js cada vez que hay cambios
        pendientes del carrito (con un colchón de ~1 seg, no en cada
        toque) -- FUSIONA por clave de producto/recompensa en vez de
        reemplazar el carrito entero, a propósito: así, si dos
        dispositivos tocan productos DISTINTOS casi al mismo segundo
        (ej. el cliente agrega uno y el vendedor corrige otro desde su
        celular), los dos cambios sobreviven. Solo se pierde algo si
        los dos dispositivos tocan la MISMA clave en la misma llamada
        -- ahí gana la que llega después, como cualquier guardado
        normal.

        cambios: dict {clave: {product_id, name, list_price, cantidad,
        es_recompensa, regla_id}} a agregar/actualizar.
        eliminados: lista de claves a sacar del carrito.

        Devuelve el carrito ya fusionado completo + la marca de tiempo
        nueva, para que el dispositivo que llamó pueda quedar
        reconciliado de una sin tener que pedir de nuevo."""
        self.ensure_one()
        carrito = self._shalom_carrito_dict()
        for clave, valor in (cambios or {}).items():
            carrito[clave] = valor
        for clave in (eliminados or []):
            carrito.pop(clave, None)
        ahora = fields.Datetime.now()
        self.write({
            "x_carrito_borrador": json.dumps(carrito),
            "x_carrito_actualizado": ahora,
        })
        return {
            "carrito": carrito,
            "actualizado": fields.Datetime.to_string(ahora),
        }

    def shalom_leer_carrito(self):
        """Llamado desde order_screen.js al abrir el catálogo (para
        decidir si el snapshot del servidor es más nuevo que el de
        localStorage) y en el ciclo de sincronización de ~1 seg
        mientras no hay cambios locales pendientes (para traer lo que
        haya agregado/sacado otro dispositivo). También lo usa el
        heartbeat de 'Ver en vivo' de visit_sheet.js -- "activo" es
        True si CUALQUIER dispositivo tiene el catálogo abierto ahora
        (heartbeat de x_catalogo_heartbeat, ver
        shalom_marcar_catalogo_abierto), no si hubo un cambio de
        carrito -- un dispositivo puede estar con el catálogo abierto
        navegando, sin tocar nada, y sigue contando como 'activo'."""
        self.ensure_one()
        activo = False
        if self.x_catalogo_heartbeat:
            activo = (
                fields.Datetime.now() - self.x_catalogo_heartbeat
            ).total_seconds() <= SHALOM_SEGUNDOS_CARRITO_ACTIVO
        return {
            "carrito": self._shalom_carrito_dict(),
            "actualizado": (
                fields.Datetime.to_string(self.x_carrito_actualizado)
                if self.x_carrito_actualizado else False
            ),
            "activo": activo,
        }

    def _shalom_sesiones_dict(self):
        """Lee x_catalogo_sesiones como dict, tolerando vacío/corrupto."""
        self.ensure_one()
        if not self.x_catalogo_sesiones:
            return {}
        try:
            return json.loads(self.x_catalogo_sesiones) or {}
        except (ValueError, TypeError):
            return {}

    def shalom_marcar_catalogo_abierto(self, sesion_id):
        """Heartbeat de presencia: llamado por order_screen.js UNA VEZ
        POR TICK de su propio ciclo de sincronización (~1 seg), tenga o
        no cambios de carrito pendientes -- así 'Ver en vivo' refleja
        'el catálogo está genuinamente abierto ahí', no 'se tocó algo
        hace poco'. A propósito NO lo llama shalom_leer_carrito (que
        también usa visit_sheet.js para el chequeo pasivo del botón):
        si una simple lectura marcara presencia, un dispositivo que
        solo está MIRANDO el botón 'Ver en vivo' -- sin el catálogo
        abierto -- se marcaría a sí mismo como presente por error.

        Además registra/actualiza esta sesión (pestaña del navegador)
        en x_catalogo_sesiones y devuelve si ES la principal ahora --
        ver el docstring grande de ese campo para el criterio ('desde'
        más antiguo entre las sesiones con heartbeat vivo). De paso
        descarta sesiones viejas cuyo heartbeat quedó colgado (cerrada
        sin avisar, ej. se cerró la pestaña de un tirón): así el rol
        de principal pasa solo al siguiente en la cadena, sin esperar
        ninguna acción explícita del que se fue."""
        self.ensure_one()
        ahora = fields.Datetime.now()
        sesiones = self._shalom_sesiones_dict()
        limite = ahora - timedelta(seconds=SHALOM_SEGUNDOS_CARRITO_ACTIVO)

        vivas = {}
        for sid, datos in sesiones.items():
            try:
                heartbeat = fields.Datetime.from_string(datos.get("heartbeat"))
            except (ValueError, TypeError):
                continue
            if heartbeat and heartbeat >= limite:
                vivas[sid] = datos

        if sesion_id in vivas:
            vivas[sesion_id]["heartbeat"] = fields.Datetime.to_string(ahora)
        else:
            vivas[sesion_id] = {
                "desde": fields.Datetime.to_string(ahora),
                "heartbeat": fields.Datetime.to_string(ahora),
            }

        self.write({
            "x_catalogo_sesiones": json.dumps(vivas),
            "x_catalogo_heartbeat": ahora,
        })

        principal_id = min(vivas, key=lambda sid: vivas[sid]["desde"])
        return {"es_principal": principal_id == sesion_id}

    def shalom_cerrar_sesion_catalogo(self, sesion_id):
        """Llamado por order_screen.js al cerrarse (cualquier salida
        intencional) para sacar esta sesión de x_catalogo_sesiones de
        una, sin esperar a que su heartbeat quede viejo -- así el rol
        de 'principal' pasa a la siguiente sesión ni bien esta se va,
        no ~SHALOM_SEGUNDOS_CARRITO_ACTIVO segundos después. Best-effort
        del lado del JS (no bloquea el cierre si falla): si no llega a
        correr, la limpieza por heartbeat viejo de
        shalom_marcar_catalogo_abierto() cubre igual el caso, con ese
        margen de segundos nomás."""
        self.ensure_one()
        sesiones = self._shalom_sesiones_dict()
        if sesion_id in sesiones:
            sesiones.pop(sesion_id)
            self.write({"x_catalogo_sesiones": json.dumps(sesiones)})
        return True

    def _shalom_limpiar_carrito_borrador(self):
        """Vacía x_carrito_borrador/x_carrito_actualizado de esta
        visita -- llamado desde shalom_confirmar_pedido y
        shalom_guardar_borrador_pedido (el carrito ya cumplió su
        función, no tiene sentido dejar la copia de trabajo colgada) y
        desde shalom_limpiar_carrito (llamado por order_screen.js al
        tocar 'Salir sin guardar'). Sin esto, un carrito armado y
        después descartado se quedaba guardado en el servidor para
        siempre (bug real reportado: al reabrir la visita, el carrito
        'descartado' volvía a aparecer, porque la reconciliación de
        B tomaba el snapshot del servidor -- más nuevo que el de
        localStorage, que sí se había limpiado -- como el válido)."""
        for orden in self:
            if orden.x_carrito_borrador or orden.x_carrito_actualizado:
                orden.write({
                    "x_carrito_borrador": False,
                    "x_carrito_actualizado": False,
                })

    def shalom_limpiar_carrito(self):
        """Llamado desde order_screen.js al confirmar 'Salir sin
        guardar' (carrito con productos, descartado a propósito) --
        ver _shalom_limpiar_carrito_borrador(). Se ignora en silencio
        del lado del JS si esta llamada falla (ej. sin señal en ese
        instante); no es grave si a veces no llega a limpiarse acá: la
        limpieza mensual automática (shalom_limpiar_carritos_viejos)
        es la red de seguridad para esos casos."""
        self._shalom_limpiar_carrito_borrador()
        return True

    @api.model
    def shalom_limpiar_carritos_viejos(self):
        """Cron mensual (ver data/carrito_borrador_cron.xml): limpia
        x_carrito_borrador/x_carrito_actualizado de cualquier visita
        cuyo carrito no se toca hace más de SHALOM_DIAS_CARRITO_VIEJO
        días -- red de seguridad para el caso en que
        _shalom_limpiar_carrito_borrador() no llegó a correr (ej. el
        vendedor cerró la app de un tirón sin pasar por 'Salir sin
        guardar' ni por confirmar/revisar el pedido). No es por peso
        real (es un texto chico) sino para no dejar basura vieja
        acumulada sin límite. 30 días de ANTIGÜEDAD del último
        guardado, no "el mes calendario" -- cada visita se limpia
        cuando cumple sus propios 30 días, no todas juntas el día 1."""
        limite = fields.Datetime.now() - timedelta(days=SHALOM_DIAS_CARRITO_VIEJO)
        viejas = self.search([("x_carrito_actualizado", "<", limite)])
        if viejas:
            viejas._shalom_limpiar_carrito_borrador()
            _logger.info(
                "Limpieza mensual de carritos: %s visita(s) con carrito "
                "de más de %s días sin tocar, limpiadas.",
                len(viejas), SHALOM_DIAS_CARRITO_VIEJO,
            )

    @api.model
    def shalom_admin_visitas_en_vivo(self):
        """Administración → 'En vivo': lista SOLO los catálogos
        genuinamente abiertos ahora mismo en algún dispositivo (heartbeat
        de x_catalogo_heartbeat de los últimos SHALOM_SEGUNDOS_CARRITO_ACTIVO
        segundos, mismo criterio que shalom_leer_carrito) -- para que
        oficina elija a cuál entrar a mirar/ayudar sin tener que revisar
        visitas abiertas que nadie está usando en este momento (antes
        traía TODAS las visitas sin cerrar, con un flag "activo" aparte
        que el frontend usaba solo para el texto/puntito -- pedido
        explícito: que la lista misma quede filtrada, no mezclada)."""
        self._shalom_verificar_admin()
        limite = fields.Datetime.now() - timedelta(seconds=SHALOM_SEGUNDOS_CARRITO_ACTIVO)
        ordenes = self.search(
            [
                ("stage_id.is_closed", "=", False),
                ("x_catalogo_heartbeat", ">=", limite),
            ],
            order="x_catalogo_heartbeat desc",
        )
        return [
            {
                "id": orden.id,
                "cliente_nombre": orden.location_id.name if orden.location_id else "",
                "ruta_nombre": orden.fsm_route_id.name if orden.fsm_route_id else "",
                "vendedor_nombre": (
                    orden.fsm_route_id.fsm_person_id.name
                    if orden.fsm_route_id and orden.fsm_route_id.fsm_person_id
                    else ""
                ),
            }
            for orden in ordenes
        ]

    def _cerrar_visita_completada(self):
        """Mueve esta visita a la etapa Completada -- usado tanto por
        shalom_confirmar_pedido() (venta confirmada) como por
        shalom_guardar_borrador_pedido() (cotización en borrador):
        decisión de producto explícita: haber armado una cotización, así
        sea en borrador, ya es prueba suficiente de que el cliente fue
        atendido. Concretarla a orden de venta queda como
        responsabilidad del vendedor, más tarde, desde el módulo de
        Ventas -- eso no bloquea que la visita se cuente como resuelta."""
        self.ensure_one()
        etapa_completada = self.env.ref(
            "fieldservice.fsm_stage_completed", raise_if_not_found=False
        )
        if etapa_completada:
            # fieldservice bloquea por defecto escribir stage_id directo a
            # la etapa Completado (pensado para que solo se llegue ahí por
            # un flujo controlado, no arrastrando una tarjeta en el
            # Kanban) -- bypass_order_completed_stage es la salida oficial
            # para escrituras programáticas legítimas como esta.
            self.with_context(bypass_order_completed_stage=True).write(
                {"stage_id": etapa_completada.id}
            )

    def _id_etapa_cancelada(self):
        """id de la etapa "Cancelado" (fieldservice.fsm_stage_cancelled),
        buscada por xml_id en vez de por nombre. Antes se comparaba
        contra el string "Cancelled" (inglés), pero el nombre real de
        la etapa en producción es "Cancelado" (español) -- esa
        comparación nunca coincidía, y una visita cancelada terminaba
        contando como completada para el correlativo de Jornada.
        Buscar por xml_id no depende del nombre visible (que puede
        estar traducido o editado a mano)."""
        etapa = self.env.ref(
            "fieldservice.fsm_stage_cancelled", raise_if_not_found=False
        )
        return etapa.id if etapa else False

    def _es_transicion_a_completado(self, vals):
        """True si esta escritura mueve el stage_id hacia una etapa
        cerrada que NO sea la de cancelado (esto incluye tanto
        Completado como No quiso -- las dos son etapas cerradas)."""
        if "stage_id" not in vals or not vals["stage_id"]:
            return False
        stage = self.env["fsm.stage"].browse(vals["stage_id"])
        return bool(stage.is_closed) and stage.id != self._id_etapa_cancelada()

    def shalom_campos_cliente_faltantes(self):
        """Lista de etiquetas de los datos que le faltan al cliente de
        ESTA visita para poder cerrarla en Completado/No quiso (ver
        write() más abajo) -- el correo queda afuera a propósito, es
        el único campo realmente opcional. fsm.location hereda estos
        campos de res.partner vía _inherits, así que se leen directo
        desde location_id sin un read aparte. Incluye la foto del local
        (image_1920, misma foto que carga cliente_form.js) -- pedido
        explícito, se agregó como dato obligatorio junto con el resto.

        También la llama la app del vendedor desde el catálogo/carrito
        (order_screen.js) para el aviso NO bloqueante de "a este
        cliente le faltan datos" -- ahí se usa solo para avisar, antes
        de siquiera intentar cerrar la visita."""
        self.ensure_one()
        loc = self.location_id
        faltantes = []
        if not loc:
            return faltantes
        if not (loc.partner_latitude and loc.partner_longitude):
            faltantes.append(_("Ubicación GPS"))
        if not (loc.phone or loc.mobile):
            faltantes.append(_("Teléfono o celular"))
        if not loc.vat:
            faltantes.append(_("RUC"))
        if not loc.x_nombre_contacto:
            faltantes.append(_("Nombre del contacto"))
        if not loc.image_1920:
            faltantes.append(_("Foto del local"))
        return faltantes

    def _validar_cierre_visita(self, vals):
        """Bloquea, con UserError, dejar esta visita en Completado/No
        quiso con datos del cliente incompletos, o en Cancelado sin
        una nota en Observaciones explicando por qué. Se llama SOLO
        desde write() cuando viene con el contexto
        shalom_validar_cierre_visita -- así queda acotado a la app del
        vendedor (visit_sheet.js lo pasa a propósito en elegirEstado());
        el Kanban nativo de fsm.order, que usa oficina, escribe
        stage_id sin ese contexto y no se topa con esto -- decisión de
        producto explícita: oficina necesita poder corregir casos
        puntuales sin esta traba."""
        if "stage_id" not in vals or not vals["stage_id"]:
            return
        stage_id = vals["stage_id"]
        if stage_id == self._id_etapa_cancelada():
            for order in self:
                observacion = vals.get(
                    "x_observaciones_visita", order.x_observaciones_visita
                )
                if not (observacion or "").strip():
                    raise UserError(_(
                        "Para dejar esta visita como Cancelado hace falta "
                        "escribir en Observaciones por qué se cancela."
                    ))
        elif self._es_transicion_a_completado(vals):
            for order in self:
                faltantes = order.shalom_campos_cliente_faltantes()
                if faltantes:
                    raise UserError(_(
                        'A "%(cliente)s" le falta: %(faltantes)s. '
                        'Completalo desde "Editar cliente" antes de poder '
                        "cerrar la visita así."
                    ) % {
                        "cliente": order.location_id.name or _("este cliente"),
                        "faltantes": ", ".join(faltantes),
                    })

    def _calcular_jornada(self):
        """Calcula el número de jornada para esta orden, comparando con
        la última orden completada de la misma ruta."""
        self.ensure_one()
        if not self.fsm_route_id:
            return 1

        id_etapa_cancelada = self._id_etapa_cancelada()
        dominio = [
            ("fsm_route_id", "=", self.fsm_route_id.id),
            ("id", "!=", self.id),
            ("stage_id.is_closed", "=", True),
        ]
        if id_etapa_cancelada:
            dominio.append(("stage_id", "!=", id_etapa_cancelada))

        ultima = self.env["fsm.order"].search(
            dominio, order="write_date desc", limit=1
        )
        if not ultima:
            return 1

        limite = ultima.write_date + timedelta(hours=HORAS_INACTIVIDAD_NUEVA_JORNADA)
        if fields.Datetime.now() > limite:
            return (ultima.x_jornada or 1) + 1
        return ultima.x_jornada or 1

    def write(self, vals):
        if self.env.context.get("shalom_validar_cierre_visita"):
            self._validar_cierre_visita(vals)

        # Detectar, ANTES de escribir, cuáles registros están pasando a
        # "completado" en esta llamada, para poder calcular la jornada
        # después con el estado ya actualizado (y sin pisar un valor
        # manual que venga en el mismo vals).
        ids_a_calcular = []
        if self._es_transicion_a_completado(vals):
            ids_a_calcular = self.ids

        jornada_manual = "x_jornada" in vals

        res = super().write(vals)

        if ids_a_calcular and not jornada_manual:
            for order in self.browse(ids_a_calcular):
                order.x_jornada = order._calcular_jornada()

        return res

    def action_shalom_archivar_visita(self):
        """Botón 'Eliminar' (papelera) en la lista de 'Visitas
        generadas' de fsm.route.schedule: archiva ESTA visita puntual
        (active=False), no la borra de verdad. fsm.order (igual que
        fsm.location, ver action_eliminar_ubicacion() en
        fsm_location.py) no tiene perm_unlink habilitado para ningún
        grupo en el módulo nativo fieldservice -- el ícono de borrado
        nativo de una lista embebida no hace nada real ahí, bloqueado
        en silencio. Archivar consigue el mismo efecto visual (la fila
        desaparece de la lista) sin pelear contra esa restricción, y
        de paso deja el historial recuperable con el filtro de
        archivados en vez de perderlo del todo -- para el caso típico
        de un cliente que se coló por error en una ocurrencia."""
        self.ensure_one()
        _logger.info(
            "Visita archivada a mano desde 'Visitas generadas': "
            "fsm.order id=%s ('%s').", self.id, self.name,
        )
        self.write({"active": False})
        return True

    def action_abrir_maps(self):
        """Botón 'Ir con Waze': abre Waze en pestaña/app nueva con la
        ruta hacia las coordenadas guardadas del cliente. Antes abría
        Google Maps -- cambiado por decisión explícita del usuario."""
        self.ensure_one()
        lat = self.location_id.partner_latitude
        lng = self.location_id.partner_longitude
        if not lat and not lng:
            raise UserError(
                _("Este cliente todavía no tiene coordenadas guardadas. "
                  "Capturá primero su ubicación GPS.")
            )
        url = f"https://waze.com/ul?ll={lat},{lng}&navigate=yes"
        return {
            "type": "ir.actions.act_url",
            "url": url,
            "target": "new",
        }

    def action_ver_historial_cotizaciones(self):
        """Botón 'Historial': abre la lista de todas las sale.order
        CONFIRMADAS (ventas reales, no borradores) del cliente de esta
        visita, ordenadas de más reciente a más antigua."""
        self.ensure_one()
        partner = self.location_id.partner_id
        if not partner:
            raise UserError(
                _("Esta visita no tiene un cliente asociado.")
            )

        return {
            "type": "ir.actions.act_window",
            "name": _("Cotizaciones de %(cliente)s", cliente=partner.name),
            "res_model": "sale.order",
            "view_mode": "list,form",
            "domain": [
                ("partner_id", "=", partner.id),
                ("state", "in", list(ESTADOS_VENTA_CONFIRMADA)),
            ],
            "context": {"default_partner_id": partner.id},
        }

    def get_datos_grafico_compras(self):
        """Devuelve los datos ya agregados por mes y producto, para que
        el widget Owl embebido en la tarjeta los use directamente con
        Chart.js: cantidad comprada por mes (últimos 12 meses) de los
        5-6 productos más relevantes (combinando los más comprados en
        total con los que muestran caída/dejaron de comprarse).

        Formato de retorno:
        {
            "meses": ["2025-08", "2025-09", ...],  # 12 meses, ascendente
            "series": [
                {"producto": "Detergente Ariel", "datos": [3, 5, 0, ...]},
                ...
            ],
            "olvidados": [
                {"producto": "...", "ultima_compra": "2025-04-15"},
                ...
            ],
        }
        """
        self.ensure_one()
        partner = self.location_id.partner_id
        if not partner:
            return {"meses": [], "series": [], "olvidados": []}

        hoy = fields.Date.today()
        primer_mes = (hoy.replace(day=1)) - relativedelta(months=11)
        meses = [
            (primer_mes + relativedelta(months=i)).strftime("%Y-%m")
            for i in range(12)
        ]

        lineas = self.env["sale.order.line"].search(
            [
                ("order_id.partner_id", "=", partner.id),
                ("order_id.state", "in", list(ESTADOS_VENTA_CONFIRMADA)),
                ("product_id", "!=", False),
                ("order_id.date_order", ">=", primer_mes),
            ]
        )

        # Para el cálculo de "olvidados" hace falta el historial COMPLETO,
        # no solo los últimos 12 meses (para saber la última fecha real
        # de compra aunque sea más vieja que la ventana del gráfico).
        todas_las_lineas = self.env["sale.order.line"].search(
            [
                ("order_id.partner_id", "=", partner.id),
                ("order_id.state", "in", list(ESTADOS_VENTA_CONFIRMADA)),
                ("product_id", "!=", False),
            ]
        )

        if not todas_las_lineas:
            return {"meses": meses, "series": [], "olvidados": []}

        cantidad_total_por_producto = {}
        ultima_compra_por_producto = {}
        cantidad_por_mes_y_producto = {}

        for linea in todas_las_lineas:
            producto = linea.product_id
            cantidad_total_por_producto[producto] = (
                cantidad_total_por_producto.get(producto, 0)
                + linea.product_uom_qty
            )
            fecha_orden = linea.order_id.date_order
            fecha_orden_date = fecha_orden.date() if fecha_orden else None
            if fecha_orden_date and (
                producto not in ultima_compra_por_producto
                or fecha_orden_date > ultima_compra_por_producto[producto]
            ):
                ultima_compra_por_producto[producto] = fecha_orden_date

        for linea in lineas:
            producto = linea.product_id
            fecha_orden = linea.order_id.date_order
            if not fecha_orden:
                continue
            mes_key = fecha_orden.strftime("%Y-%m")
            clave = (producto, mes_key)
            cantidad_por_mes_y_producto[clave] = (
                cantidad_por_mes_y_producto.get(clave, 0) + linea.product_uom_qty
            )

        fecha_limite_olvido = hoy - relativedelta(
            months=MESES_SIN_COMPRA_PARA_ALERTA
        )

        productos_top = sorted(
            cantidad_total_por_producto.items(),
            key=lambda item: item[1],
            reverse=True,
        )
        productos_olvidados = [
            producto
            for producto, ultima_fecha in ultima_compra_por_producto.items()
            if ultima_fecha and ultima_fecha < fecha_limite_olvido
        ]

        # Top productos relevantes: combina los más comprados y los
        # olvidados, sin duplicar, hasta TOP_PRODUCTOS_GRAFICO_CANTIDAD.
        productos_relevantes = []
        for producto, _cantidad in productos_top:
            if producto not in productos_relevantes:
                productos_relevantes.append(producto)
            if len(productos_relevantes) >= TOP_PRODUCTOS_GRAFICO_CANTIDAD:
                break
        for producto in productos_olvidados:
            if producto not in productos_relevantes:
                productos_relevantes.append(producto)
            if len(productos_relevantes) >= TOP_PRODUCTOS_GRAFICO_CANTIDAD:
                break

        series = []
        for producto in productos_relevantes:
            datos = [
                cantidad_por_mes_y_producto.get((producto, mes), 0)
                for mes in meses
            ]
            series.append(
                {"producto": producto.display_name, "datos": datos}
            )

        olvidados = [
            {
                "producto": producto.display_name,
                "ultima_compra": ultima_compra_por_producto[producto].isoformat(),
            }
            for producto in productos_olvidados
        ]

        return {"meses": meses, "series": series, "olvidados": olvidados}

    # ------------------------------------------------------------------
    # Administración → Seguimiento de Visitas (punto 4 de la ronda de
    # feedback "administración"). Ver también fsm_location.py
    # (shalom_admin_archivar_cliente) y fsm_person.py
    # (shalom_admin_rutas_programadas) para el resto del apartado.
    # ------------------------------------------------------------------

    def _shalom_verificar_admin(self):
        """Corta con AccessError si el usuario logueado no tiene el rol
        Administrador de Servicio de Campo -- todos los métodos de
        Administración pasan por acá antes de devolver o tocar nada,
        para no depender solo de que el menú esté oculto en el
        frontend (el mismo grupo que ya usa el botón "Crear Ubicación
        de Servicio" en res_partner.py)."""
        if not self.env.user.has_group("fieldservice.group_fsm_manager"):
            raise AccessError(_(
                "Esta acción es solo para el rol Administrador de "
                "Servicio de Campo."
            ))

    # xml_id de cada etapa cerrada -- mismo criterio que
    # _id_etapa_cancelada() más arriba (por xml_id, no por nombre
    # visible, que puede estar traducido o editado a mano).
    _SHALOM_XMLID_ETAPA = {
        "cancelado": "fieldservice.fsm_stage_cancelled",
        "completado": "fieldservice.fsm_stage_completed",
        "no_quiso": "shalom_location_map.shalom_fsm_stage_no_quiso",
        "no_atendido": "shalom_location_map.shalom_fsm_stage_no_atendido",
    }

    @api.model
    def shalom_admin_seguimiento_visitas(self, estados=None, route_id=False):
        """Visitas para Administración → Seguimiento de Visitas: por
        default Cancelado/No quiso (las que necesitan que alguien
        decida algo), con cliente, ruta, vendedor, fecha y observación
        a la vista -- para revisar sin abrir cada visita una por una.
        `estados` acepta cualquier combinación de "cancelado",
        "no_quiso", "completado", "pendiente" (cualquier etapa
        abierta)."""
        self._shalom_verificar_admin()
        estados = estados or ["cancelado", "no_quiso"]

        sub_dominios = []
        if "pendiente" in estados:
            sub_dominios.append([("stage_id.is_closed", "=", False)])
        ids_cerradas = []
        for estado in estados:
            xml_id = self._SHALOM_XMLID_ETAPA.get(estado)
            if not xml_id:
                continue
            etapa = self.env.ref(xml_id, raise_if_not_found=False)
            if etapa:
                ids_cerradas.append(etapa.id)
        if ids_cerradas:
            sub_dominios.append([("stage_id", "in", ids_cerradas)])
        if not sub_dominios:
            return []

        dominio = expression.OR(sub_dominios)
        if route_id:
            dominio = expression.AND([dominio, [("fsm_route_id", "=", route_id)]])

        ordenes = self.search(dominio, order="write_date desc", limit=200)
        return [
            {
                "id": orden.id,
                "cliente_nombre": orden.location_id.name if orden.location_id else "",
                "location_id": orden.location_id.id if orden.location_id else False,
                "ruta_nombre": orden.fsm_route_id.name if orden.fsm_route_id else "",
                "vendedor_nombre": (
                    orden.fsm_route_id.fsm_person_id.name
                    if orden.fsm_route_id and orden.fsm_route_id.fsm_person_id
                    else ""
                ),
                "fecha": fields.Datetime.to_string(orden.write_date) if orden.write_date else "",
                "observaciones": orden.x_observaciones_visita or "",
                "estado_nombre": orden.stage_id.name or "",
                "revisado": orden.x_revisado_admin,
            }
            for orden in ordenes
        ]

    def shalom_toggle_revisado(self):
        """Botón 'Marcar revisado' / 'Marcar sin revisar' de
        Administración → Seguimiento de Visitas -- no cambia el
        estado de la visita, solo evita que oficina tenga que releer
        la misma observación dos veces."""
        self._shalom_verificar_admin()
        for orden in self:
            orden.x_revisado_admin = not orden.x_revisado_admin
        return True
