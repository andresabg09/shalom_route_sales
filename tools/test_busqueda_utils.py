"""Pruebas de models/busqueda_utils.py (sin Odoo): python3 tools/test_busqueda_utils.py"""
import importlib.util
import os

RUTA = os.path.join(os.path.dirname(__file__), "..", "shalom_location_map", "models", "busqueda_utils.py")
spec = importlib.util.spec_from_file_location("busqueda_utils", RUTA)
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

assert b.normalizar("José PÉREZ") == "jose perez"
assert b.normalizar("Peñalba ÚNICA") == "penalba unica"
assert b.normalizar(None) == ""
assert b.patron_contiene("  Jóse ") == "%jose%"
assert b.patron_contiene("50%_x\\") == "%50\\%\\_x\\\\%"
# translate() de SQL (mapa letra por letra) == normalizar() de Python
for con, sin in zip(b.CON_TILDE, b.SIN_TILDE):
    assert b.normalizar(con) == sin.lower(), (con, sin)
assert "translate(COALESCE(p.name, ''), %s, %s)" in b.sql_normalizado("p.name")
print("busqueda_utils: todas las pruebas pasaron")
