# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""
Reglas de "trabajo de campo" de Ruta Shalom como funciones PURAS (sin
Odoo, sin base de datos): normalizar teléfonos de Panamá, armar el
mensaje de aviso de visita y el enlace de WhatsApp, y decidir qué
visitas merecen un aviso con antelación. Viven aparte de los modelos
para probarlas fuera de Odoo (ver tools/test_campo_utils.py).

No hay integración con WhatsApp: solo se arma un enlace
https://wa.me/<número>?text=<mensaje> que el vendedor abre desde su
celular y envía él mismo.
"""
import re
from urllib.parse import quote

# Código de país de Panamá: un número local de 8 dígitos lo recibe.
PREFIJO_PAIS = "507"
DIGITOS_LOCALES = 8
# Largo máximo de un número internacional (E.164).
MAX_DIGITOS = 15
MIN_DIGITOS_INTERNACIONAL = 8

# A cuántos días vista se avisa (mañana ... dentro de 3 días).
DIAS_AVISO = 3
# Clases que siempre cuentan como "cliente grande".
CLASES_GRANDES = ("A", "A2")
# Valor esperado (USD) desde el cual cualquier otra clase también cuenta.
UMBRAL_ESPERADO_DEFECTO = 500.0

PLANTILLA_DEFECTO = (
    "Hola, buen día. Le escribe {vendedor} de Shalom. "
    "Pasaré a visitarle el {fecha}. ¿Le parece bien? "
    "Si necesita algo en especial, avíseme y se lo llevo."
)

DIAS_ES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
MESES_ES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
    "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]


def _normalizar_uno(crudo):
    """Un solo número -> dígitos con código de país, o "" si no sirve."""
    if not crudo:
        return ""
    texto = str(crudo).strip()
    # extensiones ("ext. 12", "x12") no forman parte del número
    texto = re.split(r"(?i)\b(?:ext|extension|extensión)\b|\bx\d", texto)[0]
    internacional = texto.startswith("+")
    digitos = re.sub(r"\D", "", texto)
    if not digitos:
        return ""
    if not internacional and digitos.startswith("00"):
        # 00507... = prefijo de llamada internacional
        digitos = digitos[2:]
        internacional = True
    if internacional:
        if MIN_DIGITOS_INTERNACIONAL <= len(digitos) <= MAX_DIGITOS:
            return digitos
        return ""
    if len(digitos) == DIGITOS_LOCALES:
        return PREFIJO_PAIS + digitos
    # ya trae el 507 sin el "+"  (507 + 8 dígitos)
    if digitos.startswith(PREFIJO_PAIS) and len(digitos) == len(PREFIJO_PAIS) + DIGITOS_LOCALES:
        return digitos
    return ""


def normalizar_telefono(crudo):
    """Teléfono tal como lo escribieron en Odoo -> solo dígitos con el
    código de país, listo para wa.me ("50766781234"), o "" si no es un
    número usable.

    - 8 dígitos (con guiones, espacios, paréntesis, puntos...) = número
      local de Panamá: se le antepone 507.
    - Con "+" o "00": se respeta tal cual (entre 8 y 15 dígitos).
    - Si el campo trae varios números ("6678-1234 / 233-4455", separados
      por / , ; o " y "), se usa el primero que sirva.
    """
    if not crudo:
        return ""
    for tramo in re.split(r"[/;,|\n]|\s+y\s+|\s+o\s+", str(crudo)):
        numero = _normalizar_uno(tramo)
        if numero:
            return numero
    return ""


def elegir_telefono(*candidatos):
    """Primer teléfono usable de la lista (en el orden dado; el celular
    primero, que es el que tiene WhatsApp), normalizado, o ""."""
    for candidato in candidatos:
        numero = normalizar_telefono(candidato)
        if numero:
            return numero
    return ""


def telefono_legible(numero):
    """"50766781234" -> "+507 6678-1234" (solo para mostrar)."""
    if not numero:
        return ""
    if numero.startswith(PREFIJO_PAIS) and len(numero) == len(PREFIJO_PAIS) + DIGITOS_LOCALES:
        local = numero[len(PREFIJO_PAIS):]
        return f"+{PREFIJO_PAIS} {local[:4]}-{local[4:]}"
    return "+" + numero


def fecha_larga_es(dia):
    """date -> "martes 28 de octubre"."""
    return f"{DIAS_ES[dia.weekday()]} {dia.day} de {MESES_ES[dia.month - 1]}"


def armar_mensaje(plantilla, cliente, fecha_texto, vendedor):
    """Reemplaza {cliente} {fecha} {vendedor} en la plantilla. Es un
    reemplazo simple (no str.format): cualquier otra llave que el dueño
    escriba en la plantilla se deja tal cual en vez de romper."""
    texto = plantilla if plantilla and plantilla.strip() else PLANTILLA_DEFECTO
    for marcador, valor in (
        ("{cliente}", cliente), ("{fecha}", fecha_texto), ("{vendedor}", vendedor),
    ):
        texto = texto.replace(marcador, valor or "")
    return texto.strip()


def url_whatsapp(numero, mensaje):
    """Enlace wa.me con el mensaje ya armado y codificado."""
    if not numero:
        return ""
    return f"https://wa.me/{numero}?text={quote(mensaje or '', safe='')}"


def umbral_valido(crudo, defecto=UMBRAL_ESPERADO_DEFECTO):
    """Umbral guardado en un parámetro del sistema (texto) -> número;
    si está vacío o mal escrito, el defecto."""
    try:
        valor = float(str(crudo).strip().replace(",", "."))
    except (TypeError, ValueError):
        return defecto
    return valor if valor >= 0 else defecto


def es_cliente_grande(clase, esperado, umbral=UMBRAL_ESPERADO_DEFECTO):
    """Clase A o A2, o valor esperado a partir del umbral."""
    return clase in CLASES_GRANDES or (esperado or 0.0) >= umbral


def en_ventana_aviso(fecha, hoy, dias=DIAS_AVISO):
    """True si `fecha` cae entre mañana y dentro de `dias` días (ambos
    incluidos). Hoy y el pasado no se avisan."""
    if not fecha or not hoy:
        return False
    return 1 <= (fecha - hoy).days <= dias
