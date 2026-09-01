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
import logging
from datetime import timedelta

from dateutil.relativedelta import relativedelta

from odoo import _, api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# Umbral de inactividad para considerar que empezó una nueva jornada.
HORAS_INACTIVIDAD_NUEVA_JORNADA = 6


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
        dicts {"product_id": int, "qty": float}).

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

        Cada línea puede traer opcionalmente "price_unit": si viene,
        se fuerza ese precio (se usa para la línea de recompensa de una
        promo completa, que va a $0 -- sin esto, Odoo le calcularía el
        precio de lista normal al crear la línea)."""
        for linea in lineas:
            vals = {
                "order_id": sale_order.id,
                "product_id": linea["product_id"],
                "product_uom_qty": linea.get("qty") or 1,
            }
            if "price_unit" in linea and linea["price_unit"] is not False:
                vals["price_unit"] = linea["price_unit"]
            self.env["sale.order.line"].create(vals)

    def shalom_confirmar_pedido(self, lineas):
        """Llamado desde la app del vendedor al tocar "Confirmar
        pedido": crea o reutiliza la cotización vinculada a esta visita
        (mismo criterio anti-duplicado que action_crear_cotizacion),
        reemplaza sus líneas por las del carrito recibido, la CONFIRMA
        (action_confirm -- pasa a venta real y reserva stock) y cierra
        la visita moviéndola a la etapa Completada. La factura se
        genera después, aparte, en oficina -- este método no toca
        facturación.

        lineas: lista de dicts {"product_id": int, "qty": float}, uno
        por producto agregado al carrito.

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
        desde location_id sin un read aparte.

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
