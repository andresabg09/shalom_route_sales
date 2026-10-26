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
import calendar
import json
import unicodedata
from datetime import date, timedelta

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


# -- Carteras: reparto de los clientes de una ruta entre vendedores --

# Clases que entran a una cartera (compran lo suficiente). Dormidos (C) y
# nunca-compraron (NUEVO) quedan fuera: se ven en "Toda la ruta".
CLASES_CARTERA = ("A", "A2", "B", "B2")
# Orden de visita dentro de una cartera: primero A, luego A2, luego B.
PRIORIDAD_CLASE = {"A": 0, "A2": 1, "B": 2, "B2": 3}
# Meta de valor esperado por cartera diaria (cada vendedor, cada día).
MINIMO_CARTERA = 2000.0
# Clientes de respaldo cercanos por cartera.
RESERVA_POR_CARTERA = 3


def repartir_carteras(candidatos, n_personas, minimo=MINIMO_CARTERA, reserva_n=RESERVA_POR_CARTERA):
    """Reparte los clientes de una ruta en carteras diarias.

    candidatos: [{"id", "orden", "clase", "esperado"}], donde `orden` es
    la posición del cliente en la ruta (ya sigue el recorrido de la
    calle, así que carteras de clientes seguidos = vecinos = menos
    combustible). Solo entran clases de CLASES_CARTERA.

    1. Cuántas carteras caben: floor(valor total / minimo) (al menos 1).
       Si son menos que las personas, solo las primeras de la lista
       trabajan esa ruta.
    2. Se recorren los clientes en orden de ruta cortando tramos de
       valor parecido (valor total / carteras), así todas las carteras
       llegan al mínimo, no solo la primera.
    3. En cada tramo, los `reserva_n` clientes de MENOR valor esperado
       quedan de reserva (siempre que el resto siga llegando al mínimo):
       están en el mismo tramo, o sea cerca; si un cliente de la
       cartera no compra, se toma uno de la reserva.
    4. Las carteras se turnan entre las personas (día 1: P1, P2; día 2:
       P1, P2...), así que dos vendedores nunca comparten un cliente.

    Devuelve [{"persona": idx, "dia": n, "items": [id...] (A primero,
    luego A2, luego B), "reservas": [id...], "esperado" (sin reservas),
    "completo"}]. `completo` es False si la cartera no llega al
    mínimo (solo puede pasar en la última)."""
    pool = sorted(
        (c for c in candidatos if c["clase"] in CLASES_CARTERA and c["esperado"] > 0),
        key=lambda c: (c["orden"], c["id"]),
    )
    if not pool or n_personas < 1 or minimo <= 0:
        return []
    total = sum(c["esperado"] for c in pool)
    n_carteras = max(1, int(total // minimo))
    usables = min(n_personas, n_carteras)
    objetivo = total / n_carteras
    carteras = []
    i = 0
    while i < len(pool):
        queda = n_carteras - len(carteras)
        tramo, valor = [], 0.0
        while i < len(pool) and (queda <= 1 or valor < objetivo):
            tramo.append(pool[i])
            valor += pool[i]["esperado"]
            i += 1
        # Reserva: los de menor valor, mientras el resto llegue al mínimo.
        reservas = []
        for c in sorted(tramo, key=lambda c: (c["esperado"], -c["orden"])):
            if len(reservas) >= reserva_n or valor - c["esperado"] < minimo:
                break
            reservas.append(c)
            valor -= c["esperado"]
        ids_reserva = {c["id"] for c in reservas}
        items = sorted(
            (c for c in tramo if c["id"] not in ids_reserva),
            key=lambda c: (PRIORIDAD_CLASE[c["clase"]], c["orden"]),
        )
        idx = len(carteras)
        carteras.append(
            {
                "persona": idx % usables,
                "dia": idx // usables,
                "items": [c["id"] for c in items],
                "reservas": [c["id"] for c in sorted(reservas, key=lambda c: (c["orden"], c["id"]))],
                "esperado": round(valor, 2),
                "completo": valor >= minimo,
            }
        )
    return carteras


# -- Fase 6A: logros, equipo cooperativo y temporada del mes --

# Palabras que identifican un producto de tinte / de oxigenta (por nombre
# o por categoría, sin tildes ni mayúsculas). Un solo lugar: lo reusa quien
# necesite saber "qué es un tinte" (p. ej. el cálculo de oxigenta por cada
# 100 tintes del gerente).
PALABRAS_TINTE = ("tinte",)
PALABRAS_OXIGENTA = ("oxigenta", "oxidante")


def _sin_tildes(texto):
    base = unicodedata.normalize("NFD", texto or "")
    return "".join(c for c in base if unicodedata.category(c) != "Mn").lower()


def es_tinte(nombre, categoria=""):
    texto = _sin_tildes(f"{nombre} {categoria}")
    return any(p in texto for p in PALABRAS_TINTE)


def es_oxigenta(nombre, categoria=""):
    texto = _sin_tildes(f"{nombre} {categoria}")
    return any(p in texto for p in PALABRAS_OXIGENTA)


def pedido_con_tinte_y_oxigenta(productos):
    """productos: [(nombre, categoria)] de las líneas del pedido.
    Devuelve (con_tinte, con_oxigenta). Un producto que dice "tinte" y
    "oxigenta" a la vez (p. ej. "Kit tinte + oxigenta") cuenta como ambos."""
    con_tinte = any(es_tinte(n, c) for n, c in productos)
    con_oxigenta = any(es_oxigenta(n, c) for n, c in productos)
    return con_tinte, con_oxigenta


# Pedido grande para el logro "Cazador de grandes" (venta sin impuestos).
PEDIDO_GRANDE = 2000.0
RACHA_RUTA_SIN_SALTOS = 5
PEDIDOS_QUIMICO = 3

# Catálogo de logros (propuesta de XP). Cada uno se gana UNA sola vez por
# vendedor. `bienvenida`: las 3 misiones del tutorial (100+200+300 = 600 XP,
# lo justo para el nivel 2).
LOGROS = [
    {"codigo": "primer_pedido", "nombre": "Primer pedido", "descripcion": "Toma tu primer pedido", "xp": 100, "meta": 1, "bienvenida": True},
    {"codigo": "quimico", "nombre": "El Químico", "descripcion": "Pon oxigenta en 3 pedidos que lleven tinte", "xp": 200, "meta": PEDIDOS_QUIMICO, "bienvenida": True},
    {"codigo": "ruta_sin_saltos", "nombre": "Ruta sin saltos", "descripcion": "Cierra 5 clientes seguidos de la misma ruta", "xp": 300, "meta": RACHA_RUTA_SIN_SALTOS, "bienvenida": True},
    {"codigo": "primera_plata", "nombre": "Primera plata", "descripcion": "Gana 2 estrellas (plata) en un pedido", "xp": 75, "meta": 1, "bienvenida": False},
    {"codigo": "oro", "nombre": "Oro", "descripcion": "Gana 3 estrellas (oro) en un pedido", "xp": 150, "meta": 1, "bienvenida": False},
    {"codigo": "record_roto", "nombre": "Rompe Récords", "descripcion": "Superar el récord de un cliente", "xp": 150, "meta": 1, "bienvenida": False},
    {"codigo": "cazador_grandes", "nombre": "Cazador de grandes", "descripcion": "Cerrar un cliente de más de $2,000", "xp": 100, "meta": 1, "bienvenida": False},
    {"codigo": "nivel_2", "nombre": "Nivel 2", "descripcion": "Llegar al nivel 2 (600 XP)", "xp": 50, "meta": NIVELES[1][2], "bienvenida": False},
]
LOGROS_POR_CODIGO = {logro["codigo"]: logro for logro in LOGROS}


def racha_mas_larga(rutas):
    """Tramo más largo de pedidos seguidos de la MISMA ruta. `rutas`: id
    de ruta de cada pedido del vendedor en orden cronológico. Un pedido
    sin ruta conocida (falsy) corta la racha y no cuenta."""
    mejor = actual = 0
    anterior = None
    for ruta in rutas:
        if not ruta:
            actual, anterior = 0, None
            continue
        actual = actual + 1 if ruta == anterior else 1
        anterior = ruta
        mejor = max(mejor, actual)
    return mejor


def estado_logros(stats):
    """Progreso de cada logro del catálogo a partir de las estadísticas
    del vendedor (monótonas: solo crecen, así que un logro completo no se
    "des-completa").

    stats: {"n_pedidos", "n_quimico", "mejor_racha", "max_estrellas",
    "hay_record", "mayor_pedido", "xp_total"}.
    Devuelve [{codigo, nombre, descripcion, xp, meta, progreso, completo,
    bienvenida}] en el orden del catálogo."""
    progresos = {
        "primer_pedido": stats.get("n_pedidos", 0),
        "quimico": stats.get("n_quimico", 0),
        "ruta_sin_saltos": stats.get("mejor_racha", 0),
        "primera_plata": 1 if stats.get("max_estrellas", 0) >= 2 else 0,
        "oro": 1 if stats.get("max_estrellas", 0) >= 3 else 0,
        "record_roto": 1 if stats.get("hay_record") else 0,
        "cazador_grandes": 1 if stats.get("mayor_pedido", 0) > PEDIDO_GRANDE else 0,
        "nivel_2": stats.get("xp_total", 0),
    }
    resultado = []
    for logro in LOGROS:
        progreso = min(progresos[logro["codigo"]], logro["meta"])
        resultado.append(
            {
                "codigo": logro["codigo"],
                "nombre": logro["nombre"],
                "descripcion": logro["descripcion"],
                "xp": logro["xp"],
                "meta": logro["meta"],
                "progreso": progreso,
                "completo": progreso >= logro["meta"],
                "bienvenida": logro["bienvenida"],
            }
        )
    return resultado


# -- Equipo cooperativo del mes --

PISO_MES_DEFECTO = 60000.0
META_MES_DEFECTO = 80000.0
# Días en que se vende (propuesta: lunes a viernes; 0 = lunes). Los feriados
# no se descuentan.
DIAS_HABILES_SEMANA = (0, 1, 2, 3, 4)


def dias_habiles_entre(desde, hasta):
    """Cantidad de días hábiles en [desde, hasta] (date, ambos incluidos)."""
    if hasta < desde:
        return 0
    n = 0
    dia = desde
    while dia <= hasta:
        if dia.weekday() in DIAS_HABILES_SEMANA:
            n += 1
        dia += timedelta(days=1)
    return n


def ritmo_equipo(ventas, piso, meta, hoy):
    """Estado del equipo en el mes de `hoy` (date). Sin ranking ni
    comparación entre vendedores: solo el total del equipo contra el piso
    y la meta (jefe final).

    Devuelve {dias_mes, dia_actual, dias_habiles_mes, dias_habiles_pasados,
    dias_habiles_restantes, pct_piso, pct_meta, faltan_piso, faltan_meta,
    ritmo_piso, ritmo_meta, esperado_hoy, en_ritmo, piso_alcanzado,
    meta_alcanzada}. `restantes` cuenta desde hoy (inclusive); `ritmo_*` =
    lo que falta entre los días hábiles que quedan (si no quedan, todo lo
    que falta)."""
    ventas = float(ventas or 0.0)
    piso = float(piso or 0.0)
    meta = float(meta or 0.0)
    primero = date(hoy.year, hoy.month, 1)
    dias_mes = calendar.monthrange(hoy.year, hoy.month)[1]
    ultimo = date(hoy.year, hoy.month, dias_mes)
    habiles_mes = dias_habiles_entre(primero, ultimo)
    pasados = dias_habiles_entre(primero, hoy - timedelta(days=1))
    restantes = dias_habiles_entre(hoy, ultimo)
    faltan_piso = max(piso - ventas, 0.0)
    faltan_meta = max(meta - ventas, 0.0)
    divisor = max(restantes, 1)
    esperado_hoy = piso * pasados / habiles_mes if habiles_mes else 0.0
    return {
        "dias_mes": dias_mes,
        "dia_actual": hoy.day,
        "dias_habiles_mes": habiles_mes,
        "dias_habiles_pasados": pasados,
        "dias_habiles_restantes": restantes,
        "pct_piso": round(ventas / piso * 100.0, 1) if piso else 0.0,
        "pct_meta": round(ventas / meta * 100.0, 1) if meta else 0.0,
        "faltan_piso": round(faltan_piso, 2),
        "faltan_meta": round(faltan_meta, 2),
        "ritmo_piso": round(faltan_piso / divisor, 2),
        "ritmo_meta": round(faltan_meta / divisor, 2),
        "esperado_hoy": round(esperado_hoy, 2),
        "en_ritmo": ventas >= esperado_hoy,
        "piso_alcanzado": bool(piso) and ventas >= piso,
        "meta_alcanzada": bool(meta) and ventas >= meta,
    }


def camion_del_dia(vendido_hoy, meta_dia):
    """Camión del día: lo vendido hoy contra la carga del reparto.
    meta_dia ausente/inválida/<=0 -> None (no se muestra)."""
    try:
        meta_dia = float(meta_dia or 0)
    except (TypeError, ValueError):
        return None
    if meta_dia <= 0:
        return None
    vendido_hoy = float(vendido_hoy or 0.0)
    return {
        "meta": round(meta_dia, 2),
        "vendido": round(vendido_hoy, 2),
        "pct": round(vendido_hoy / meta_dia * 100.0, 1),
        "lleno": vendido_hoy >= meta_dia,
    }


# -- Temporada del mes (reinicia cada mes) --

# XP DEL MES que abre cada nivel de temporada, 12 hitos (propuesta; el
# último es el "jefe final"). Todo lo de la temporada se calcula sobre el
# XP ganado dentro del mes calendario.
HITOS_TEMPORADA = [300, 700, 1300, 2100, 3100, 4300, 5700, 7300, 9100, 11100, 13300, 16000]


def hitos_temporada(xp_mes):
    """(nivel, hitos): nivel = cuántos hitos del mes ya se alcanzaron
    (0..12) e hitos = [{nivel, xp, alcanzado, actual}] donde `actual` es
    el siguiente por alcanzar (solo uno)."""
    nivel = sum(1 for xp in HITOS_TEMPORADA if xp_mes >= xp)
    hitos = [
        {"nivel": i + 1, "xp": xp, "alcanzado": xp_mes >= xp, "actual": i == nivel}
        for i, xp in enumerate(HITOS_TEMPORADA)
    ]
    return nivel, hitos


def premios_de_texto(crudo):
    """Premios de temporada desde el texto de ir.config_parameter. Acepta
    un objeto JSON {"4": "Marco plateado", ...} o una lista [{"nivel": 4,
    "texto": "..."}]. Texto vacío, JSON inválido o forma rara -> {} (no se
    muestran premios). Devuelve {nivel(int): texto(str)}."""
    if not crudo or not str(crudo).strip():
        return {}
    try:
        datos = json.loads(crudo)
    except (TypeError, ValueError):
        return {}
    if isinstance(datos, dict):
        pares = list(datos.items())
    elif isinstance(datos, list):
        pares = [(d.get("nivel"), d.get("texto")) for d in datos if isinstance(d, dict)]
    else:
        return {}
    premios = {}
    for nivel, texto in pares:
        try:
            nivel = int(nivel)
        except (TypeError, ValueError):
            continue
        if isinstance(texto, str) and texto.strip() and 1 <= nivel <= len(HITOS_TEMPORADA):
            premios[nivel] = texto.strip()
    return premios


def dias_quincena_restantes(hoy):
    """Días que quedan del x1.5 de XP (días 1-15), contando hoy; 0 si ya
    pasó la primera quincena."""
    return max(DIA_FIN_PRIMERA_QUINCENA - hoy.day + 1, 0)
