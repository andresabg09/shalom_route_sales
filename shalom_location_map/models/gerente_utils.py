# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Cálculos PUROS (sin Odoo, sin base de datos) de la vista del gerente de
Ruta Shalom: avance del mes contra piso y meta, margen, oxigenta por cada
100 tintes, reparto de rutas entre vendedores y cobertura del GPS
prioritario. Viven aparte de los modelos para probarlos fuera de Odoo
(ver tools/test_gerente_utils.py), igual que juego_utils.py.

Las reglas salen de los diseños aprobados (Gerente.dc.html y
GpsAdmin.dc.html) y del plan (Fase 7 de
docs/plan_implementacion_ruta_juego.md).
"""
import unicodedata
from datetime import date

from . import juego_utils

# Metas del mes (ir.config_parameter shalom.juego.piso_mes / meta_mes).
PISO_MES_DEFECTO = 60000.0
META_MES_DEFECTO = 80000.0

# Cuánto valor esperado se vende en un día de trabajo: es el mismo
# mínimo de las carteras diarias (juego_utils.MINIMO_CARTERA). Con él se
# estima cuántos días de venta pide una ruta ($25.3k / $2,000 = 12.7 días).
VALOR_POR_DIA = juego_utils.MINIMO_CARTERA

# Cuántos clientes entran a la lista "primeros N" del GPS prioritario.
N_GPS_PRIORITARIO = 30

# Tope de filas del GPS prioritario que se mandan a la pantalla.
TOPE_GPS_LISTA = 300


def _normalizar(texto):
    """Minúsculas y sin tildes: 'Oxigenta' == 'OXIGENTA' == 'oxigentá'."""
    sin_tildes = unicodedata.normalize("NFD", texto or "")
    return "".join(c for c in sin_tildes if unicodedata.category(c) != "Mn").lower()


def clasificar_producto(nombre):
    """'oxigenta' si el nombre dice oxigenta, 'tinte' si dice tinte, o
    None. Insensible a mayúsculas y tildes. Si dice las dos cosas (un
    kit 'Tinte + Oxigenta') cuenta como oxigenta: el kit se mide por lo
    que lleva de oxigenta, y el tinte suelto es el que va al
    denominador."""
    n = _normalizar(nombre)
    if "oxigenta" in n:
        return "oxigenta"
    if "tinte" in n:
        return "tinte"
    return None


def oxigenta_por_100_tintes(pedidos):
    """Unidades de oxigenta por cada 100 unidades de tinte.

    pedidos: iterable de pedidos, cada uno una lista de (nombre del
    producto, cantidad). Devuelve:

    - tintes / oxigenta: unidades totales de cada una.
    - por_100: oxigenta * 100 / tintes (None si no se vendió tinte).
    - pedidos_con_oxigenta: pedidos que llevan oxigenta.
    - por_100_en_pedidos_con_oxigenta: la misma razón, mirando solo los
      pedidos que llevan oxigenta (None si esos pedidos no llevan
      tinte): dice cuánta oxigenta se pide cuando sí se la piden."""
    tintes = oxigenta = 0.0
    tintes_con = oxigenta_con = 0.0
    n_con = 0
    for lineas in pedidos:
        t = o = 0.0
        for nombre, cantidad in lineas:
            clase = clasificar_producto(nombre)
            if clase == "tinte":
                t += cantidad
            elif clase == "oxigenta":
                o += cantidad
        tintes += t
        oxigenta += o
        if o > 0:
            n_con += 1
            tintes_con += t
            oxigenta_con += o
    return {
        "tintes": round(tintes, 2),
        "oxigenta": round(oxigenta, 2),
        "por_100": round(oxigenta * 100.0 / tintes, 1) if tintes > 0 else None,
        "pedidos_con_oxigenta": n_con,
        "por_100_en_pedidos_con_oxigenta": (
            round(oxigenta_con * 100.0 / tintes_con, 1) if tintes_con > 0 else None
        ),
    }


def parametro_numero(valor, defecto):
    """Número de un ir.config_parameter (texto, a veces vacío o con
    basura): el defecto si no se puede leer o no es positivo."""
    try:
        numero = float(str(valor).replace(",", "").strip())
    except (TypeError, ValueError):
        return float(defecto)
    return numero if numero > 0 else float(defecto)


def limites_mes(hoy):
    """(primer día del mes de `hoy`, primer día del mes siguiente)."""
    inicio = hoy.replace(day=1)
    if inicio.month == 12:
        return inicio, date(inicio.year + 1, 1, 1)
    return inicio, date(inicio.year, inicio.month + 1, 1)


def avance_mes(ventas, piso, meta):
    """Avance de las ventas del mes contra el piso y la meta: % de cada
    uno (puede pasar de 100) y lo que falta (0 si ya se llegó)."""
    return {
        "pct_piso": round(ventas * 100.0 / piso, 1) if piso else None,
        "pct_meta": round(ventas * 100.0 / meta, 1) if meta else None,
        "falta_piso": round(max(piso - ventas, 0.0), 2),
        "falta_meta": round(max(meta - ventas, 0.0), 2),
    }


def margen_pct(utilidad, neto):
    """Utilidad como % de la venta sin impuestos (None si no hay venta)."""
    if not neto:
        return None
    return round(utilidad * 100.0 / neto, 1)


def es_cliente_bueno(clase):
    """Compra lo suficiente para entrar a una cartera (A, A2, B, B2)."""
    return clase in juego_utils.CLASES_CARTERA


def dias_estimados(valor, por_dia=VALOR_POR_DIA):
    """Días de venta que pide un valor esperado, a `por_dia` por día."""
    if not por_dia or valor <= 0:
        return 0.0
    return round(valor / por_dia, 1)


def armar_reparto(rutas, por_dia=VALOR_POR_DIA):
    """Agrupa las rutas por vendedor para la tarjeta "Reparto de rutas".

    rutas: [{"id", "name", "person_id", "person_name", "valor",
    "clientes", "dias_ciclo"}] (valor = valor esperado MENSUAL de los
    clientes buenos de la ruta).

    Devuelve:
    - vendedores: [{"persona_id", "persona_nombre", "valor_mes", "dias",
      "clientes", "dias_ciclo", "rutas": [...]}] por nombre. Solo cuentan
      las rutas con dueño y con valor > 0.
    - sin_dueno_o_ventas: las rutas sin dueño o con valor 0, con su
      "motivo" ("sin_dueno" o "sin_ventas"), por valor y nombre.
    - total_mes: suma del valor de las rutas que sí están repartidas."""
    por_persona = {}
    aparte = []
    for ruta in rutas:
        valor = round(ruta.get("valor") or 0.0, 2)
        fila = {
            "id": ruta["id"],
            "name": ruta["name"],
            "valor": valor,
            "clientes": ruta.get("clientes") or 0,
            "dias": dias_estimados(valor, por_dia),
            "dias_ciclo": ruta.get("dias_ciclo") or 0,
            "persona_id": ruta.get("person_id") or False,
            "persona_nombre": ruta.get("person_name") or "",
        }
        if not ruta.get("person_id") or valor <= 0:
            fila["motivo"] = "sin_dueno" if not ruta.get("person_id") else "sin_ventas"
            aparte.append(fila)
            continue
        v = por_persona.setdefault(
            ruta["person_id"],
            {
                "persona_id": ruta["person_id"],
                "persona_nombre": ruta.get("person_name") or "",
                "valor_mes": 0.0,
                "clientes": 0,
                "dias_ciclo": 0,
                "rutas": [],
            },
        )
        v["valor_mes"] += valor
        v["clientes"] += fila["clientes"]
        v["dias_ciclo"] += fila["dias_ciclo"]
        v["rutas"].append(fila)
    vendedores = []
    for v in por_persona.values():
        v["valor_mes"] = round(v["valor_mes"], 2)
        v["dias"] = dias_estimados(v["valor_mes"], por_dia)
        v["rutas"].sort(key=lambda r: (-r["valor"], r["name"].lower()))
        vendedores.append(v)
    vendedores.sort(key=lambda v: v["persona_nombre"].lower())
    aparte.sort(key=lambda r: (-r["valor"], r["name"].lower()))
    return {
        "vendedores": vendedores,
        "sin_dueno_o_ventas": aparte,
        "total_mes": round(sum(v["valor_mes"] for v in vendedores), 2),
    }


def cobertura_primeros(valores, n=N_GPS_PRIORITARIO):
    """% del valor total de `valores` que cubren los `n` más grandes
    (con los primeros 30 se cubre el 70% de lo que falta). 0 si no hay
    valor."""
    ordenados = sorted((v for v in valores if v and v > 0), reverse=True)
    total = sum(ordenados)
    if total <= 0:
        return 0.0
    return round(sum(ordenados[:n]) * 100.0 / total, 1)


def ordenar_gps_prioritario(filas, tope=TOPE_GPS_LISTA):
    """Clientes buenos sin GPS por valor esperado descendente (empate:
    nombre), recortados a `tope`."""
    return sorted(filas, key=lambda f: (-f["valor"], (f["name"] or "").lower(), f["id"]))[:tope]
