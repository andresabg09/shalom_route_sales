#!/usr/bin/env python3
"""Pruebas de las reglas puras del modo offline (models/offline_utils.py).
Sin Odoo: python3 tools/test_offline_utils.py"""
import importlib.util
import pathlib
import sys

RUTA = pathlib.Path(__file__).resolve().parent.parent / "shalom_location_map" / "models" / "offline_utils.py"
spec = importlib.util.spec_from_file_location("offline_utils", RUTA)
ou = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ou)

fallos = 0


def ok(cond, msg):
    global fallos
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        fallos += 1


carrito = {
    "1": {"product_id": 1, "name": "Tinte", "list_price": 10, "cantidad": 3},
    "2": {"product_id": 2, "name": "Oxi", "list_price": 4.5, "cantidad": 2},
    "reward-7": {"product_id": 3, "name": "Regalo", "list_price": 9, "cantidad": 1, "es_recompensa": True, "regla_id": 7},
    "4": {"product_id": 4, "name": "Cero", "list_price": 5, "cantidad": 0},
    "x": "basura",
}
items, total, lineas = ou.resumen_carrito(carrito)
ok(items == 6, "cuenta ítems (recompensa incluida, cero excluido)")
ok(total == 39.0, "total sin la recompensa")
ok([l["nombre"] for l in lineas] == ["Oxi", "Tinte", "Regalo"], "orden: pagos por nombre, recompensas al final")
ok(ou.resumen_carrito({}) == (0.0, 0.0, []), "vacío")
ok(ou.carrito_desde_json("no json") == {} and ou.carrito_desde_json("[1]") == {} and ou.carrito_desde_json(None) == {}, "JSON roto -> vacío")
ok(ou.es_destacado(100, 100) and not ou.es_destacado(99.99, 100), "umbral inclusivo")
ok(ou.es_destacado(150, "no-numero") is True, "umbral inválido usa $100")
ok(not ou.precio_cambio(10, 10.004) and ou.precio_cambio(10, 10.01), "tolerancia de centavo")
ok(not ou.precio_cambio(None, 5) and not ou.precio_cambio(False, 5), "sin precio de visita: no cambió")
cambiadas = ou.lineas_cambiadas(
    [{"product_id": 1, "precio_visita": 9}, {"product_id": 2, "precio_visita": 4.5},
     {"product_id": 3, "precio_visita": 1, "es_recompensa": True}, {"product_id": 9, "precio_visita": 1}],
    {1: 10, 2: 4.5, 3: 9},
)
ok(cambiadas == [(1, 9.0, 10.0)], "solo líneas pagas con precio distinto y producto conocido")
print("\n" + (f"{fallos} FALLAS" if fallos else "Todas las pruebas pasaron"))
sys.exit(1 if fallos else 0)
