/** @odoo-module **/

import {Component, onWillUnmount, useState} from "@odoo/owl";
import {registry} from "@web/core/registry";
import {RutasHub} from "./rutas_hub";
import {RutaDetalle} from "./ruta_detalle";
import {Cotizaciones} from "./cotizaciones";
import {Clientes} from "./clientes";
import {abrirNivel, cerrarNivel, desinstalarBackStack, instalarBackStack} from "./back_stack";

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
 * Fase 4: pestañas Cotizaciones (todas las sale.order de los clientes
 * asignados) y Clientes (directorio + alta rápida desde la calle).
 *
 * Historial de navegación (Atrás de Android): acá se instala la pila
 * de back_stack.js (instalarBackStack/desinstalarBackStack) y se
 * registra un nivel por cada cambio de pantalla/pestaña -- ver
 * abrirRuta()/volverARutas()/irA() más abajo y el comentario grande de
 * back_stack.js para el mecanismo completo. Las pantallas hijas
 * (VisitSheet, OrderScreen, ClienteForm) se registran solas, en su
 * propio setup()/cierre -- no hace falta que este shell sepa nada de
 * ellas.
 */
export class ShalomRutaApp extends Component {
    static template = "shalom_location_map.RutaShalomApp";
    static components = {RutasHub, RutaDetalle, Cotizaciones, Clientes};
    static props = ["*"];

    setup() {
        this.state = useState({
            screen: "rutas", // rutas | ruta-detalle | cotizaciones | clientes
            scheduleActivo: null,
        });
        // Función que "deshace" haber entrado a la ruta activa (ver
        // abrirRuta/volverARutas) -- separada de la pila genérica de
        // pestañas (irA) porque volverARutas() necesita poder sacar
        // ESE nivel puntual de la pila en vez de apilar uno nuevo.
        this._nivelRutaDetalle = null;

        instalarBackStack();
        onWillUnmount(() => desinstalarBackStack());
    }

    /**
     * Siempre se llega acá desde el hub (RutasHub, pestaña "rutas").
     * Guarda la función de cierre en this._nivelRutaDetalle para que
     * volverARutas() (el "←" propio de RutaDetalle) pueda deshacer
     * este mismo nivel en vez de apilar uno nuevo -- ver el comentario
     * grande de volverARutas().
     */
    abrirRuta(schedule) {
        const restaurar = () => {
            cerrarNivel(restaurar);
            this._nivelRutaDetalle = null;
            this.state.screen = "rutas";
            this.state.scheduleActivo = null;
        };
        this._nivelRutaDetalle = restaurar;
        abrirNivel(restaurar);
        this.state.screen = "ruta-detalle";
        this.state.scheduleActivo = schedule;
    }

    /**
     * "←" propio de RutaDetalle: deshace la navegación de abrirRuta()
     * (saca ESE nivel de la pila) en vez de apilar uno nuevo hacia el
     * hub -- si no, un Atrás de Android inmediatamente después de
     * tocar "←" volvía a meter al vendedor en la misma ruta que
     * acababa de cerrar a propósito.
     */
    volverARutas() {
        if (this._nivelRutaDetalle) {
            cerrarNivel(this._nivelRutaDetalle);
            this._nivelRutaDetalle = null;
        }
        this.state.screen = "rutas";
        this.state.scheduleActivo = null;
    }

    /**
     * Pestañas de la barra inferior (Rutas/Cotizaciones/Clientes).
     * Cada cambio queda registrado en la pila de navegación con una
     * función que restaura la pantalla ANTERIOR -- así el Atrás de
     * Android vuelve exactamente adonde estabas (una ruta puntual, otra
     * pestaña) en vez de siempre al hub de Rutas. Tocar la pestaña ya
     * activa no hace nada (ni cambia pantalla ni apila un nivel de
     * más).
     */
    irA(pantalla) {
        if (pantalla === this.state.screen) {
            return;
        }
        const anterior = this.state.screen;
        const restaurar = () => {
            cerrarNivel(restaurar);
            this.state.screen = anterior;
        };
        abrirNivel(restaurar);
        this.state.screen = pantalla;
    }
}

registry.category("actions").add("shalom_ruta_app", ShalomRutaApp);
