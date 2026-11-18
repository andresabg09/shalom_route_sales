# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""Cola offline de la app del vendedor: lado servidor.

Cuando el vendedor confirma un pedido, guarda una cotización, cambia el
estado de una visita, escribe una nota, captura GPS o descarta un
carrito, el teléfono guarda primero esa acción en su propia cola (con un
id único, `uuid`, generado en el teléfono) y la manda apenas puede. Aquí
se procesa cada acción UNA sola vez:

- Si llega un uuid ya procesado con éxito, se devuelve el mismo
  resultado guardado, sin volver a ejecutar nada (sin pedidos dobles,
  aunque el teléfono reintente porque no le llegó la respuesta).
- Cada acción corre en su propio savepoint: un error en una no deshace
  las demás del mismo envío.
- Error de negocio (UserError, ej. falta la nota para "Cancelado"): se
  guarda como "error" y se le devuelve al teléfono, que lo muestra como
  "Necesita atención". Si el vendedor lo reintenta, se vuelve a procesar.
- Conflicto de concurrencia de PostgreSQL: se deja subir para que Odoo
  reintente la petición entera (es segura de repetir por el uuid).

Los métodos de negocio que se llaman son los mismos de siempre
(shalom_confirmar_pedido, shalom_guardar_borrador_pedido, write de la
etapa con el mismo contexto, action_capturar_gps, shalom_limpiar_carrito),
como el usuario logueado: mismos permisos y validaciones que en línea.
"""
import json
import logging
from datetime import timedelta

import psycopg2

from odoo import _, api, fields, models
from odoo.exceptions import AccessError, MissingError, UserError, ValidationError

from . import offline_utils

_logger = logging.getLogger(__name__)

# Acciones por envío (el teléfono manda de a pocas, en orden).
MAX_EVENTOS_POR_LOTE = 20

ERRORES_DE_NEGOCIO = (UserError, ValidationError, AccessError, MissingError)


class AltaEnProceso(Exception):
    """El cliente nuevo del que depende esta acción se está procesando en
    otro envío ahora mismo: el teléfono la reintenta en un rato."""


class ShalomSyncEvento(models.Model):
    _name = "shalom.sync.evento"
    _description = "Acción enviada desde la app del vendedor (cola offline)"
    _order = "recibido_en desc, id desc"

    uuid = fields.Char(required=True, index=True, copy=False)
    tipo = fields.Char(required=True)
    user_id = fields.Many2one("res.users", ondelete="set null", default=lambda self: self.env.user)
    order_id = fields.Many2one("fsm.order", string="Visita", ondelete="set null", index=True)
    creado_en_telefono = fields.Datetime(help="Cuándo hizo la acción el vendedor (hora del teléfono).")
    recibido_en = fields.Datetime(default=fields.Datetime.now, required=True, index=True)
    estado = fields.Selection(
        [("procesando", "Procesando"), ("ok", "Hecho"), ("error", "Necesita atención")],
        required=True, default="procesando",
    )
    intentos = fields.Integer(default=1)
    payload_json = fields.Text()
    resultado_json = fields.Text()
    error = fields.Text()
    precio_cambiado = fields.Boolean(help="Se respetó el precio de la visita y era distinto del vigente.")
    # Cliente creado sin señal (evento crear_cliente): ids provisorios
    # (negativos) que el teléfono usó para el cliente y su visita. Las
    # acciones siguientes (pedido, estado, edición...) llegan con esos ids
    # y se traducen a los reales (ver _shalom_resolver_temporales).
    tmp_location_id = fields.Integer(index=True, copy=False)
    tmp_order_id = fields.Integer(index=True, copy=False)

    _sql_constraints = [
        ("uuid_unico", "unique(uuid)", "Esta acción ya se recibió."),
    ]

    # ------------------------------------------------------------------
    # Punto de entrada (llamado por sincronizador.js)
    # ------------------------------------------------------------------

    @api.model
    def shalom_ping(self):
        """Latido mínimo para saber si hay internet DE VERDAD (no solo
        barras de señal). No toca nada."""
        return {"ok": True}

    @api.model
    def shalom_estado_eventos(self, uuids):
        """Solo lectura: qué pasó con estas acciones en el servidor. Lo usa
        el botón "Eliminar" del panel de conexión antes de borrar del
        teléfono algo que ya se intentó enviar (la respuesta pudo perderse
        con mala señal y la acción haber entrado igual).

        Devuelve {uuid: "ok" | "error" | "procesando" | "desconocido"}.
        Cada vendedor ve solo las suyas (un administrador, todas)."""
        if not isinstance(uuids, list):
            return {}
        uuids = [str(u)[:64] for u in uuids[:MAX_EVENTOS_POR_LOTE] if u]
        dominio = [("uuid", "in", uuids)]
        if not self.env.user.has_group("fieldservice.group_fsm_manager"):
            dominio.append(("user_id", "=", self.env.user.id))
        encontrados = {ev.uuid: ev.estado for ev in self.sudo().search(dominio)}
        return {u: encontrados.get(u, "desconocido") for u in uuids}

    @api.model
    def shalom_procesar_lote(self, eventos):
        """eventos: [{uuid, tipo, datos, creado_en}] en el orden en que el
        vendedor los hizo. Devuelve [{uuid, estado, resultado | error}]
        en el mismo orden. estado: "ok", "error" o "en_proceso" (otro
        envío del mismo uuid se está procesando ahora mismo: reintentar
        en un rato)."""
        if not isinstance(eventos, list):
            raise UserError(_("Formato de envío inválido."))
        return [self._shalom_procesar_uno(ev) for ev in eventos[:MAX_EVENTOS_POR_LOTE]]

    def _shalom_procesar_uno(self, ev):
        ev = ev if isinstance(ev, dict) else {}
        uuid = str(ev.get("uuid") or "")[:64]
        tipo = ev.get("tipo")
        datos = ev.get("datos") if isinstance(ev.get("datos"), dict) else {}
        manejador = getattr(self, f"_shalom_ev_{tipo}", None) if isinstance(tipo, str) and tipo.isidentifier() else None
        if not uuid or manejador is None:
            return {"uuid": uuid, "estado": "error", "error": _("Acción desconocida (actualizá la app)."), "permanente": True}

        Libro = self.sudo()
        previo = Libro.search([("uuid", "=", uuid)], limit=1)
        if previo and previo.estado == "ok":
            return {"uuid": uuid, "estado": "ok", "resultado": self._shalom_json(previo.resultado_json), "repetido": True}
        if previo and previo.estado == "procesando":
            # Quedó a medias en un envío anterior que no terminó de
            # confirmarse (la transacción entera se deshizo, así que en
            # realidad no existe) o se está procesando ahora mismo.
            return {"uuid": uuid, "estado": "en_proceso"}

        # Ids provisorios (cliente creado sin señal) -> reales.
        originales = datos
        error_resolucion = None
        try:
            datos = self._shalom_resolver_temporales(datos)
        except AltaEnProceso:
            return {"uuid": uuid, "estado": "en_proceso"}
        except UserError as error:
            error_resolucion = self._shalom_mensaje_error(error)
        order_id = datos.get("order_id")
        visita = (
            self.env["fsm.order"].browse(order_id).exists()
            if isinstance(order_id, int) and order_id > 0
            else self.env["fsm.order"]
        )
        vals = {
            "tipo": tipo,
            "user_id": self.env.user.id,
            "order_id": visita.id or False,
            "payload_json": json.dumps(self._shalom_sin_foto(originales))[:200000],
            "creado_en_telefono": self._shalom_fecha(ev.get("creado_en")),
            "estado": "procesando",
        }
        for campo in ("tmp_location_id", "tmp_order_id"):
            valor = originales.get(campo)
            if tipo == "crear_cliente" and isinstance(valor, int) and valor < 0:
                vals[campo] = valor
        try:
            with self.env.cr.savepoint():
                if previo:
                    previo.write({**vals, "intentos": previo.intentos + 1, "error": False})
                    registro = previo
                else:
                    registro = Libro.create({**vals, "uuid": uuid})
        except psycopg2.IntegrityError:
            # El mismo uuid lo está guardando otro envío en paralelo.
            return {"uuid": uuid, "estado": "en_proceso"}

        if error_resolucion:
            registro.write({"estado": "error", "error": error_resolucion})
            return {"uuid": uuid, "estado": "error", "error": error_resolucion}

        try:
            with self.env.cr.savepoint():
                resultado = manejador(visita, datos, uuid) or {}
        except ERRORES_DE_NEGOCIO as error:
            mensaje = self._shalom_mensaje_error(error)
            registro.write({"estado": "error", "error": mensaje})
            return {"uuid": uuid, "estado": "error", "error": mensaje}
        except psycopg2.OperationalError:
            # Conflicto de concurrencia: Odoo reintenta la petición entera.
            raise
        except Exception as error:  # noqa: BLE001 -- se informa como "necesita atención"
            _logger.exception("Cola offline: error inesperado procesando %s %s", tipo, uuid)
            mensaje = _("Error inesperado del servidor: %(error)s", error=str(error)[:300])
            registro.write({"estado": "error", "error": mensaje})
            return {"uuid": uuid, "estado": "error", "error": mensaje}

        registro.write({
            "estado": "ok",
            "resultado_json": json.dumps(resultado, default=str),
            "precio_cambiado": bool(resultado.get("precios_cambiados")),
        })
        return {"uuid": uuid, "estado": "ok", "resultado": resultado}

    # ------------------------------------------------------------------
    # Acciones (una por tipo). Firma: (visita, datos, uuid) -> dict
    # ------------------------------------------------------------------

    def _shalom_exigir_visita(self, visita):
        if not visita:
            raise UserError(_("La visita ya no existe (¿la archivaron o borraron desde oficina?)."))
        return visita

    @staticmethod
    def _shalom_lineas(datos):
        lineas = datos.get("lineas")
        if not isinstance(lineas, list):
            raise UserError(_("El pedido no tiene productos."))
        limpias = []
        for linea in lineas:
            if not isinstance(linea, dict) or not isinstance(linea.get("product_id"), int):
                continue
            limpias.append({
                "product_id": linea["product_id"],
                "qty": linea.get("qty") or 1,
                "es_recompensa": bool(linea.get("es_recompensa")),
                "regla_id": linea.get("regla_id") or False,
                "precio_visita": linea.get("precio_visita"),
            })
        return limpias

    def _shalom_ev_confirmar_pedido(self, visita, datos, uuid):
        visita = self._shalom_exigir_visita(visita)
        return visita.shalom_confirmar_pedido(
            self._shalom_lineas(datos),
            datos.get("payment_method"),
            datos.get("special_delivery_date") or False,
            bool(datos.get("includes_itbms")),
            precios_visita=True,
        )

    def _shalom_ev_guardar_borrador(self, visita, datos, uuid):
        visita = self._shalom_exigir_visita(visita)
        venta, cambios = visita._shalom_guardar_borrador(self._shalom_lineas(datos), precios_visita=True)
        return {
            "sale_order_id": venta.id,
            "sale_order_name": venta.name,
            "total": venta.amount_total,
            "precios_cambiados": cambios,
        }

    def _shalom_ev_cambiar_etapa(self, visita, datos, uuid):
        visita = self._shalom_exigir_visita(visita)
        etapa = self.env["fsm.stage"].browse(datos.get("stage_id")).exists() if isinstance(datos.get("stage_id"), int) else None
        if not etapa:
            raise UserError(_("Ese estado de visita ya no existe en el sistema."))
        visita.with_context(
            bypass_order_completed_stage=True, shalom_validar_cierre_visita=True
        ).write({"stage_id": etapa.id})
        return {"stage_name": visita.stage_id.name}

    def _shalom_ev_observacion(self, visita, datos, uuid):
        visita = self._shalom_exigir_visita(visita)
        visita.write({"x_observaciones_visita": datos.get("texto") or ""})
        return {}

    def _shalom_ev_gps(self, visita, datos, uuid):
        visita = self._shalom_exigir_visita(visita)
        lat, lng = datos.get("lat"), datos.get("lng")
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            raise UserError(_("Coordenadas GPS inválidas."))
        visita.action_capturar_gps(lat, lng)
        return {}

    def _shalom_ev_descartar_carrito(self, visita, datos, uuid):
        visita = self._shalom_exigir_visita(visita)
        carrito = datos.get("carrito") if isinstance(datos.get("carrito"), dict) else None
        visita.shalom_limpiar_carrito(carrito, uuid)
        return {}

    # -- Clientes creados o editados sin señal --

    def _shalom_ubicacion(self, datos):
        location_id = datos.get("location_id")
        ubicacion = (
            self.env["fsm.location"].browse(location_id).exists()
            if isinstance(location_id, int) and location_id > 0
            else self.env["fsm.location"]
        )
        if not ubicacion:
            raise UserError(_("El cliente ya no existe (¿lo archivaron o borraron desde oficina?)."))
        return ubicacion

    def _shalom_ev_crear_cliente(self, visita, datos, uuid):
        """Alta rápida hecha en el teléfono (con o sin señal). La ruta es
        obligatoria: es la que le crea la visita para hacerle el pedido."""
        route_id = datos.get("route_id")
        if not isinstance(route_id, int) or route_id <= 0:
            raise UserError(_("Elegí la ruta del cliente: es la que le crea la visita para el pedido."))
        Ubicacion = self.env["fsm.location"]
        texto = lambda clave: (datos.get(clave) or "").strip() or False  # noqa: E731
        lat, lng = datos.get("lat"), datos.get("lng")
        creado = Ubicacion.shalom_crear_cliente_rapido(
            datos.get("name") or "",
            texto("phone"),
            texto("street"),
            texto("street2"),
            texto("vat"),
            texto("mobile"),
            texto("email"),
            datos.get("image_1920") or False,
            lat if isinstance(lat, (int, float)) else False,
            lng if isinstance(lng, (int, float)) else False,
            route_id,
            datos.get("cliente_anterior_id") if isinstance(datos.get("cliente_anterior_id"), int) else False,
            texto("nombre_contacto"),
        )
        ubicacion = Ubicacion.browse(creado["id"])
        ciclo, visita_nueva = ubicacion._shalom_visita_en_ocurrencia_activa()
        return {
            "location_id": ubicacion.id,
            "partner_id": creado.get("partner_id"),
            "order_id": visita_nueva.id or False,
            "schedule_id": ciclo.id or False,
            "route_id": route_id,
            "parada": ubicacion.x_orden_ruta or 0,
            "name": ubicacion.name,
        }

    def _shalom_ev_editar_cliente(self, visita, datos, uuid):
        ubicacion = self._shalom_ubicacion(datos)
        valores = datos.get("valores") if isinstance(datos.get("valores"), dict) else {}
        return ubicacion.shalom_guardar_cliente(valores)

    def _shalom_ev_gps_cliente(self, visita, datos, uuid):
        ubicacion = self._shalom_ubicacion(datos)
        lat, lng = datos.get("lat"), datos.get("lng")
        if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
            raise UserError(_("Coordenadas GPS inválidas."))
        ubicacion.shalom_actualizar_gps(lat, lng)
        return {}

    # -- Ids provisorios --

    def _shalom_resolver_temporales(self, datos):
        """Cambia los ids negativos (cliente y visita creados sin señal) por
        los reales, buscando el alta ya procesada de ESTE mismo usuario."""
        cambios = {}
        for campo, clase in (("order_id", "order"), ("location_id", "location"), ("cliente_anterior_id", "location")):
            valor = datos.get(campo)
            if isinstance(valor, int) and valor < 0:
                cambios[campo] = self._shalom_id_real(valor, clase)
        return {**datos, **cambios} if cambios else datos

    def _shalom_id_real(self, provisorio, clase):
        campo = f"tmp_{clase}_id"
        alta = self.sudo().search(
            [("user_id", "=", self.env.user.id), ("tipo", "=", "crear_cliente"), (campo, "=", provisorio)],
            order="id desc",
            limit=1,
        )
        if not alta:
            raise UserError(_("Todavía no llegó el cliente nuevo de esta acción: se reintenta sola."))
        if alta.estado == "procesando":
            raise AltaEnProceso()
        if alta.estado != "ok":
            raise UserError(_("El cliente nuevo de esta acción no se pudo crear. Revisalo primero en 'Necesita atención'."))
        real = (self._shalom_json(alta.resultado_json) or {}).get(f"{clase}_id")
        if not real:
            raise UserError(_("El cliente nuevo no tiene visita en un ciclo en curso de su ruta: no se le puede cargar esto."))
        return real

    @staticmethod
    def _shalom_sin_foto(datos):
        """Para el registro: la foto (pesada) no se copia."""
        if not isinstance(datos, dict):
            return datos
        copia = dict(datos)
        if copia.get("image_1920"):
            copia["image_1920"] = "[foto]"
        valores = copia.get("valores")
        if isinstance(valores, dict) and valores.get("image_1920"):
            copia["valores"] = {**valores, "image_1920": "[foto]"}
        return copia

    # ------------------------------------------------------------------
    # Administración → Registro (envíos con aviso)
    # ------------------------------------------------------------------

    @api.model
    def shalom_admin_envios_con_aviso(self):
        """Envíos de la calle de los últimos días que oficina debe mirar:
        los que quedaron con error y los pedidos donde se respetó un
        precio de la visita distinto del vigente."""
        self.env["fsm.order"]._shalom_verificar_admin()
        limite = fields.Datetime.now() - timedelta(days=offline_utils.DIAS_RETENCION_REGISTRO)
        eventos = self.search([
            ("recibido_en", ">=", limite),
            "|", ("estado", "=", "error"), ("precio_cambiado", "=", True),
        ], limit=200)
        etiquetas = {
            "confirmar_pedido": _("Confirmar pedido"),
            "guardar_borrador": _("Guardar cotización"),
            "cambiar_etapa": _("Cambiar estado"),
            "observacion": _("Nota"),
            "gps": _("GPS"),
            "descartar_carrito": _("Descartar carrito"),
            "crear_cliente": _("Crear cliente"),
            "editar_cliente": _("Editar cliente"),
            "gps_cliente": _("GPS del cliente"),
        }
        resultado = []
        for ev in eventos:
            visita = ev.order_id
            datos = self._shalom_json(ev.resultado_json) or {}
            resultado.append({
                "id": ev.id,
                "tipo": etiquetas.get(ev.tipo, ev.tipo),
                "estado": ev.estado,
                "error": ev.error or "",
                "recibido_en": fields.Datetime.to_string(ev.recibido_en),
                "creado_en_telefono": fields.Datetime.to_string(ev.creado_en_telefono) if ev.creado_en_telefono else False,
                "usuario_nombre": ev.user_id.name or "",
                "cliente_nombre": visita.location_id.name if visita and visita.location_id else "",
                "precios_cambiados": datos.get("precios_cambiados") or [] if isinstance(datos, dict) else [],
                "sale_order_name": datos.get("sale_order_name") or "" if isinstance(datos, dict) else "",
            })
        return resultado

    # ------------------------------------------------------------------
    # Utilidades
    # ------------------------------------------------------------------

    @staticmethod
    def _shalom_json(texto):
        try:
            return json.loads(texto) if texto else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _shalom_fecha(valor):
        """'YYYY-MM-DDTHH:MM:SS(.sss)Z' del teléfono -> datetime UTC naive, o False."""
        if not isinstance(valor, str) or len(valor) < 19:
            return False
        try:
            return fields.Datetime.to_datetime(valor[:19].replace("T", " "))
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _shalom_mensaje_error(error):
        mensaje = getattr(error, "args", None) and error.args[0]
        return str(mensaje or error)[:1000]

    @api.model
    def _shalom_limpiar_sync_viejo(self):
        limite = fields.Datetime.now() - timedelta(days=offline_utils.DIAS_RETENCION_SYNC)
        viejos = self.sudo().search([("recibido_en", "<", limite)])
        if viejos:
            viejos.unlink()
