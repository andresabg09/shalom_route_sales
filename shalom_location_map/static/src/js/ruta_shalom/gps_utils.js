/** @odoo-module **/

// Ventana de tiempo (ms) durante la que se escucha activamente al GPS
// antes de resignarse a usar la mejor lectura obtenida. Un solo
// getCurrentPosition() puede devolver la última posición que el chip GPS
// tenía guardada en vez de forzar una lectura nueva (pasa en varios
// Android); escuchar unos segundos con watchPosition fuerza al chip a
// reportar de nuevo, en vez de conformarse con lo que ya tenía.
export const VENTANA_CAPTURA_GPS_MS = 7000;
// Si en la ventana aparece una lectura con esta precisión (metros) o
// mejor, se corta la espera ahí mismo -- no hace falta agotar toda la
// ventana si ya se consiguió una lectura suficientemente buena.
export const PRECISION_ACEPTABLE_METROS_GPS = 20;

/**
 * Escucha al GPS durante VENTANA_CAPTURA_GPS_MS y devuelve la lectura más
 * precisa (menor position.coords.accuracy) que haya aparecido en ese
 * tiempo, cortando antes si ya se consiguió una lectura con precisión
 * PRECISION_ACEPTABLE_METROS_GPS o mejor. Rechaza solo si no se obtuvo
 * ninguna lectura en toda la ventana.
 *
 * Compartido entre visit_sheet.js y cliente_form.js (los dos botones
 * "capturar mi ubicación" de la app) para evitar el bug de GPS
 * "reciclado": un solo getCurrentPosition(), aunque se le pida
 * maximumAge:0, puede devolver en varios Android la última posición que
 * el chip GPS tenía guardada en vez de forzar una lectura nueva --
 * dejando dos clientes visitados con minutos de diferencia registrados
 * en el mismo punto. Escuchar unos segundos con watchPosition fuerza al
 * chip a reportar de nuevo.
 */
export function capturarMejorPosicionGps() {
    return new Promise((resolve, reject) => {
        let mejor = null;
        let watchId = null;
        let terminado = false;

        const finalizar = (resultado, error) => {
            if (terminado) {
                return;
            }
            terminado = true;
            clearTimeout(temporizador);
            if (watchId !== null) {
                navigator.geolocation.clearWatch(watchId);
            }
            if (resultado) {
                resolve(resultado);
            } else {
                reject(error);
            }
        };

        const temporizador = setTimeout(() => {
            finalizar(mejor, mejor ? null : new Error("Se agotó el tiempo de espera del GPS."));
        }, VENTANA_CAPTURA_GPS_MS);

        watchId = navigator.geolocation.watchPosition(
            (position) => {
                if (!mejor || position.coords.accuracy < mejor.coords.accuracy) {
                    mejor = position;
                }
                if (position.coords.accuracy <= PRECISION_ACEPTABLE_METROS_GPS) {
                    finalizar(mejor);
                }
            },
            (error) => {
                // Un error puntual no corta la espera si ya hay una
                // lectura guardada -- se sigue esperando hasta el
                // temporizador por si llega algo mejor.
                if (!mejor) {
                    finalizar(null, error);
                }
            },
            {enableHighAccuracy: true, maximumAge: 0, timeout: VENTANA_CAPTURA_GPS_MS}
        );
    });
}
