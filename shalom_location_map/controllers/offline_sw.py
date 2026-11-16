# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""Modo offline (Fase 4): marca de versión al final del service worker de
Odoo 18 (/web/service-worker.js).

El service worker de Odoo guarda la página "sin señal" (/odoo/offline) al
instalarse, y el navegador solo lo reinstala cuando su contenido cambia.
Esta línea de comentario cambia cuando cambia esa página (ver
views/offline_page.xml), para que los teléfonos guarden la versión nueva.
Mismo mecanismo que usa el módulo `mail` para agregar sus notificaciones:
se extiende _get_service_worker_content(), no se reemplaza nada."""
from odoo.addons.web.controllers import webmanifest

VERSION_PAGINA_OFFLINE = "shalom-offline-1"


class ShalomWebManifest(webmanifest.WebManifest):
    def _get_service_worker_content(self):
        body = super()._get_service_worker_content()
        return body + f"\n// {VERSION_PAGINA_OFFLINE}\n"
