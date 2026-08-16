/** @odoo-module **/

import {Component, useState} from "@odoo/owl";
import {registry} from "@web/core/registry";
import {RutasHub} from "./rutas_hub";
import {RutaDetalle} from "./ruta_detalle";

/**
 * Shell de la app del vendedor "Ruta Shalom": nav inferior (Rutas /
 * Cotizaciones / Clientes) + la pantalla activa. Registrada como
 * ir.actions.client (tag "shalom_ruta_app"), colgada del menú Servicio
 * de Campo -> Operaciones -- no reemplaza ninguna vista nativa, es
 * exclusivamente el flujo diario del vendedor (ver
 * docs/plan_fase_1_a_4.md).
 *
 * Fase 1: shell + pestaña Rutas (hub) + detalle de ruta (Lista/Mapa).
 * "ruta-detalle" cuelga de la pestaña Rutas (se llega tocando una
 * ruta del hub), no tiene ítem propio en la barra inferior -- igual
 * que en el prototipo de referencia.
 * Cotizaciones y Clientes son Fase 4: por ahora muestran un aviso de
 * "disponible próximamente" en vez de quedar como ítems muertos.
 */
export class ShalomRutaApp extends Component {
    static template = "shalom_location_map.RutaShalomApp";
    static components = {RutasHub, RutaDetalle};
    static props = ["*"];

    setup() {
        this.state = useState({
            screen: "rutas", // rutas | ruta-detalle | cotizaciones | clientes
            scheduleActivo: null,
        });
    }

    abrirRuta(schedule) {
        this.state.scheduleActivo = schedule;
        this.state.screen = "ruta-detalle";
    }

    volverARutas() {
        this.state.screen = "rutas";
        this.state.scheduleActivo = null;
    }

    irA(pantalla) {
        this.state.screen = pantalla;
    }
}

registry.category("actions").add("shalom_ruta_app", ShalomRutaApp);
