/** @odoo-module **/
import {onWillUnmount, useState} from "@odoo/owl";

const ANCHO_MINIMO_PX = 900;

/** Estado reactivo "pantalla ancha" (tablet horizontal / computadora): con él
 * las pantallas muestran el mapa y la lista lado a lado en vez de pestañas. */
export function useEsAncha() {
    const consulta = typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(`(min-width: ${ANCHO_MINIMO_PX}px)`)
        : null;
    const estado = useState({ancha: !!(consulta && consulta.matches)});
    if (consulta) {
        const alCambiar = (ev) => {
            estado.ancha = ev.matches;
        };
        consulta.addEventListener("change", alCambiar);
        onWillUnmount(() => consulta.removeEventListener("change", alCambiar));
    }
    return estado;
}
