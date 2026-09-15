"""
Mismo motor de búsqueda que _buscar_en_google() en
shalom_location_map/wizards/shalom_buscar_gps_wizard.py (Google Places
Text Search, con el mismo "nombre, Panamá" que se usa a mano en Waze/
Google Maps) -- duplicado acá porque esta herramienta corre fuera de
Odoo y no tiene el entorno del addon cargado, así que no puede importar
el módulo del wizard directamente. Si el día de mañana se agrega un
endpoint HTTP en el addon para esto, este archivo debería reemplazarse
por una llamada a ese endpoint en vez de pegarle a Google por su cuenta.
"""
import logging
import os

import requests

_logger = logging.getLogger(__name__)

CONTEXTO_BUSQUEDA = "Panamá"
GOOGLE_PLACES_TEXTSEARCH_URL = (
    "https://maps.googleapis.com/maps/api/place/textsearch/json"
)
# Mismo tope que el wizard -- Google Places Text Search ya devuelve como
# máximo 20 resultados en una sola llamada, así que esto no trunca nada
# que Google no haya truncado solo.
TOPE_OPCIONES_POR_CLIENTE = 20


def buscar_en_google(nombre_cliente, token=None):
    """Busca nombre_cliente + ", Panamá" en Google Places Text Search.
    Devuelve una lista de dicts {nombre, direccion, lat, lng} (hasta
    TOPE_OPCIONES_POR_CLIENTE), o [] si no hay resultados o falla la
    llamada. Lee GOOGLE_PLACES_API_KEY del entorno si no se pasa un
    token explícito -- nunca hardcodeado."""
    token = token or os.environ.get("GOOGLE_PLACES_API_KEY")
    if not token:
        raise RuntimeError(
            "Falta la variable de entorno GOOGLE_PLACES_API_KEY -- ver "
            "tools/gps_matching/README.md."
        )
    if not nombre_cliente:
        return []

    query = f"{nombre_cliente}, {CONTEXTO_BUSQUEDA}"
    try:
        response = requests.get(
            GOOGLE_PLACES_TEXTSEARCH_URL,
            params={"query": query, "region": "pa", "key": token},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        _logger.warning(
            "No se pudo buscar en Google Places el nombre '%s': %s",
            nombre_cliente, exc,
        )
        return []

    estado = data.get("status")
    if estado not in ("OK", "ZERO_RESULTS"):
        _logger.warning(
            "Google Places devolvió un estado inesperado para '%s': %s (%s)",
            nombre_cliente, estado, data.get("error_message", ""),
        )
        return []

    resultados = [
        {
            "nombre": result.get("name", nombre_cliente),
            "direccion": result.get("formatted_address", ""),
            "lat": result["geometry"]["location"]["lat"],
            "lng": result["geometry"]["location"]["lng"],
        }
        for result in data.get("results", [])
        if result.get("geometry", {}).get("location")
    ]
    return resultados[:TOPE_OPCIONES_POR_CLIENTE]
