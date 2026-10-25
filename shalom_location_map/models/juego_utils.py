# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Reglas del juego de ventas de Ruta Shalom como funciones PURAS (sin
Odoo, sin base de datos): estrellas por cliente, clase de cliente, valor
esperado, XP y nivel. Viven acá, aparte de los modelos, para poder
probarlas con datos reales fuera de Odoo (ver tools/test_juego_utils.py)
-- el entorno local no tiene el stack OCA de Field Service.

Las reglas salen de docs/plan_implementacion_ruta_juego.md y del
prototipo aprobado; los números marcados "propuesta" son los que el
dueño ajusta.
"""

# Pedidos de relleno: menos de este % del récord del cliente. No cuentan
# para su ticket típico (dos compras de $53 no bajan la vara de un cliente
# de $4,000).
UMBRAL_RELLENO = 0.15
# Bronce / plata = % del ticket típico.
PORCENTAJE_BRONCE = 0.75
# El oro exige superar el récord Y este margen mínimo (%).
MARGEN_MINIMO_ORO = 20.0

# Clasificación de cliente (misma que el análisis de ventas): dormido =
# más de 6 meses sin comprar; buen cliente = ticket >= $150 y margen
# >= 20%.
DIAS_DORMIDO = 180
TICKET_BUEN_CLIENTE = 150.0
MARGEN_BUEN_CLIENTE = 20.0

# Cuánto compran de verdad al visitarlos (medido en las ventas reales).
# B2 no se midió por separado: se trata como B.
CONVERSION = {
    "A": 0.81,
    "A2": 0.92,
    "B": 0.89,
    "B2": 0.89,
    "C": 0.14,
    "NUEVO": 0.09,
}

# XP por utilidad bruta (propuesta): 1 XP por $1, x1.5 los días 1-15
# del mes (lo que se toma antes de la mitad se entrega y cobra en el
# mismo mes) y un bono fijo por estrella.
XP_POR_DOLAR = 1.0
MULTIPLICADOR_PRIMERA_QUINCENA = 1.5
DIA_FIN_PRIMERA_QUINCENA = 15
BONO_ESTRELLA = {0: 0, 1: 25, 2: 60, 3: 150}

# XP acumulado mínimo de cada nivel (propuesta). El nivel 2 arranca en
# 600 XP, como en el tutorial.
NIVELES = [
    (1, "Novato", 0),
    (2, "Explorador", 600),
    (3, "Vendedor de ruta", 1800),
    (4, "Estratega", 3600),
    (5, "Capitán", 6000),
    (6, "Comandante", 9000),
    (7, "Maestro de ruta", 13000),
    (8, "Leyenda", 18000),
]


def referencias_estrellas(totales):
    """Vara de un cliente a partir de los montos de sus pedidos
    confirmados (lista de números).

    Devuelve {"n", "record", "tipico", "t75", "t100"}. El típico es el
    promedio de los pedidos normales (se excluyen los de relleno,
    < 15% del récord). Sin pedidos: todo en 0 (cliente sin vara)."""
    totales = [float(t) for t in totales if t and t > 0]
    if not totales:
        return {"n": 0, "record": 0.0, "tipico": 0.0, "t75": 0.0, "t100": 0.0}
    record = max(totales)
    normales = [t for t in totales if t >= UMBRAL_RELLENO * record]
    tipico = sum(normales) / len(normales)
    return {
        "n": len(totales),
        "record": round(record, 2),
        "tipico": round(tipico, 2),
        "t75": round(PORCENTAJE_BRONCE * tipico, 2),
        "t100": round(tipico, 2),
    }


def estrellas(total, refs, margen_pct):
    """0-3 estrellas del pedido contra la vara del cliente. Sin
    historial (refs["n"] == 0) no hay vara: 0 estrellas."""
    if not refs or not refs.get("n"):
        return 0
    total = round(total, 2)
    n = 0
    if total >= refs["t75"]:
        n = 1
    if total >= refs["t100"]:
        n = 2
    if total > refs["record"] and margen_pct >= MARGEN_MINIMO_ORO:
        n = 3
    return n


def siguiente_objetivo(total, refs, margen_pct):
    """Qué falta para la próxima estrella: {"estrellas", "objetivo",
    "faltan", "margen_bajo"} o None si ya tiene las 3 / no hay vara.
    "margen_bajo": ya superó el récord pero el margen no llega al 20%
    (el oro no cuenta)."""
    if not refs or not refs.get("n"):
        return None
    actual = estrellas(total, refs, margen_pct)
    if actual >= 3:
        return None
    if actual == 0:
        objetivo, sig = refs["t75"], 1
    elif actual == 1:
        objetivo, sig = refs["t100"], 2
    else:
        objetivo, sig = round(refs["record"] + 0.01, 2), 3
    return {
        "estrellas": sig,
        "objetivo": objetivo,
        "faltan": round(max(objetivo - total, 0), 2),
        "margen_bajo": actual == 2 and total > refs["record"] and margen_pct < MARGEN_MINIMO_ORO,
    }


def clasificar(n_pedidos, ticket_promedio, margen_pct, dias_sin_comprar):
    """Clase del cliente: NUEVO (nunca ha comprado), C (dormido, más de
    6 meses sin comprar), A / A2 (ticket >= $150; A con margen >= 20%,
    A2 con margen menor), B / B2 (ticket menor; B con margen >= 20%)."""
    if not n_pedidos:
        return "NUEVO"
    if dias_sin_comprar > DIAS_DORMIDO:
        return "C"
    bueno = margen_pct >= MARGEN_BUEN_CLIENTE
    if ticket_promedio >= TICKET_BUEN_CLIENTE:
        return "A" if bueno else "A2"
    return "B" if bueno else "B2"


def valor_esperado(clase, tipico):
    """Ticket típico x probabilidad de que compre al visitarlo."""
    return round((tipico or 0.0) * CONVERSION.get(clase, 0.0), 2)


def xp_pedido(utilidad, n_estrellas, dia_del_mes):
    """XP de un pedido: utilidad bruta (x1.5 los días 1-15) + bono por
    estrella. Sin utilidad (regalos > ventas) no suma la parte base."""
    base = max(utilidad, 0.0) * XP_POR_DOLAR
    if dia_del_mes <= DIA_FIN_PRIMERA_QUINCENA:
        base *= MULTIPLICADOR_PRIMERA_QUINCENA
    return int(round(base)) + BONO_ESTRELLA.get(n_estrellas, 0)


def nivel_de_xp(xp_total):
    """(numero, nombre, xp_nivel_actual, xp_siguiente|None) del XP
    acumulado. El nivel nunca baja porque el XP total solo crece."""
    actual = NIVELES[0]
    for nivel in NIVELES:
        if xp_total >= nivel[2]:
            actual = nivel
    idx = NIVELES.index(actual)
    siguiente = NIVELES[idx + 1][2] if idx + 1 < len(NIVELES) else None
    return actual[0], actual[1], actual[2], siguiente
