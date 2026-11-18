# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
"""Modo offline: agregados al service worker de Odoo 18 (/web/service-worker.js).

1. Marca de versión. El service worker de Odoo guarda la página "sin señal"
   (/odoo/offline) al instalarse, y el navegador solo lo reinstala cuando su
   contenido cambia. La línea de versión cambia cuando cambia esa página
   (ver views/offline_page.xml) o este archivo, para que los teléfonos tomen
   la versión nueva.
2. Fotos del catálogo guardadas en el teléfono (Cache Storage
   "shalom-fotos-v1"), igual que los datos del modo offline: primero lo
   guardado (al instante, también sin señal) y, si falta, internet.
   Bug real reportado: la caché HTTP de Chrome en Android es chica y la
   comparten todos los sitios; las ~2300 fotos de 512 px no entran y Chrome
   las iba sacando, así que el catálogo no siempre cargaba al instante.
   Solo se interceptan fotos de producto de 256/512 px CON versión
   (?unique=), que Odoo ya sirve como inmutables por 1 año: el resultado es
   el mismo que la caché HTTP, pero en almacenamiento propio del sitio. Las
   de 1024/1920 px (zoom) no se tocan: van por internet.
   Ante cualquier error, la foto se pide a internet como siempre.

Mismo mecanismo que usa el módulo `mail` para agregar sus notificaciones:
se extiende _get_service_worker_content(), no se reemplaza nada."""
from odoo.addons.web.controllers import webmanifest

VERSION_PAGINA_OFFLINE = "shalom-offline-3"

# Mismo nombre que CACHE_FOTOS en static/src/js/ruta_shalom/datos_offline.js
CACHE_FOTOS = "shalom-fotos-v1"

SW_FOTOS = """
// shalom: fotos del catálogo guardadas en el teléfono
(() => {
    const CACHE_FOTOS = "%(cache)s";
    const PATRON = /^\\/web\\/image\\/product\\.product\\/\\d+\\/image_(256|512)$/;
    // La versión nueva toma el control sin cerrar la app (los vendedores no
    // la cierran en todo el día).
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
    // Clave de la foto (sin el _r de los reintentos) o null si no se guarda.
    const claveFoto = (request) => {
        if (request.method !== "GET") {
            return null;
        }
        const aceptar = request.headers.get("accept") || "";
        if (request.mode === "navigate" || aceptar.includes("text/html")) {
            return null;
        }
        const url = new URL(request.url);
        if (url.origin !== self.location.origin || !PATRON.test(url.pathname) || !url.searchParams.get("unique")) {
            return null;
        }
        for (const clave of url.searchParams.keys()) {
            if (clave !== "unique" && clave !== "_r") {
                return null;
            }
        }
        url.searchParams.delete("_r");
        return url.href;
    };
    const servirFoto = async (request, clave) => {
        let cache = null;
        try {
            cache = await caches.open(CACHE_FOTOS);
            const guardada = await cache.match(clave);
            if (guardada) {
                return guardada;
            }
        } catch (error) {
            cache = null;
        }
        const respuesta = await fetch(request);
        const tipo = respuesta.headers.get("content-type") || "";
        if (cache && respuesta.status === 200 && tipo.startsWith("image/")) {
            cache.put(clave, respuesta.clone()).catch(() => {});
        }
        return respuesta;
    };
    // Fotos bajadas por el sistema en segundo plano (Background Fetch, Chrome
    // en Android): llegan aunque la pantalla esté apagada o la app cerrada;
    // acá se guardan en la misma caché. Solo lotes propios ("shalom-fotos-").
    const guardarLoteSegundoPlano = async (registro) => {
        const cache = await caches.open(CACHE_FOTOS);
        for (const registroFoto of await registro.matchAll()) {
            try {
                const respuesta = await registroFoto.responseReady;
                const tipo = respuesta.headers.get("content-type") || "";
                const clave = claveFoto(registroFoto.request);
                if (clave && respuesta.status === 200 && tipo.startsWith("image/")) {
                    await cache.put(clave, respuesta);
                }
            } catch (error) {
                // esa foto falló: se pedirá la próxima vez que se abra la app
            }
        }
    };
    const alTerminarLote = (event) => {
        if (event.registration.id.startsWith("shalom-fotos-")) {
            event.waitUntil(guardarLoteSegundoPlano(event.registration).catch(() => {}));
        }
    };
    self.addEventListener("backgroundfetchsuccess", alTerminarLote);
    self.addEventListener("backgroundfetchfail", alTerminarLote);
    self.addEventListener("fetch", (event) => {
        let clave = null;
        try {
            clave = claveFoto(event.request);
        } catch (error) {
            clave = null;
        }
        if (clave) {
            event.respondWith(servirFoto(event.request, clave));
        }
    });
})();
""" % {"cache": CACHE_FOTOS}


class ShalomWebManifest(webmanifest.WebManifest):
    def _get_service_worker_content(self):
        body = super()._get_service_worker_content()
        return body + SW_FOTOS + f"\n// {VERSION_PAGINA_OFFLINE}\n"
