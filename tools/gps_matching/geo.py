"""
Geometría simple, sin dependencias externas -- reusada por scoring.py.
La fórmula de distancia es la misma (Haversine) que
_distancia_km() en shalom_location_map/wizards/shalom_buscar_gps_wizard.py,
duplicada acá porque esta herramienta corre fuera de Odoo.
"""
import math


def distancia_km(lat1, lng1, lat2, lng2):
    """Distancia en línea recta entre dos puntos GPS. None si falta
    algún dato."""
    if not (lat1 and lng1 and lat2 and lng2):
        return None
    radio_tierra_km = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return radio_tierra_km * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def centroide(puntos):
    """Centroide (promedio simple) de una lista de (lat, lng). None si
    la lista está vacía -- ese es el caso de una ruta que todavía no
    tiene NINGUNA ubicación confirmada, donde no hay con qué comparar
    la distancia de un candidato nuevo."""
    puntos = list(puntos)
    if not puntos:
        return None
    lat = sum(p[0] for p in puntos) / len(puntos)
    lng = sum(p[1] for p in puntos) / len(puntos)
    return (lat, lng)


def desviacion_media_km(puntos, centro):
    """Distancia promedio de cada punto de la ruta a su centro -- una
    medida simple de qué tan dispersa es la ruta, para calibrar qué tan
    estricto ser al juzgar si un candidato nuevo es consistente con
    ella (ver UMBRAL_KM_MINIMO/FACTOR_DISPERSION en scoring.py)."""
    if not puntos or not centro:
        return 0.0
    distancias = [distancia_km(p[0], p[1], centro[0], centro[1]) for p in puntos]
    distancias = [d for d in distancias if d is not None]
    if not distancias:
        return 0.0
    return sum(distancias) / len(distancias)
