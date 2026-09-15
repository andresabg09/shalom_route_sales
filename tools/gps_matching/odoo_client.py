"""
Cliente mínimo para hablar con Odoo por su API externa estándar
(XML-RPC, con fallback opcional a JSON-RPC si el egress de donde se
corra esto no llega al endpoint XML-RPC). NUNCA hardcodea credenciales
-- todo sale de variables de entorno:

  ODOO_URL       -- URL pública HTTPS de Odoo (ej. https://xxx.dominio.com,
                     el mismo dominio con el que se entra por navegador --
                     NO la IP cruda de la VM).
  ODOO_DB        -- nombre de la base (producción: "shalom").
  ODOO_USERNAME  -- login del usuario Odoo (el mismo con el que se entra
                     a la interfaz web).
  ODOO_API_KEY   -- clave API generada en Ajustes > Usuarios y Compañías >
                     Usuarios > [el usuario] > pestaña "Seguridad de la
                     cuenta" > "Nueva clave API". NUNCA la contraseña real.
  ODOO_TRANSPORT -- "xmlrpc" (default) o "jsonrpc".

No es parte del addon shalom_location_map -- nunca se despliega al
servidor, opera como cualquier integración externa contra la API pública
de Odoo.
"""
import os
import xmlrpc.client

import requests


class OdooAuthError(RuntimeError):
    """La autenticación contra Odoo fue rechazada, o una llamada de la
    API devolvió un error."""


class OdooClient:
    def __init__(self):
        self.url = _env("ODOO_URL").rstrip("/")
        self.db = _env("ODOO_DB")
        self.username = _env("ODOO_USERNAME")
        self.api_key = _env("ODOO_API_KEY")
        self.transport = os.environ.get("ODOO_TRANSPORT", "xmlrpc").strip().lower()
        if self.transport not in ("xmlrpc", "jsonrpc"):
            raise ValueError(
                f"ODOO_TRANSPORT inválido: {self.transport!r} "
                "(usar 'xmlrpc' o 'jsonrpc')."
            )
        self._uid = None
        if self.transport == "xmlrpc":
            self._common = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/common")
            self._models = xmlrpc.client.ServerProxy(f"{self.url}/xmlrpc/2/object")

    @property
    def uid(self):
        if self._uid is None:
            self._autenticar()
        return self._uid

    def _autenticar(self):
        if self.transport == "xmlrpc":
            uid = self._common.authenticate(self.db, self.username, self.api_key, {})
        else:
            uid = self._jsonrpc(
                "common", "authenticate",
                [self.db, self.username, self.api_key, {}],
            )
        if not uid:
            raise OdooAuthError(
                "Odoo rechazó la autenticación -- revisá ODOO_URL/ODOO_DB/"
                "ODOO_USERNAME/ODOO_API_KEY (ver tools/gps_matching/README.md)."
            )
        self._uid = uid

    def execute_kw(self, model, method, args, kwargs=None):
        kwargs = kwargs or {}
        if self.transport == "xmlrpc":
            try:
                return self._models.execute_kw(
                    self.db, self.uid, self.api_key, model, method, args, kwargs
                )
            except xmlrpc.client.Fault as exc:
                raise OdooAuthError(str(exc)) from exc
        return self._jsonrpc(
            "object", "execute_kw",
            [self.db, self.uid, self.api_key, model, method, args, kwargs],
        )

    def _jsonrpc(self, service, method, args):
        payload = {
            "jsonrpc": "2.0",
            "method": "call",
            "params": {"service": service, "method": method, "args": args},
            "id": 1,
        }
        response = requests.post(f"{self.url}/jsonrpc", json=payload, timeout=30)
        response.raise_for_status()
        data = response.json()
        if "error" in data:
            raise OdooAuthError(data["error"])
        return data["result"]

    # -- helpers de conveniencia, para no repetir execute_kw a mano --

    def search_read(self, model, domain, fields, limit=0, order=None):
        kwargs = {"fields": fields}
        if limit:
            kwargs["limit"] = limit
        if order:
            kwargs["order"] = order
        return self.execute_kw(model, "search_read", [domain], kwargs)

    def call_method(self, model, method, record_id, args=None):
        """Llama a un método de instancia (ej. shalom_actualizar_gps)
        sobre UN registro puntual -- equivalente a
        recordset.metodo(*args) en el ORM."""
        return self.execute_kw(model, method, [[record_id], *(args or [])])


def _env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"Falta la variable de entorno {name} -- ver "
            "tools/gps_matching/README.md."
        )
    return value
