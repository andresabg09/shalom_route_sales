/** @odoo-module **/

/**
 * Duración (ms) de la animación de SALIDA de los popups/pantallas de la
 * app del vendedor (hoja de visita, ficha de cliente, catálogo+carrito).
 * Tiene que coincidir con la keyframe "-out" correspondiente en
 * ruta_shalom.scss -- si se cambia acá, cambiar también allá.
 *
 * Corta a propósito (no es un efecto decorativo largo): tiene que
 * sentirse sólido y rápido para un vendedor que abre/cierra estas
 * pantallas muchas veces por día, sin ser un salto brusco.
 */
export const DURACION_CIERRE_MS = 170;

/**
 * Dispara la animación de salida de un popup y recién después de
 * DURACION_CIERRE_MS llama a cerrarFn() -- la que de verdad desmonta el
 * componente (props.onCerrar/onCancelar, etc). Sin esto, Owl saca el
 * nodo del DOM apenas cambia el t-if y la animación de salida nunca
 * llega a verse.
 *
 * `state` es el useState() del componente; agrega/lee `state.cerrando`,
 * que la vista usa para sumar la clase "closing" al overlay (ver
 * ruta_shalom.scss). Idempotente: un segundo llamado mientras ya se
 * está cerrando no hace nada (mismo criterio que los guards
 * _cerrando/_cerrado que ya existían en cada componente antes de esto).
 */
export function cerrarConAnimacion(state, cerrarFn) {
    if (state.cerrando) {
        return;
    }
    state.cerrando = true;
    setTimeout(cerrarFn, DURACION_CIERRE_MS);
}
