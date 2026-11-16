# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""Reglas puras (sin Odoo) del modo offline y del registro de carritos
descartados. Se prueban con `python3 tools/test_offline_utils.py`."""
import json

# Días que se guarda un carrito descartado en Administración → Registro
# (decisión del usuario: una semana).
DIAS_RETENCION_REGISTRO = 7

# Monto desde el que un carrito descartado sale destacado y avisa a
# oficina. Se puede cambiar sin tocar código con el parámetro del
# sistema "shalom.registro_umbral_aviso".
UMBRAL_AVISO_DEFAULT = 100.0

# Días que se guarda el libro de eventos sincronizados (idempotencia de
# la cola offline). Pasado ese plazo un reenvío del mismo evento ya no
# es realista: el teléfono lo borra de su cola apenas recibe el "ok".
DIAS_RETENCION_SYNC = 30

# Tolerancia para decir que un precio "cambió" (centavo y medio).
TOLERANCIA_PRECIO = 0.005


def _numero(valor, por_defecto=0.0):
    try:
        return float(valor)
    except (TypeError, ValueError):
        return por_defecto


def carrito_desde_json(texto):
    """dict del carrito a partir del JSON guardado; tolera vacío/corrupto."""
    if not texto:
        return {}
    try:
        datos = json.loads(texto)
    except (TypeError, ValueError):
        return {}
    return datos if isinstance(datos, dict) else {}


def resumen_carrito(carrito):
    """(cantidad_items, total, lineas) de un carrito con el formato de
    x_carrito_borrador: {clave: {product_id, name, list_price, cantidad,
    es_recompensa, regla_id}}. Las recompensas cuentan como ítem pero no
    suman al total. Las claves sin cantidad positiva se ignoran."""
    lineas = []
    cantidad_items = 0.0
    total = 0.0
    for clave, item in (carrito or {}).items():
        if not isinstance(item, dict):
            continue
        cantidad = _numero(item.get("cantidad"))
        if cantidad <= 0:
            continue
        precio = _numero(item.get("list_price"))
        es_recompensa = bool(item.get("es_recompensa"))
        cantidad_items += cantidad
        if not es_recompensa:
            total += cantidad * precio
        lineas.append({
            "clave": str(clave),
            "product_id": item.get("product_id") or False,
            "nombre": item.get("name") or "",
            "cantidad": cantidad,
            "precio": precio,
            "es_recompensa": es_recompensa,
            "regla_id": item.get("regla_id") or False,
        })
    lineas.sort(key=lambda linea: (linea["es_recompensa"], linea["nombre"]))
    return cantidad_items, round(total, 2), lineas


def es_destacado(total, umbral):
    """True si el carrito descartado debe avisar a oficina."""
    return _numero(total) >= _numero(umbral, UMBRAL_AVISO_DEFAULT)


def precio_cambio(visto, actual):
    """True si el precio que vio el vendedor en la visita es distinto
    del vigente (más allá de redondeos)."""
    if visto is None or visto is False:
        return False
    return abs(_numero(visto) - _numero(actual)) > TOLERANCIA_PRECIO


def lineas_cambiadas(lineas, precios_actuales):
    """Lista de (product_id, visto, actual) de las líneas pagas cuyo
    precio de lista cambió entre la visita y el envío.

    lineas: [{product_id, precio_visita, es_recompensa, ...}]
    precios_actuales: {product_id: precio de lista vigente}"""
    cambiadas = []
    for linea in lineas or []:
        if linea.get("es_recompensa"):
            continue
        pid = linea.get("product_id")
        if pid not in precios_actuales:
            continue
        visto = linea.get("precio_visita")
        if precio_cambio(visto, precios_actuales[pid]):
            cambiadas.append((pid, _numero(visto), _numero(precios_actuales[pid])))
    return cambiadas
