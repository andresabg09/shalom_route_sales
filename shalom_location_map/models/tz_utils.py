# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Fechas "de hoy" en la hora local del vendedor para el juego (día del mes
para el x1.5 de XP, inicio de mes del resumen, días sin comprar...).

Odoo guarda las fechas en UTC y fields.Date.context_today usa la zona del
contexto o del usuario, y UTC si no tiene ninguna: en Panamá (UTC-5), un
pedido de las 7:30 pm del día 15 contaría como día 16. Aquí, si el usuario
no tiene zona, se usa America/Panama.
"""
from datetime import datetime, time

import pytz

from odoo import fields

TZ_DEFECTO = "America/Panama"


def zona(env):
    return pytz.timezone(env.context.get("tz") or env.user.tz or TZ_DEFECTO)


def a_local(env, dt_utc):
    """datetime naive en UTC (como guarda Odoo) -> datetime local con zona."""
    return pytz.utc.localize(dt_utc).astimezone(zona(env))


def hoy_local(env):
    """date de hoy en la hora local del usuario."""
    return a_local(env, fields.Datetime.now()).date()


def inicio_de_dia_utc(env, dia):
    """Medianoche local de `dia` (date), como datetime naive en UTC."""
    local = zona(env).localize(datetime.combine(dia, time.min))
    return local.astimezone(pytz.utc).replace(tzinfo=None)
