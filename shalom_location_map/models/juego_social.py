# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Fase 6A del juego de ventas de Ruta Shalom: tutorial de bienvenida,
logros/misiones, equipo cooperativo del mes y temporada del mes.

Todo vive aquí (y no en shalom_juego.py / fsm_person.py) para no mezclar
esta fase con el resto: extiende `shalom.juego.evento` y `fsm.person` con
`_inherit` y agrega un modelo propio, `shalom.juego.logro`.

Reglas de producto: juego COOPERATIVO (no hay ranking ni comparación entre
vendedores), sin azar, un pedido malo nunca bloquea nada, el nivel nunca
baja y la temporada reinicia cada mes.

Seguridad: el vendedor normal (fieldservice.group_fsm_user) no puede leer
ni escribir estos modelos directamente (el libro trae la utilidad); lo
único que llama son los métodos `shalom_*` de abajo, que usan sudo para
leer/escribir y NUNCA devuelven costo ni utilidad en dólares.

Logros e idempotencia: cada logro ganado es UNA fila de shalom.juego.logro
con restricción única (vendedor, código). Otorgar un logro es "crear la
fila si no existe", así que llamar dos veces no duplica el XP. El XP de
los logros se suma al XP total/mensual en `_shalom_progreso_de` (nivel) y
en la temporada.

Cuándo se otorgan: NO al confirmar el pedido, sino al llamar a
`shalom_mis_logros()` (la app lo hace al abrir Rutas y el panel de
Logros). Así la confirmación del pedido queda exactamente como antes
(solo guarda las banderas con_tinte/con_oxigenta) y el resultado
("juego") y su progreso no cambian de contrato; el XP de los logros
aparece en el nivel en cuanto la app los recoge.
"""
import logging
from datetime import timedelta

from odoo import api, fields, models

from . import juego_utils, tz_utils

_logger = logging.getLogger(__name__)

PARAM_PISO = "shalom.juego.piso_mes"
PARAM_META = "shalom.juego.meta_mes"
PARAM_CAMION = "shalom.juego.camion_dia"
PARAM_PREMIOS = "shalom.juego.premios_temporada"

MESES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
]
ESTADOS_VENTA_CONFIRMADA = ("sale", "done")


class ShalomJuegoLogro(models.Model):
    _name = "shalom.juego.logro"
    _description = "Logro ganado por un vendedor (una fila por vendedor y logro)"
    _order = "fecha desc, id desc"

    person_id = fields.Many2one("fsm.person", string="Vendedor", required=True, index=True, ondelete="cascade")
    codigo = fields.Char(required=True, index=True)
    fecha = fields.Datetime(default=fields.Datetime.now, index=True)
    xp = fields.Integer(help="XP que dio el logro al ganarse (se congela al ganarlo).")

    _sql_constraints = [
        (
            "persona_codigo_uniq",
            "unique(person_id, codigo)",
            "Ese logro ya está ganado por ese vendedor.",
        ),
    ]


class FSMPersonJuegoSocial(models.Model):
    _inherit = "fsm.person"

    x_tutorial_visto = fields.Boolean(
        string="Vio el tutorial de Ruta Shalom",
        default=False,
        help="Se marca al terminar o saltar el tutorial de bienvenida; "
        "mientras esté apagado, la app lo muestra al abrir Rutas.",
    )


class ShalomJuegoEventoSocial(models.Model):
    _inherit = "shalom.juego.evento"

    # Qué llevaba el pedido (se calcula al registrar el resultado; los
    # eventos anteriores a esta fase quedan en False).
    con_tinte = fields.Boolean()
    con_oxigenta = fields.Boolean()

    # ------------------------------------------------------------------
    # XP: los logros suman al total (y por tanto al nivel)
    # ------------------------------------------------------------------
    @api.model
    def _shalom_progreso_de(self, person):
        progreso = super()._shalom_progreso_de(person)
        extra = self._shalom_xp_logros(person)
        if extra:
            xp_total = progreso["xp_total"] + extra
            numero, nombre, desde, siguiente = juego_utils.nivel_de_xp(xp_total)
            progreso.update(
                {
                    "xp_total": xp_total,
                    "nivel": numero,
                    "nivel_nombre": nombre,
                    "xp_nivel": desde,
                    "xp_siguiente": siguiente,
                }
            )
        return progreso

    @api.model
    def _shalom_xp_logros(self, person, desde=None):
        """XP de los logros de un vendedor (opcionalmente desde una fecha UTC)."""
        if not person:
            return 0
        dominio = [("person_id", "=", person.id)]
        if desde:
            dominio.append(("fecha", ">=", desde))
        grupo = self.env["shalom.juego.logro"].sudo().read_group(dominio, ["xp:sum"], [])
        return int(grupo[0]["xp"] or 0) if grupo else 0

    # ------------------------------------------------------------------
    # Banderas del pedido (para "El Químico")
    # ------------------------------------------------------------------
    @api.model
    def _shalom_banderas_pedido(self, sale_order):
        """{"con_tinte", "con_oxigenta"} de un sale.order. A prueba de
        fallos: ante cualquier error devuelve {} (el evento se registra
        igual, sin banderas)."""
        try:
            productos = [
                (linea.product_id.sudo().name or "", linea.product_id.sudo().categ_id.name or "")
                for linea in sale_order.order_line
                if not linea.display_type and linea.product_id and linea.product_uom_qty > 0
            ]
            con_tinte, con_oxigenta = juego_utils.pedido_con_tinte_y_oxigenta(productos)
            return {"con_tinte": con_tinte, "con_oxigenta": con_oxigenta}
        except Exception:  # noqa: BLE001 -- jamás romper la confirmación
            _logger.exception("No se pudieron calcular las banderas del pedido %s", sale_order.id)
            return {}

    # ------------------------------------------------------------------
    # Logros
    # ------------------------------------------------------------------
    @api.model
    def _shalom_stats_logros(self, persona):
        """Estadísticas del vendedor para el catálogo de logros."""
        eventos = self.sudo().search_read(
            [("person_id", "=", persona.id)],
            ["order_id", "estrellas", "record_roto", "total", "con_tinte", "con_oxigenta"],
            order="fecha asc, id asc",
            load="",
        )
        ids_visita = [e["order_id"] for e in eventos if e["order_id"]]
        ruta_de = {}
        if ids_visita:
            visitas = self.env["fsm.order"].sudo().with_context(active_test=False).browse(ids_visita).exists()
            for visita in visitas:
                ruta_de[visita.id] = visita.fsm_route_id.id
        progreso = self._shalom_progreso_de(persona)
        return {
            "n_pedidos": len(eventos),
            "n_quimico": sum(1 for e in eventos if e["con_tinte"] and e["con_oxigenta"]),
            "mejor_racha": juego_utils.racha_mas_larga([ruta_de.get(e["order_id"]) for e in eventos]),
            "max_estrellas": max([e["estrellas"] for e in eventos] or [0]),
            "hay_record": any(e["record_roto"] for e in eventos),
            "mayor_pedido": max([e["total"] for e in eventos] or [0.0]),
            "xp_total": progreso["xp_total"],
        }

    @api.model
    def _shalom_otorgar_logros(self, persona):
        """Crea la fila de cada logro ya completo que el vendedor todavía
        no tiene. IDEMPOTENTE (restricción única + comprobación previa) y
        a prueba de fallos: devuelve la lista de logros NUEVOS
        [{"codigo", "nombre", "xp"}], o [] ante cualquier error (nunca
        rompe quien la llama, p. ej. la confirmación de un pedido).

        Se repite mientras salgan logros nuevos porque el XP de un logro
        puede completar otro (p. ej. "Nivel 2")."""
        if not persona:
            return []
        nuevos = []
        try:
            Logro = self.env["shalom.juego.logro"].sudo()
            with self.env.cr.savepoint():
                for _pasada in range(len(juego_utils.LOGROS) + 1):
                    ganados = set(Logro.search([("person_id", "=", persona.id)]).mapped("codigo"))
                    estado = juego_utils.estado_logros(self._shalom_stats_logros(persona))
                    pendientes = [l for l in estado if l["completo"] and l["codigo"] not in ganados]
                    if not pendientes:
                        break
                    for logro in pendientes:
                        Logro.create({"person_id": persona.id, "codigo": logro["codigo"], "xp": logro["xp"]})
                        nuevos.append({"codigo": logro["codigo"], "nombre": logro["nombre"], "xp": logro["xp"]})
        except Exception:  # noqa: BLE001 -- jamás romper al llamador
            _logger.exception("No se pudieron otorgar los logros de la persona %s", persona.id)
            return []
        return nuevos

    @api.model
    def shalom_mis_logros(self):
        """Logros del vendedor logueado con su progreso y si están
        completos. Sin fsm.person vinculado devuelve None.

        {"logros": [{codigo, nombre, descripcion, xp, meta, progreso,
        completo, bienvenida, fecha, hoy}], "completos", "total",
        "nuevos_mes", "nuevos_hoy", "xp_logros"}"""
        persona = self.env["fsm.person"]._shalom_persona_actual()
        if not persona:
            return None
        self._shalom_otorgar_logros(persona)
        ganados = {
            l.codigo: l
            for l in self.env["shalom.juego.logro"].sudo().search([("person_id", "=", persona.id)])
        }
        estado = juego_utils.estado_logros(self._shalom_stats_logros(persona))
        hoy = tz_utils.hoy_local(self.env)
        logros = []
        for logro in estado:
            fila = ganados.get(logro["codigo"])
            fecha_local = tz_utils.a_local(self.env, fila.fecha).date() if fila else None
            logro = dict(logro)
            if fila:  # lo ganado no se pierde aunque el progreso se recalcule
                logro["completo"] = True
                logro["progreso"] = logro["meta"]
            logro["fecha"] = fecha_local.isoformat() if fecha_local else False
            logro["hoy"] = bool(fecha_local and fecha_local == hoy)
            logros.append(logro)
        return {
            "logros": logros,
            "completos": sum(1 for l in logros if l["completo"]),
            "total": len(logros),
            "nuevos_mes": sum(
                1 for l in logros if l["fecha"] and l["fecha"][:7] == hoy.isoformat()[:7]
            ),
            "nuevos_hoy": sum(1 for l in logros if l["hoy"]),
            "xp_logros": sum(f.xp for f in ganados.values()),
        }

    # ------------------------------------------------------------------
    # Tutorial
    # ------------------------------------------------------------------
    @api.model
    def _shalom_estado_tutorial(self, persona):
        """{"disponible", "visto", "mostrar", "nombre"}. Sin persona no hay
        tutorial que mostrar (visto=True para que ninguna pantalla lo pida)."""
        if not persona:
            return {"disponible": False, "visto": True, "mostrar": False, "nombre": ""}
        visto = bool(persona.sudo().x_tutorial_visto)
        return {
            "disponible": True,
            "visto": visto,
            "mostrar": not visto,
            "nombre": persona.sudo().name or "",
        }

    @api.model
    def shalom_tutorial_estado(self):
        """Estado del tutorial del vendedor logueado (ver
        _shalom_estado_tutorial). "nombre" es el de su fsm.person, para el
        saludo de la bienvenida."""
        return self._shalom_estado_tutorial(self.env["fsm.person"]._shalom_persona_actual())

    @api.model
    def shalom_tutorial_terminar(self):
        """Marca el tutorial como visto (al terminarlo o saltarlo). Cada
        vendedor solo toca el suyo. Idempotente."""
        persona = self.env["fsm.person"]._shalom_persona_actual()
        if persona and not persona.sudo().x_tutorial_visto:
            persona.sudo().write({"x_tutorial_visto": True})
        return self._shalom_estado_tutorial(persona)

    # ------------------------------------------------------------------
    # Equipo del mes
    # ------------------------------------------------------------------
    @api.model
    def _shalom_param_numero(self, clave, defecto=None):
        """ir.config_parameter numérico > 0, o `defecto` si falta/es inválido."""
        crudo = self.env["ir.config_parameter"].sudo().get_param(clave)
        try:
            valor = float(crudo)
        except (TypeError, ValueError):
            return defecto
        return valor if valor > 0 else defecto

    @api.model
    def _shalom_ventas_entre(self, desde_utc, hasta_utc, companias):
        """Venta sin impuestos de los pedidos confirmados en [desde, hasta)."""
        grupo = self.env["sale.order"].sudo().read_group(
            [
                ("state", "in", list(ESTADOS_VENTA_CONFIRMADA)),
                ("date_order", ">=", desde_utc),
                ("date_order", "<", hasta_utc),
                ("company_id", "in", companias),
            ],
            ["amount_untaxed:sum"],
            [],
        )
        return float(grupo[0]["amount_untaxed"] or 0.0) if grupo else 0.0

    @api.model
    def shalom_equipo_mes(self):
        """Estado del EQUIPO en el mes: ventas confirmadas del mes (sin
        impuestos, hora de Panamá), piso y meta (ir.config_parameter
        `shalom.juego.piso_mes` / `shalom.juego.meta_mes`, por defecto
        60,000 / 80,000), ritmo por día hábil y, solo si existe
        `shalom.juego.camion_dia`, el camión del día. Es del equipo
        completo: NO hay ranking ni comparación entre vendedores. Sin
        fsm.person vinculado devuelve None."""
        persona = self.env["fsm.person"]._shalom_persona_actual()
        if not persona:
            return None
        companias = self.env.companies.ids  # antes de pasar a sudo
        piso = self._shalom_param_numero(PARAM_PISO, juego_utils.PISO_MES_DEFECTO)
        meta = self._shalom_param_numero(PARAM_META, juego_utils.META_MES_DEFECTO)
        hoy = tz_utils.hoy_local(self.env)
        primero = hoy.replace(day=1)
        siguiente_mes = (primero + timedelta(days=32)).replace(day=1)
        ventas = self._shalom_ventas_entre(
            tz_utils.inicio_de_dia_utc(self.env, primero),
            tz_utils.inicio_de_dia_utc(self.env, siguiente_mes),
            companias,
        )
        resultado = {
            "mes": hoy.month,
            "mes_nombre": MESES[hoy.month - 1],
            "anio": hoy.year,
            "ventas": round(ventas, 2),
            "piso": piso,
            "meta": meta,
            "camion": None,
        }
        resultado.update(juego_utils.ritmo_equipo(ventas, piso, meta, hoy))
        meta_camion = self._shalom_param_numero(PARAM_CAMION)
        if meta_camion:
            vendido_hoy = self._shalom_ventas_entre(
                tz_utils.inicio_de_dia_utc(self.env, hoy),
                tz_utils.inicio_de_dia_utc(self.env, hoy + timedelta(days=1)),
                companias,
            )
            resultado["camion"] = juego_utils.camion_del_dia(vendido_hoy, meta_camion)
        return resultado

    # ------------------------------------------------------------------
    # Temporada del mes
    # ------------------------------------------------------------------
    @api.model
    def shalom_temporada(self):
        """Temporada del mes del vendedor logueado: XP y estrellas del mes,
        nivel de temporada por hitos de XP del mes y premios (texto del
        dueño en `shalom.juego.premios_temporada`, JSON; vacío = sin
        premios). Reinicia cada mes. Sin fsm.person devuelve None."""
        persona = self.env["fsm.person"]._shalom_persona_actual()
        if not persona:
            return None
        hoy = tz_utils.hoy_local(self.env)
        primero = hoy.replace(day=1)
        desde = tz_utils.inicio_de_dia_utc(self.env, primero)
        eventos = self.sudo().search([("person_id", "=", persona.id), ("fecha", ">=", desde)])
        xp_mes = sum(eventos.mapped("xp")) + self._shalom_xp_logros(persona, desde)
        nivel, hitos = juego_utils.hitos_temporada(xp_mes)
        premios = juego_utils.premios_de_texto(
            self.env["ir.config_parameter"].sudo().get_param(PARAM_PREMIOS)
        )
        for hito in hitos:
            hito["premio"] = premios.get(hito["nivel"], False)
        proximo = next((h for h in hitos if h["actual"]), None)
        fin_mes = (primero + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        return {
            "mes": hoy.month,
            "mes_nombre": MESES[hoy.month - 1],
            "anio": hoy.year,
            "xp_mes": xp_mes,
            "estrellas_mes": sum(eventos.mapped("estrellas")),
            "pedidos_mes": len(eventos),
            "nivel_temporada": nivel,
            "niveles_total": len(hitos),
            "hitos": hitos,
            "proximo": {"nivel": proximo["nivel"], "xp": proximo["xp"], "faltan": proximo["xp"] - xp_mes}
            if proximo
            else None,
            "hay_premios": bool(premios),
            "dias_restantes_mes": (fin_mes - hoy).days,
            "bono_quincena": {
                "activo": hoy.day <= juego_utils.DIA_FIN_PRIMERA_QUINCENA,
                "multiplicador": juego_utils.MULTIPLICADOR_PRIMERA_QUINCENA,
                "dias_restantes": juego_utils.dias_quincena_restantes(hoy),
            },
        }
