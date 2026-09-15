"""
Decide, para un cliente y su lista de candidatos de Google Places, cuál
es (si hay alguno) el más probable, y con qué confianza. No es
aprendizaje automático -- son reglas explícitas, calibradas con los
ejemplos reales que dio el usuario (ver README.md de esta carpeta).

La confianza se arma combinando TRES señales -- nunca una sola manda:
  - nombre: cuánto se parece el nombre guardado en Odoo al del candidato.
  - dirección: cuánto de la dirección guardada en Odoo (calle/casa, aunque
    sea parcial) aparece en la dirección que trae Google.
  - distancia: qué tan consistente es la ubicación del candidato con las
    demás ubicaciones YA CONFIRMADAS de la misma ruta.
Cualquiera de las tres puede faltar (cliente sin dirección cargada, ruta
sin ninguna ubicación confirmada todavía) -- en ese caso esa señal
simplemente no participa del promedio, no se inventa un valor.

Además hay dos vetos duros, con o sin buen puntaje combinado: tipo de
negocio distinto entre ambos nombres ("Mini Super Andrés" vs "Farmacia
Andrés") y número de local que difiere ("Mini Super 188" vs "Farmacia
212") -- ambos son señales de que es OTRO cliente, no una variante de
nombre.

Una sola opción de Google NO es sinónimo de alta confianza -- se evalúa
exactamente con las mismas tres señales que si hubiera varias.

Tres resultados posibles por cliente:
  ALTA_CONFIANZA   -- se escribe directo (cli.py la aplica sin preguntar).
  DUDOSO           -- hay opciones pero ninguna gana con claridad; se
                       deja para que el usuario elija a mano (ver reporte).
  SIN_COINCIDENCIA -- no hay ninguna opción confiable; se deja SIN
                       coordenadas a propósito (mejor sin coordenada que
                       con la incorrecta -- regla explícita del usuario).
"""
import re
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Dict, List, Optional

from . import geo

ALTA_CONFIANZA = "alta_confianza"
DUDOSO = "dudoso"
SIN_COINCIDENCIA = "sin_coincidencia"

# -- umbrales y pesos, pensados para ajustarse acá sin tocar lógica --
UMBRAL_ALTO = 0.75
UMBRAL_BAJO = 0.35
# si el 2do mejor candidato queda a menos de esto del 1ro (en confianza
# combinada), se considera que hay ambigüedad real entre los dos.
MARGEN_AMBIGUEDAD = 0.12

# Pesos de cada señal en la confianza combinada -- se renormalizan solo
# entre las señales que sí están disponibles para ese candidato (ver
# _confianza_combinada). El nombre pesa un poco más porque suele ser el
# dato más específico, pero ninguna señal decide sola.
PESO_NOMBRE = 0.4
PESO_DIRECCION = 0.3
PESO_DISTANCIA = 0.3

# distancia mínima tolerada aunque la ruta sea muy compacta, y cuántas
# "desviaciones medias" de la ruta se toleran por encima de eso -- ver
# score_distancia().
UMBRAL_KM_MINIMO = 3.0
FACTOR_DISPERSION = 2.5

# Palabras de "tipo de negocio" agrupadas por categoría. Un tipo de
# negocio explícito y DISTINTO entre el nombre guardado en Odoo y el
# candidato de Google es una señal fuerte de que es otro cliente, no una
# variante de nombre. Lista no exhaustiva a propósito -- ampliarla acá
# si en la práctica aparecen más categorías que generen falsos matches.
CATEGORIAS_NEGOCIO = {
    "abarrotes": {
        "minisuper", "mini super", "abarroteria", "abarrotes", "colmado",
        "tienda", "super", "supermercado", "bodega",
    },
    "farmacia": {"farmacia", "botica", "drogueria"},
    "panaderia": {"panaderia", "pasteleria", "reposteria"},
    "ferreteria": {"ferreteria", "materiales"},
    "belleza": {"salon", "barberia", "peluqueria", "spa"},
    "bar_restaurante": {"cantina", "bar", "restaurante", "fonda", "kiosco"},
    "distribuidora": {"distribuidora", "deposito", "mayorista"},
    "ropa": {"boutique", "textiles", "zapateria"},
}
_PALABRA_A_CATEGORIA = {
    palabra: categoria
    for categoria, palabras in CATEGORIAS_NEGOCIO.items()
    for palabra in palabras
}
_STOPWORDS = {"de", "la", "el", "los", "las", "y", "del", "a"}


@dataclass
class ResultadoMatch:
    bucket: str
    mejor: Optional[Dict]
    evaluados: List[Dict] = field(default_factory=list)
    motivo: Optional[str] = None


def _normalizar(texto):
    """minúsculas, sin acentos, sin puntuación -- para comparar nombres/
    direcciones escritos de formas distintas entre Odoo y Google."""
    if not texto:
        return ""
    texto = unicodedata.normalize("NFKD", texto).encode("ascii", "ignore").decode()
    texto = texto.lower()
    texto = re.sub(r"[^a-z0-9\s]", " ", texto)
    return re.sub(r"\s+", " ", texto).strip()


def _categoria_negocio(texto_normalizado):
    for palabra, categoria in _PALABRA_A_CATEGORIA.items():
        if palabra in texto_normalizado:
            return categoria
    return None


def _tokens_numericos(texto_normalizado):
    return set(re.findall(r"\d+", texto_normalizado))


def _tokens_significativos(texto_normalizado):
    """Lo que queda de un nombre después de sacar palabras de tipo-de-
    negocio y stopwords -- suele ser lo que identifica al cliente
    puntualmente (nombre propio, apellido, número de local)."""
    tokens = set(texto_normalizado.split())
    return tokens - set(_PALABRA_A_CATEGORIA.keys()) - _STOPWORDS


def score_nombre(nombre_odoo, nombre_google):
    """Compara dos nombres. Devuelve (score entre 0 y 1, detalle dict)
    -- score alto = mismo cliente probable."""
    norm_odoo = _normalizar(nombre_odoo)
    norm_google = _normalizar(nombre_google)

    similitud_texto_completo = SequenceMatcher(None, norm_odoo, norm_google).ratio()

    tokens_odoo = _tokens_significativos(norm_odoo)
    tokens_google = _tokens_significativos(norm_google)
    if tokens_odoo or tokens_google:
        union = tokens_odoo | tokens_google
        overlap_tokens = len(tokens_odoo & tokens_google) / len(union) if union else 0.0
    else:
        overlap_tokens = similitud_texto_completo

    score = 0.5 * similitud_texto_completo + 0.5 * overlap_tokens
    detalle = {
        "similitud_texto_completo": round(similitud_texto_completo, 3),
        "overlap_tokens": round(overlap_tokens, 3),
    }

    numeros_odoo = _tokens_numericos(norm_odoo)
    numeros_google = _tokens_numericos(norm_google)
    if numeros_odoo and numeros_google:
        if numeros_odoo & numeros_google:
            # Coincide el número de local (ej. "188") -- señal fuerte a
            # favor: es justo lo que distingue locales con nombres casi
            # idénticos.
            score = min(1.0, score + 0.15)
            detalle["numero_coincide"] = True
        else:
            # Números presentes en ambos lados pero DISTINTOS (ej. "188"
            # vs "212") -- son locales numerados distintos.
            score = max(0.0, score - 0.4)
            detalle["numero_coincide"] = False

    categoria_odoo = _categoria_negocio(norm_odoo)
    categoria_google = _categoria_negocio(norm_google)
    if categoria_odoo and categoria_google and categoria_odoo != categoria_google:
        score = max(0.0, score - 0.35)
        detalle["conflicto_tipo_negocio"] = f"{categoria_odoo} vs {categoria_google}"

    return round(min(1.0, max(0.0, score)), 3), detalle


def score_direccion(direccion_odoo, direccion_google):
    """Compara la dirección guardada en Odoo (street + street2) contra
    la que trae Google para el candidato. Pensada para el caso típico
    de direcciones PARCIALES: el cliente tiene cargado solo "Colón" y
    Google trae "Colón, Sabanitas, Calle 20" -- eso cuenta como buena
    señal (todo lo que el usuario cargó aparece en la de Google), no
    como texto distinto.

    Devuelve un score 0-1, o None si el cliente no tiene NADA de
    dirección guardada en Odoo -- ahí no hay con qué comparar, y no debe
    pesar ni a favor ni en contra (a diferencia de un score 0, que sí
    pesaría en contra)."""
    if not direccion_odoo or not direccion_odoo.strip():
        return None
    tokens_odoo = set(_normalizar(direccion_odoo).split()) - _STOPWORDS
    if not tokens_odoo:
        return None
    tokens_google = set(_normalizar(direccion_google).split()) - _STOPWORDS
    if not tokens_google:
        return 0.0
    # cuánto de lo que el usuario cargó a mano aparece en la dirección
    # (normalmente más completa) de Google -- a propósito no es un
    # Jaccard simétrico, porque penalizaría direcciones parciales que
    # en realidad son un buen indicio.
    return round(len(tokens_odoo & tokens_google) / len(tokens_odoo), 3)


def score_distancia(candidato, puntos_ruta_confirmados):
    """Compara la distancia del candidato al centro de las ubicaciones
    YA CONFIRMADAS de la misma ruta -- reemplaza pedirle al usuario un
    rango fijo por zona ("Colón está a 30-40km"): si la ruta ya tiene
    ubicaciones confirmadas ahí, un candidato a 32km es consistente y
    uno a 5km probablemente no es de esta ruta.

    Devuelve (score 0-1, distancia_al_centro_km). Ambos None cuando la
    ruta todavía no tiene ninguna ubicación confirmada -- en ese caso no
    hay con qué comparar, y el resultado no debe pesar ni a favor ni en
    contra."""
    centro = geo.centroide(puntos_ruta_confirmados)
    if not centro:
        return None, None
    dispersion = geo.desviacion_media_km(puntos_ruta_confirmados, centro)
    distancia = geo.distancia_km(candidato["lat"], candidato["lng"], centro[0], centro[1])
    if distancia is None:
        return None, None
    umbral = max(UMBRAL_KM_MINIMO, FACTOR_DISPERSION * dispersion)
    ratio = distancia / umbral if umbral else 1.0
    if ratio <= 1:
        # dentro del rango esperado: 1.0 justo en el centro, 0.7 justo
        # en el borde del umbral -- sigue siendo una señal positiva.
        score = 1.0 - 0.3 * ratio
    else:
        # más allá del umbral: cae rápido, pero no de golpe a 0 -- un
        # candidato apenas fuera del rango no es lo mismo que uno al
        # doble de distancia.
        score = max(0.0, 0.7 - 0.5 * (ratio - 1))
    return round(score, 3), round(distancia, 2)


def _confianza_combinada(nombre_score, direccion_score, distancia_score):
    """Promedio ponderado de las señales que sí están disponibles --
    las que faltan (None) se sacan del promedio en vez de contar como 0,
    para no castigar a un cliente por no tener dirección cargada o a una
    ruta por no tener todavía ninguna ubicación confirmada."""
    componentes = [(nombre_score, PESO_NOMBRE)]
    if direccion_score is not None:
        componentes.append((direccion_score, PESO_DIRECCION))
    if distancia_score is not None:
        componentes.append((distancia_score, PESO_DISTANCIA))
    peso_total = sum(peso for _, peso in componentes)
    return round(sum(s * peso for s, peso in componentes) / peso_total, 3)


def evaluar_candidatos(nombre_cliente, direccion_cliente, candidatos, puntos_ruta_confirmados):
    """Punto de entrada principal.

    nombre_cliente / direccion_cliente: nombre y dirección (street +
        street2) guardados en Odoo (fsm.location).
    candidatos: lista que devolvió Google Places para ese cliente.
    puntos_ruta_confirmados: lista de (lat, lng) de OTRAS ubicaciones de
        la misma ruta que ya tienen coordenadas confirmadas.
    """
    if not candidatos:
        return ResultadoMatch(SIN_COINCIDENCIA, None, [], "Google no devolvió resultados.")

    evaluados = []
    for candidato in candidatos:
        nombre_score, detalle_nombre = score_nombre(nombre_cliente, candidato["nombre"])
        direccion_score = score_direccion(direccion_cliente, candidato["direccion"])
        distancia_score, distancia_km_centro = score_distancia(candidato, puntos_ruta_confirmados)
        confianza = _confianza_combinada(nombre_score, direccion_score, distancia_score)
        evaluados.append({
            "candidato": candidato,
            "nombre_score": nombre_score,
            "detalle_nombre": detalle_nombre,
            "direccion_score": direccion_score,
            "distancia_score": distancia_score,
            "distancia_km_centro": distancia_km_centro,
            "confianza": confianza,
        })

    evaluados.sort(key=lambda e: e["confianza"], reverse=True)
    mejor = evaluados[0]
    segundo = evaluados[1] if len(evaluados) > 1 else None

    ambiguo = (
        segundo is not None
        and (mejor["confianza"] - segundo["confianza"]) < MARGEN_AMBIGUEDAD
        and segundo["confianza"] >= UMBRAL_BAJO
    )
    # vetos duros -- ninguna combinación de dirección/distancia debería
    # poder tapar un tipo de negocio distinto o un número de local que
    # no coincide (pedido explícito del usuario).
    conflicto_fuerte = (
        "conflicto_tipo_negocio" in mejor["detalle_nombre"]
        or mejor["detalle_nombre"].get("numero_coincide") is False
    )

    if mejor["confianza"] < UMBRAL_BAJO or conflicto_fuerte:
        bucket = SIN_COINCIDENCIA
    elif mejor["confianza"] >= UMBRAL_ALTO and not ambiguo:
        bucket = ALTA_CONFIANZA
    else:
        bucket = DUDOSO

    return ResultadoMatch(bucket, mejor, evaluados)
