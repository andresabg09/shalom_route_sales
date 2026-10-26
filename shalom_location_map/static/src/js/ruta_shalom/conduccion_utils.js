/** @odoo-module **/

import {onMounted, onWillUnmount, useState} from "@odoo/owl";
import {distanciaMetros} from "./navegacion_utils";

/**
 * Modo conducción (Fase 6B del juego de ventas): si el vendedor va en
 * movimiento, la LISTA de clientes y las hojas de pedido esperan detrás de
 * un aviso ("Vas en movimiento -- la pantalla espera") hasta que se
 * detenga. Las reglas de arriba están aquí como funciones puras (se
 * prueban sin pantalla, ver tools/owl_check/escenarios_6b.js) y el hook
 * useConduccion() las conecta al GPS del celular.
 *
 * Reglas:
 *  - Se activa a más de 15 km/h. La velocidad sale de la lectura de GPS
 *    (coords.speed, en m/s); si el celular no la entrega, se estima con la
 *    distancia recorrida entre dos lecturas.
 *  - Se quita sola tras ~5 s por debajo de 5 km/h (entre 5 y 15 km/h no
 *    cambia nada: evita parpadeos en un semáforo o una curva lenta).
 *  - "Voy de copiloto" lo desactiva por completo (se recuerda en este
 *    dispositivo, ver CLAVE_COPILOTO; caduca a las 12 horas para que un
 *    conductor distinto no herede un "copiloto" olvidado).
 *  - FALLA ABIERTO: sin permiso de GPS, sin lecturas o con lecturas viejas
 *    (más de 20 s) no se muestra nada. Un aviso que se queda pegado sin
 *    razón es peor que no tenerlo.
 *  - La vigilancia de GPS vive SOLO mientras el componente que usa el hook
 *    (RutaDetalle) está en pantalla.
 *  - El overlay NUNCA cubre la navegación en vivo ("Trazar ruta aquí"): eso
 *    lo decide RutaDetalle (mostrarConduccion), el conductor la necesita.
 */

export const VELOCIDAD_ACTIVA_KMH = 15;
export const VELOCIDAD_QUIETO_KMH = 5;
export const ESPERA_QUIETO_MS = 5000;
export const SIN_LECTURAS_MS = 20000;
// Para estimar la velocidad entre lecturas: se compara contra una lectura
// de hace al menos 3 s (con 1 s de por medio el ruido del GPS parece una
// velocidad) y como mucho 30 s.
export const ESTIMAR_MIN_MS = 3000;
export const ESTIMAR_MAX_MS = 30000;
// Lecturas con peor precisión (metros) no sirven para estimar velocidad.
export const PRECISION_MAXIMA_M = 100;
export const RUIDO_MINIMO_M = 8;
export const INTERVALO_REVISION_MS = 500;

export const CLAVE_COPILOTO = "shalom_copiloto";
export const CADUCIDAD_COPILOTO_MS = 12 * 60 * 60 * 1000;

/** Velocidad (km/h) de una lectura de GPS de navegador, o null si no
 * trae `coords.speed` usable (null / NaN / negativa). */
export function velocidadDeLectura(position) {
    const v = position && position.coords ? position.coords.speed : null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        return null;
    }
    return v * 3.6;
}

/**
 * Velocidad (km/h) estimada entre dos lecturas {lat, lng, ts (ms),
 * accuracy (m)}: `antes` más vieja que `ahora`. Null si no se puede estimar
 * (tiempos fuera de rango o precisión mala). Si el desplazamiento es menor
 * que el ruido del propio GPS se considera que está quieto (0).
 */
export function velocidadEstimadaKmh(antes, ahora) {
    if (!antes || !ahora) {
        return null;
    }
    const dt = ahora.ts - antes.ts;
    if (dt < ESTIMAR_MIN_MS || dt > ESTIMAR_MAX_MS) {
        return null;
    }
    if ((antes.accuracy || 0) > PRECISION_MAXIMA_M || (ahora.accuracy || 0) > PRECISION_MAXIMA_M) {
        return null;
    }
    const metros = distanciaMetros(antes.lat, antes.lng, ahora.lat, ahora.lng);
    const ruido = Math.max(antes.accuracy || 0, ahora.accuracy || 0, RUIDO_MINIMO_M);
    if (metros <= ruido) {
        return 0;
    }
    return (metros / (dt / 1000)) * 3.6;
}

export function estadoConduccionInicial() {
    return {enMovimiento: false, quietoDesde: null, ultimaLectura: null};
}

/**
 * Máquina de estados del modo conducción (pura). `estado` viene de
 * estadoConduccionInicial()/de la llamada anterior; `kmh` es la velocidad
 * de una lectura NUEVA, o null/undefined si solo pasó el tiempo (revisión
 * periódica); `ahora` es Date.now(). Devuelve el estado nuevo.
 */
export function avanzarConduccion(estado, kmh, ahora) {
    let {enMovimiento, quietoDesde, ultimaLectura} = estado;
    if (typeof kmh === "number" && Number.isFinite(kmh)) {
        ultimaLectura = ahora;
        if (kmh > VELOCIDAD_ACTIVA_KMH) {
            enMovimiento = true;
            quietoDesde = null;
        } else if (kmh < VELOCIDAD_QUIETO_KMH) {
            if (enMovimiento && quietoDesde === null) {
                quietoDesde = ahora;
            }
        } else {
            // entre 5 y 15 km/h: no se activa ni se suelta todavía
            quietoDesde = null;
        }
    }
    if (enMovimiento && quietoDesde !== null && ahora - quietoDesde >= ESPERA_QUIETO_MS) {
        enMovimiento = false;
        quietoDesde = null;
    }
    // Sin lecturas desde hace rato (túnel, GPS apagado): no hay base para
    // seguir bloqueando.
    if (enMovimiento && ultimaLectura !== null && ahora - ultimaLectura > SIN_LECTURAS_MS) {
        enMovimiento = false;
        quietoDesde = null;
    }
    return {enMovimiento, quietoDesde, ultimaLectura};
}

/** "Voy de copiloto" recordado en este dispositivo (con caducidad). */
export function leerCopiloto(ahora = Date.now()) {
    try {
        const crudo = localStorage.getItem(CLAVE_COPILOTO);
        if (!crudo) {
            return false;
        }
        const dato = JSON.parse(crudo);
        return !!(dato && dato.copiloto && ahora - dato.ts < CADUCIDAD_COPILOTO_MS);
    } catch (error) {
        return false;
    }
}

export function guardarCopiloto(valor, ahora = Date.now()) {
    try {
        if (valor) {
            localStorage.setItem(CLAVE_COPILOTO, JSON.stringify({copiloto: true, ts: ahora}));
        } else {
            localStorage.removeItem(CLAVE_COPILOTO);
        }
    } catch (error) {
        // sin localStorage: simplemente no se recuerda
    }
}

/**
 * Hook: vigila el GPS mientras el componente está montado y expone un
 * estado reactivo {kmh, enMovimiento, copiloto, setCopiloto(valor)}.
 * No arma ni toca ninguna pantalla: quien lo usa decide cuándo mostrar el
 * aviso. No hace nada si el navegador no tiene geolocalización, si el
 * permiso está denegado, o mientras "Voy de copiloto" está activo.
 */
export function useConduccion() {
    const estado = useState({
        kmh: 0,
        enMovimiento: false,
        copiloto: leerCopiloto(),
    });
    let watchId = null;
    let revisionId = null;
    let maquina = estadoConduccionInicial();
    let lecturas = []; // últimas lecturas {lat, lng, ts, accuracy}, para estimar la velocidad

    const aplicar = (nueva) => {
        maquina = nueva;
        if (estado.enMovimiento !== nueva.enMovimiento) {
            estado.enMovimiento = nueva.enMovimiento;
        }
    };

    const alLeer = (position) => {
        if (!position || !position.coords) {
            return;
        }
        const ahora = Date.now();
        const lectura = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            ts: ahora,
            accuracy: position.coords.accuracy,
        };
        let kmh = velocidadDeLectura(position);
        if (kmh === null) {
            // Sin coords.speed: se estima contra la lectura más reciente que
            // tenga entre 3 y 30 s de antigüedad.
            const base = [...lecturas].reverse().find((l) => ahora - l.ts >= ESTIMAR_MIN_MS);
            kmh = velocidadEstimadaKmh(base, lectura);
        }
        lecturas.push(lectura);
        lecturas = lecturas.filter((l) => ahora - l.ts <= ESTIMAR_MAX_MS);
        if (kmh !== null) {
            estado.kmh = Math.round(kmh);
        }
        aplicar(avanzarConduccion(maquina, kmh, ahora));
    };

    const detener = () => {
        if (watchId !== null && typeof navigator !== "undefined" && navigator.geolocation) {
            navigator.geolocation.clearWatch(watchId);
        }
        watchId = null;
        if (revisionId !== null) {
            clearInterval(revisionId);
            revisionId = null;
        }
        maquina = estadoConduccionInicial();
        lecturas = [];
        estado.enMovimiento = false;
        estado.kmh = 0;
    };

    const iniciar = () => {
        if (watchId !== null || estado.copiloto) {
            return;
        }
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            return;
        }
        try {
            watchId = navigator.geolocation.watchPosition(
                alLeer,
                () => {
                    // Sin permiso o sin señal: no se hace nada (falla abierto).
                },
                {enableHighAccuracy: true, maximumAge: 1000, timeout: 15000}
            );
        } catch (error) {
            watchId = null;
            return;
        }
        revisionId = setInterval(
            () => aplicar(avanzarConduccion(maquina, null, Date.now())),
            INTERVALO_REVISION_MS
        );
    };

    estado.setCopiloto = (valor) => {
        estado.copiloto = !!valor;
        guardarCopiloto(!!valor);
        if (valor) {
            detener();
        } else {
            iniciar();
        }
    };

    onMounted(iniciar);
    onWillUnmount(detener);
    return estado;
}
