/** @odoo-module **/

/**
 * Utilidades de red para la calle (Fase 0 del plan de modo offline):
 * timeouts reales para las llamadas al servidor y sondeos periódicos
 * que se adaptan a la señal.
 *
 * Por qué hace falta: el rpc() de Odoo 18 NO tiene timeout. Con "señal
 * fantasma" (barras de señal pero sin datos que pasen), una llamada
 * puede quedar colgada minutos -- y como cada sondeo tiene su candado
 * de "uno a la vez", un solo pedido colgado congelaba ese sondeo para
 * siempre. Además, los sondeos seguían golpeando la red a ritmo fijo
 * (1-8 seg) aunque no hubiera señal, gastando datos y batería y
 * compitiendo con lo que el vendedor sí está esperando.
 */

/** La llamada no respondió a tiempo (se cortó a propósito). */
export class TiempoAgotadoError extends Error {
    constructor(ms) {
        super(`Sin respuesta del servidor en ${ms} ms`);
        this.name = "TiempoAgotadoError";
    }
}

/** True SOLO si el navegador está seguro de que no hay red (modo
 * avión, sin datos). OJO: navigator.onLine === true NO garantiza que
 * haya internet de verdad (señal fantasma) -- para eso están los
 * timeouts. */
export function sinConexion() {
    return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Corre `promesa` (normalmente un this.orm.call(...)) con un límite de
 * tiempo. Si no responde en `ms`, se corta la petición de verdad (con
 * el .abort() que trae la promesa del rpc de Odoo 18, que además avisa
 * al indicador de "Cargando" para que no quede colgado) y se rechaza
 * con TiempoAgotadoError.
 */
export function conTimeout(promesa, ms) {
    let timer;
    const limite = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            if (promesa && typeof promesa.abort === "function") {
                try {
                    // false: que la promesa original no rechace por su
                    // cuenta (ya rechazamos nosotros acá abajo).
                    promesa.abort(false);
                } catch {
                    // abortar es best-effort
                }
            }
            reject(new TiempoAgotadoError(ms));
        }, ms);
    });
    return Promise.race([promesa, limite]).finally(() => clearTimeout(timer));
}

/** Espera antes del próximo intento tras `fallos` fallas seguidas:
 * crece al doble cada vez, con tope, y un ±20% al azar para que varios
 * teléfonos no reintenten todos al mismo instante. */
export function esperaConBackoff(baseMs, fallos, topeMs) {
    const espera = Math.min(topeMs, baseMs * 2 ** Math.max(0, fallos));
    return Math.round(espera * (0.8 + Math.random() * 0.4));
}

/**
 * Sondeo periódico que se adapta a la red. Reemplaza a
 * setInterval(fn, intervaloMs):
 *
 * - Nunca hay dos corridas a la vez (si una tarda, la próxima espera).
 * - Si `fn` falla (rechaza o devuelve `false`), la próxima espera
 *   crece: base x2, x4, ... hasta `topeMs`. Al primer éxito vuelve al
 *   ritmo normal.
 * - Sin red segura (modo avión) o con la pestaña oculta
 *   (`pausarSiOculto`), no se llama a `fn`: solo se vuelve a mirar en
 *   `intervaloMs` (chequeo local, sin tocar la red).
 * - Al volver la red (evento "online") o la pestaña, corre de una.
 * - `ritmoFijo`: la espera se cuenta desde el INICIO de la corrida
 *   anterior (como setInterval), no desde que terminó -- para el
 *   latido del catálogo, que el servidor espera cada ~1 seg.
 *
 * Devuelve {detener()}: llamarlo en onWillUnmount.
 */
export function iniciarSondeo(fn, {intervaloMs, topeMs = 30000, pausarSiOculto = true, ritmoFijo = false}) {
    let fallos = 0;
    let timer = null;
    let detenido = false;
    let corriendo = false;

    const programar = (ms) => {
        clearTimeout(timer);
        if (!detenido) {
            timer = setTimeout(correr, ms);
        }
    };

    const correr = async () => {
        if (detenido || corriendo) {
            return;
        }
        if (sinConexion() || (pausarSiOculto && document.hidden)) {
            programar(intervaloMs);
            return;
        }
        corriendo = true;
        const inicio = Date.now();
        let ok;
        try {
            ok = (await fn()) !== false;
        } catch {
            ok = false;
        }
        corriendo = false;
        if (ok) {
            fallos = 0;
            const transcurrido = Date.now() - inicio;
            programar(ritmoFijo ? Math.max(100, intervaloMs - transcurrido) : intervaloMs);
        } else {
            fallos += 1;
            programar(esperaConBackoff(intervaloMs, fallos, topeMs));
        }
    };

    const alVolver = () => {
        if (!detenido && !corriendo && !(pausarSiOculto && document.hidden)) {
            fallos = 0;
            programar(0);
        }
    };
    const alCambiarVisibilidad = () => {
        if (!document.hidden) {
            alVolver();
        }
    };
    window.addEventListener("online", alVolver);
    document.addEventListener("visibilitychange", alCambiarVisibilidad);

    programar(intervaloMs);

    return {
        detener() {
            detenido = true;
            clearTimeout(timer);
            window.removeEventListener("online", alVolver);
            document.removeEventListener("visibilitychange", alCambiarVisibilidad);
        },
    };
}
