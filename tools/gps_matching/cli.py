"""
Orquesta el flujo completo, ruta por ruta: trae los clientes de esa
ruta que NO tienen coordenadas (mismo criterio que usa el wizard
"Buscar GPS por nombre": partner_latitude/partner_longitude vacíos o en
0 -- ver _dominio_ubicaciones() en
shalom_location_map/wizards/shalom_buscar_gps_wizard.py), busca cada
uno en Google Places, decide con scoring.py, y ESCRIBE de una vez las
de alta confianza -- nunca toca un cliente que ya tenía coordenadas
(eso ya fue revisado y aprobado por el usuario antes). Imprime un
reporte agrupado por bucket para pegar en el chat.

Uso:
    python -m tools.gps_matching.cli --ruta "Colón Norte"
    python -m tools.gps_matching.cli --ruta-id 42
    python -m tools.gps_matching.cli --ruta "Colón Norte" --solo-reportar

Variables de entorno requeridas -- ver README.md de esta carpeta.
"""
import argparse
import sys
import time

from . import scoring
from .google_places import buscar_en_google
from .odoo_client import OdooAuthError, OdooClient

# pausa entre llamadas a Google Places, por cortesía con su límite de
# tasa -- no hace falta tocarla salvo que Google empiece a devolver 429.
PAUSA_ENTRE_LLAMADAS_SEG = 0.2


def _resolver_ruta(client, ruta_id, ruta_nombre):
    if ruta_id:
        rutas = client.search_read("fsm.route", [("id", "=", ruta_id)], ["id", "name"])
    else:
        rutas = client.search_read("fsm.route", [("name", "=", ruta_nombre)], ["id", "name"])
        if not rutas:
            rutas = client.search_read(
                "fsm.route", [("name", "ilike", ruta_nombre)], ["id", "name"]
            )
    if not rutas:
        sys.exit(f"No se encontró ninguna ruta que coincida con {ruta_id or ruta_nombre!r}.")
    if len(rutas) > 1:
        opciones = ", ".join(f"{r['name']!r} (id={r['id']})" for r in rutas)
        sys.exit(f"Coinciden varias rutas -- especificá el id con --ruta-id: {opciones}")
    return rutas[0]


def _clientes_pendientes(client, route_id):
    """Mismo domain que el wizard: partner_latitude/longitude vacíos o
    en 0 (en Odoo, '=' False sobre un campo Float también matchea 0.0).
    Trae street/street2 -- es la dirección que score_direccion() compara
    contra la que devuelve Google, la misma combinación que usa el
    wizard para mostrar "Dirección actual" (location_direccion_actual)."""
    return client.search_read(
        "fsm.location",
        [
            ("fsm_route_id", "=", route_id),
            "|", ("partner_latitude", "=", False), ("partner_longitude", "=", False),
        ],
        ["id", "name", "street", "street2"],
    )


def _direccion_guardada(loc):
    return ", ".join(p for p in (loc.get("street"), loc.get("street2")) if p)


def _puntos_confirmados(client, route_id, excluir_ids):
    """Ubicaciones de la MISMA ruta que ya tienen coordenadas -- se
    usan como referencia geográfica para score_distancia() en vez de
    pedirle al usuario un rango fijo por zona."""
    confirmados = client.search_read(
        "fsm.location",
        [
            ("fsm_route_id", "=", route_id),
            ("partner_latitude", "!=", False),
            ("partner_longitude", "!=", False),
            ("id", "not in", excluir_ids or [0]),
        ],
        ["partner_latitude", "partner_longitude"],
    )
    return [(c["partner_latitude"], c["partner_longitude"]) for c in confirmados]


def _escribir_coordenada(client, loc, candidato):
    """Escribe la coordenada elegida vía shalom_actualizar_gps() -- el
    mismo método que usa el botón "Usar esta opción" del wizard, para
    no duplicar el write. Antes de escribir vuelve a leer el registro
    por si algo lo cambió entre la búsqueda y ahora (alguien usando el
    wizard a mano en paralelo, por ejemplo): si ya tiene coordenadas,
    NO se toca -- regla dura, sin excepción."""
    actual = client.search_read(
        "fsm.location", [("id", "=", loc["id"])],
        ["partner_latitude", "partner_longitude"],
    )[0]
    if actual["partner_latitude"] or actual["partner_longitude"]:
        print(f"   (omitido: {loc['name']!r} ya tiene coordenadas -- no se toca)")
        return False
    client.call_method(
        "fsm.location", "shalom_actualizar_gps", loc["id"],
        args=[candidato["lat"], candidato["lng"]],
    )
    return True


def procesar_ruta(ruta_id=None, ruta_nombre=None, solo_reportar=False):
    client = OdooClient()
    ruta = _resolver_ruta(client, ruta_id, ruta_nombre)

    pendientes = _clientes_pendientes(client, ruta["id"])
    if not pendientes:
        print(f"Ruta {ruta['name']!r}: no hay clientes pendientes (todos ya tienen coordenadas).")
        return

    ids_pendientes = [p["id"] for p in pendientes]
    puntos_ruta = _puntos_confirmados(client, ruta["id"], ids_pendientes)

    resultados = {scoring.ALTA_CONFIANZA: [], scoring.DUDOSO: [], scoring.SIN_COINCIDENCIA: []}

    for i, loc in enumerate(pendientes):
        if i:
            time.sleep(PAUSA_ENTRE_LLAMADAS_SEG)
        candidatos = buscar_en_google(loc["name"])
        resultado = scoring.evaluar_candidatos(
            loc["name"], _direccion_guardada(loc), candidatos, puntos_ruta
        )
        entrada = {"location": loc, "resultado": resultado, "escrito": False}

        if resultado.bucket == scoring.ALTA_CONFIANZA and not solo_reportar:
            candidato = resultado.mejor["candidato"]
            entrada["escrito"] = _escribir_coordenada(client, loc, candidato)
            if entrada["escrito"]:
                # el candidato recién escrito pasa a sumar como punto de
                # referencia para las próximas comparaciones de esta
                # misma corrida -- mejora la señal de distancia a
                # medida que se avanza en la ruta.
                puntos_ruta.append((candidato["lat"], candidato["lng"]))

        resultados[resultado.bucket].append(entrada)

    _imprimir_reporte(ruta, resultados, solo_reportar)


def _fmt(score):
    return f"{score:.2f}" if score is not None else "n/d"


def _imprimir_reporte(ruta, resultados, solo_reportar):
    total = sum(len(v) for v in resultados.values())
    print(f"\n=== Ruta {ruta['name']!r} -- {total} cliente(s) sin coordenadas ===\n")

    alta_confianza = resultados[scoring.ALTA_CONFIANZA]
    if solo_reportar:
        cantidad, verbo = len(alta_confianza), "encontrados (--solo-reportar, nada escrito)"
    else:
        cantidad = len([e for e in alta_confianza if e["escrito"]])
        verbo = "escritos"
    print(f"✔ Alta confianza -- {verbo} ({cantidad}):")
    for e in resultados[scoring.ALTA_CONFIANZA]:
        c = e["resultado"].mejor["candidato"]
        marca = "" if e["escrito"] or solo_reportar else "  [NO escrito -- ver motivo arriba]"
        print(f"   - {e['location']['name']!r} -> {c['nombre']!r} ({c['direccion']}){marca}")

    dudosos = resultados[scoring.DUDOSO]
    print(f"\n? Dudoso -- necesitan que elijas a mano ({len(dudosos)}):")
    for e in dudosos:
        print(f"   - {e['location']['name']!r}:")
        for ev in e["resultado"].evaluados[:5]:
            c = ev["candidato"]
            km = f", a {ev['distancia_km_centro']} km del resto de la ruta" if ev["distancia_km_centro"] is not None else ""
            print(
                f"       [confianza {ev['confianza']:.2f} = nombre {ev['nombre_score']:.2f}"
                f" / dirección {_fmt(ev['direccion_score'])}"
                f" / distancia {_fmt(ev['distancia_score'])}]"
                f" {c['nombre']!r} -- {c['direccion']}{km}"
            )

    sin_match = resultados[scoring.SIN_COINCIDENCIA]
    print(f"\n✘ Sin coincidencia confiable -- quedan SIN coordenadas ({len(sin_match)}):")
    for e in sin_match:
        print(f"   - {e['location']['name']!r} ({e['resultado'].motivo or 'ninguna opción confiable'})")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    grupo = parser.add_mutually_exclusive_group(required=True)
    grupo.add_argument("--ruta", help="Nombre (o parte del nombre) de la ruta")
    grupo.add_argument("--ruta-id", type=int, help="ID exacto de fsm.route")
    parser.add_argument(
        "--solo-reportar", action="store_true",
        help="No escribe nada en Odoo -- solo busca y muestra el reporte "
        "(para calibrar el criterio antes de correrlo en serio).",
    )
    args = parser.parse_args()

    try:
        procesar_ruta(ruta_id=args.ruta_id, ruta_nombre=args.ruta, solo_reportar=args.solo_reportar)
    except (RuntimeError, OdooAuthError) as exc:
        sys.exit(f"Error: {exc}")


if __name__ == "__main__":
    main()
