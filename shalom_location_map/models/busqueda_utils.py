# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""Búsquedas sin tildes ni mayúsculas (reglas puras, sin Odoo).

Pedido explícito: escribir "jose", "JOSÉ" o "Jose" tiene que encontrar a
"José". El `ilike` de Odoo ya ignora las mayúsculas, pero las tildes solo
si la base de datos tiene la extensión `unaccent`, que normalmente no está.
En vez de depender de eso, se compara el texto "normalizado" con
translate() de PostgreSQL (función estándar, no requiere extensiones).
Se prueba con `python3 tools/test_busqueda_utils.py`."""
import unicodedata

CON_TILDE = "ÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇáàäâãéèëêíìïîóòöôõúùüûñç"
SIN_TILDE = "AAAAAEEEEIIIIOOOOOUUUUNCaaaaaeeeeiiiiooooouuuunc"
assert len(CON_TILDE) == len(SIN_TILDE)


def normalizar(texto):
    """'José PÉREZ' -> 'jose perez' (igual que normalizarBusqueda en JS)."""
    descompuesto = unicodedata.normalize("NFD", texto or "")
    return "".join(c for c in descompuesto if not unicodedata.combining(c)).lower()


def patron_contiene(texto):
    """Patrón LIKE '%texto%' ya normalizado, con %, _ y \\ escapados."""
    t = normalizar((texto or "").strip())
    t = t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{t}%"


def sql_normalizado(expresion):
    """Expresión SQL que normaliza `expresion` como normalizar(). Usa dos
    parámetros (%s, %s): CON_TILDE y SIN_TILDE, en ese orden."""
    return f"lower(translate(COALESCE({expresion}, ''), %s, %s))"
