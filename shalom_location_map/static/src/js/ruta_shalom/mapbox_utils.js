/** @odoo-module **/

import {loadJS} from "@web/core/assets";
import {rpc} from "@web/core/network/rpc";

/**
 * Helpers compartidos por las pantallas de la app "Ruta Shalom" que
 * necesitan pintar un mapa Mapbox real (detalle de ruta, y más adelante
 * la hoja de visita). Mismo patrón que ya usa
 * static/src/js/mini_mapa_widget.js -- separado en su propio módulo
 * porque acá lo van a importar varios componentes, no uno solo.
 */

const MAPBOX_GL_JS_URL = "https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.js";
const MAPBOX_GL_CSS_URL = "https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.css";

let mapboxTokenCache = null;

export async function getMapboxToken() {
    if (mapboxTokenCache) {
        return mapboxTokenCache;
    }
    mapboxTokenCache = await rpc("/shalom_location_map/mapbox_public_token");
    return mapboxTokenCache;
}

export async function cargarMapboxGl() {
    await loadJS(MAPBOX_GL_JS_URL);
    if (!document.querySelector(`link[href="${MAPBOX_GL_CSS_URL}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = MAPBOX_GL_CSS_URL;
        document.head.appendChild(link);
    }
}

/**
 * Convierte el WKT "LINESTRING(lng lat, lng lat, ...)" que devuelve
 * fsm.route.x_ruta_trazado (campo GeoLine de base_geoengine) en un
 * array de coordenadas [lng, lat] listo para usar como geometría
 * GeoJSON en una fuente de Mapbox GL.
 *
 * Nunca lanza: si no hay trazado guardado todavía (la ruta no pasó por
 * "Calcular trazado de ruta") o el formato no es el esperado, devuelve
 * null y el mapa simplemente no dibuja la línea -- los marcadores de
 * cada cliente igual se ven.
 */
export function parseWktLineString(wkt) {
    if (!wkt || typeof wkt !== "string") {
        return null;
    }
    const match = wkt.trim().match(/^LINESTRING\s*\(([^)]+)\)$/i);
    if (!match) {
        return null;
    }
    const coordenadas = match[1]
        .split(",")
        .map((par) => par.trim().split(/\s+/).map(Number))
        .filter((par) => par.length === 2 && par.every((n) => Number.isFinite(n)));
    return coordenadas.length >= 2 ? coordenadas : null;
}
