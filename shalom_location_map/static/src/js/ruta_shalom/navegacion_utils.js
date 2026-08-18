/** @odoo-module **/

/**
 * Matemática y llamadas a Mapbox usadas por el modo "Trazar ruta aquí"
 * (navegación en vivo estilo Waze dentro de RutaDetalle, ver
 * ruta_detalle.js): pedir el trazado real calle-por-calle desde la
 * posición del vendedor hasta un cliente, y recortar ese trazado a
 * medida que el vendedor avanza.
 *
 * Sin dependencias externas (turf, etc.) a propósito -- mismo criterio
 * que ya usa ruta_detalle.js para la paletita direccional
 * (calcularRumbo/posicionEnBorde): la escala es "una ciudad", así que
 * una proyección equirectangular simple (longitud escalada por
 * cos(latitud)) alcanza y sobra, sin sumar un paquete más al bundle.
 */

const RADIO_TIERRA_M = 6371000;

/** Distancia en metros entre dos puntos (lat/lng), fórmula haversine. */
export function distanciaMetros(lat1, lng1, lat2, lng2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * RADIO_TIERRA_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Pide a Mapbox Directions API el trazado calle-por-calle entre dos
 * puntos (perfil "driving", igual que fsm_route.py usa para el trazado
 * completo de una ruta -- ver action_calcular_trazado_ruta -- pero acá
 * punto a punto y desde el navegador con el token público). Devuelve
 * null si Mapbox no encontró camino; nunca lanza por eso, solo por
 * errores de red/HTTP, que sí interesa que quien llama atrape y avise.
 */
export async function obtenerDirecciones(origen, destino, token) {
    const url =
        "https://api.mapbox.com/directions/v5/mapbox/driving/" +
        `${origen.lng},${origen.lat};${destino.lng},${destino.lat}` +
        `?geometries=geojson&overview=full&access_token=${token}`;
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Mapbox Directions respondió ${resp.status}`);
    }
    const datos = await resp.json();
    if (!datos.routes || !datos.routes.length) {
        return null;
    }
    const ruta = datos.routes[0];
    return {
        coordenadas: ruta.geometry.coordinates, // [[lng, lat], ...]
        distanciaM: ruta.distance,
        duracionS: ruta.duration,
    };
}

/**
 * Punto de la polilínea `coordenadas` ([lng,lat], ...) más cercano a
 * `punto` ({lat,lng}), proyectando sobre cada SEGMENTO (no solo sobre
 * los vértices) para que el recorte estilo Waze sea suave en vez de
 * saltar de vértice en vértice. Devuelve
 * {indiceSegmento, puntoProyectado: [lng,lat], distanciaM}, o null si
 * `coordenadas` no tiene al menos 2 puntos.
 */
export function proyectarSobrePolilinea(punto, coordenadas) {
    if (!coordenadas || coordenadas.length < 2) {
        return null;
    }
    let mejor = null;
    for (let i = 0; i < coordenadas.length - 1; i++) {
        const [lngA, latA] = coordenadas[i];
        const [lngB, latB] = coordenadas[i + 1];
        const latMedia = ((latA + latB) / 2) * (Math.PI / 180);
        const escalaLng = Math.cos(latMedia);

        // Coordenadas locales "aplanadas" (solo para hallar la
        // proyección y el t dentro del segmento -- no son metros
        // reales, la distancia final se recalcula con haversine).
        const ax = lngA * escalaLng;
        const ay = latA;
        const bx = lngB * escalaLng;
        const by = latB;
        const px = punto.lng * escalaLng;
        const py = punto.lat;

        const dx = bx - ax;
        const dy = by - ay;
        const largo2 = dx * dx + dy * dy;
        let t = largo2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / largo2 : 0;
        t = Math.max(0, Math.min(1, t));

        const projLng = lngA + (lngB - lngA) * t;
        const projLat = latA + (latB - latA) * t;
        const dist = distanciaMetros(punto.lat, punto.lng, projLat, projLng);

        if (!mejor || dist < mejor.distanciaM) {
            mejor = {indiceSegmento: i, puntoProyectado: [projLng, projLat], distanciaM: dist};
        }
    }
    return mejor;
}

/**
 * Recorta `coordenadas` al tramo que falta recorrer desde `punto`: el
 * punto proyectado sobre la línea, seguido del resto de vértices
 * después de ese segmento -- efecto "la línea se va comiendo detrás
 * tuyo" (estilo Waze/Google Maps en navegación). Devuelve también la
 * distancia de `punto` a la línea (para decidir si hace falta
 * recalcular la ruta -- ver UMBRAL_RECALCULO_M en ruta_detalle.js).
 */
export function recortarPolilineaDesde(punto, coordenadas) {
    const proyeccion = proyectarSobrePolilinea(punto, coordenadas);
    if (!proyeccion) {
        return {coordenadas, distanciaALaLineaM: 0};
    }
    return {
        coordenadas: [proyeccion.puntoProyectado, ...coordenadas.slice(proyeccion.indiceSegmento + 1)],
        distanciaALaLineaM: proyeccion.distanciaM,
    };
}
