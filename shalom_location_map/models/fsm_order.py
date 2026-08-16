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

4. Botón "Ir con Maps": abre Google Maps (en pestaña/app nueva) con la
   ruta hacia las coordenadas guardadas del cliente. No se construye un
   mapa propio dentro de Odoo -- se apoya en la app externa que la
   gente ya conoce y usa a diario.

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
        for linea in lineas:
            self.env["sale.order.line"].create(
                {
                    "order_id": sale_order.id,
                    "product_id": linea["product_id"],
                    "product_uom_qty": linea.get("qty") or 1,
                }
            )
        sale_order.action_confirm()

        etapa_completada = self.env.ref(
            "fieldservice.fsm_stage_completed", raise_if_not_found=False
        )
        if etapa_completada:
            self.write({"stage_id": etapa_completada.id})

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
        cerrada que NO sea la de cancelado."""
        if "stage_id" not in vals or not vals["stage_id"]:
            return False
        stage = self.env["fsm.stage"].browse(vals["stage_id"])
        return bool(stage.is_closed) and stage.id != self._id_etapa_cancelada()

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

    def action_abrir_maps(self):
        """Botón 'Ir con Maps': abre Google Maps en pestaña/app nueva
        con la ruta hacia las coordenadas guardadas del cliente."""
        self.ensure_one()
        lat = self.location_id.partner_latitude
        lng = self.location_id.partner_longitude
        if not lat and not lng:
            raise UserError(
                _("Este cliente todavía no tiene coordenadas guardadas. "
                  "Capturá primero su ubicación GPS.")
            )
        url = f"https://www.google.com/maps/dir/?api=1&destination={lat},{lng}"
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
