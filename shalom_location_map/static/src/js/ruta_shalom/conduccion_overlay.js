/** @odoo-module **/

import {Component} from "@odoo/owl";

/**
 * Aviso del modo conducción: "Vas en movimiento -- la pantalla espera".
 * Solo se dibuja; cuándo mostrarlo lo decide RutaDetalle (nunca durante la
 * navegación en vivo, nunca sobre el mapa) con las reglas de
 * conduccion_utils.js. El interruptor "Voy de copiloto" es lo único que se
 * puede tocar.
 */
export class ConduccionOverlay extends Component {
    static template = "shalom_location_map.ConduccionOverlay";
    static props = {
        kmh: Number,
        onCopiloto: Function,
    };
}
