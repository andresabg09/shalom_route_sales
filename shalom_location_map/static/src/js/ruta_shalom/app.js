/** @odoo-module **/

import {Component, useState} from "@odoo/owl";
import {registry} from "@web/core/registry";
import {RutasHub} from "./rutas_hub";
import {RutaDetalle} from "./ruta_detalle";
import {Cotizaciones} from "./cotizaciones";
import {Clientes} from "./clientes";
import {abrirNivel, cerrarNivelesHasta, leerPilaActual} from "./back_stack";

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
 * Historial de navegación (Atrás de Android): ver el comentario grande
 * de back_stack.js para el mecanismo completo (segundo rediseño de
 * esta sesión -- el primero, basado en interceptar popstate, no
 * sobrevivía a que Odoo recarga la acción del cliente en CUALQUIER
 * Atrás real). Acá, en setup(), se lee leerPilaActual() -- lo que el
 * historial del navegador diga que corresponde mostrar AHORA MISMO,
 * sobreviva o no un recargado -- y se arma el estado inicial
 * directamente a partir de eso, en vez de arrancar siempre en el hub.
 * abrirRuta()/volverARutas()/irA() son los únicos puntos donde este
 * shell empuja/cierra SU PROPIO nivel (la pantalla superior); los
 * niveles más internos (visita, catálogo/carrito, ficha de cliente) se
 * registran solos, en cascada, en cada componente hijo -- ver
 * RutaDetalle/VisitSheet/OrderScreen.
 */
export class ShalomRutaApp extends Component {
    static template = "shalom_location_map.RutaShalomApp";
    static components = {RutasHub, RutaDetalle, Cotizaciones, Clientes};
    static props = ["*"];

    setup() {
        const pila = leerPilaActual();
        // Busca el ÚLTIMO nivel de tipo "ruta" o "tab" -- ese decide la
        // pantalla superior actual. Puede haber un "ruta" seguido de un
        // "tab" más arriba si el vendedor cambió de pestaña con una
        // ruta todavía abierta detrás (irA() empuja encima, sin sacar
        // nada de abajo -- ver el comentario grande de back_stack.js);
        // en ese caso el "tab" es el que manda.
        let indiceBase = -1;
        for (let i = pila.length - 1; i >= 0; i--) {
            if (pila[i].tipo === "ruta" || pila[i].tipo === "tab") {
                indiceBase = i;
                break;
            }
        }
        const nivelBase = indiceBase >= 0 ? pila[indiceBase] : null;

        // Profundidad a la que hay que truncar la pila si más tarde se
        // toca el "←" de RutaDetalle (volverARutas(), más abajo) -- la
        // profundidad de ANTES de que se abriera este nivel "ruta", sin
        // importar cuántos niveles más internos (visita/catálogo/
        // carrito) se hayan abierto después. Solo tiene sentido cuando
        // se está restaurando justo sobre un nivel "ruta"; si es null,
        // volverARutas() no debería ser alcanzable (ese "←" solo existe
        // en la pantalla "ruta-detalle") -- se deja como respaldo
        // defensivo, ver ahí.
        this._profundidadAntesRuta = nivelBase && nivelBase.tipo === "ruta" ? indiceBase : null;

        this.state = useState({
            screen: nivelBase
                ? (nivelBase.tipo === "ruta" ? "ruta-detalle" : nivelBase.pantalla)
                : "rutas",
            scheduleActivo:
                nivelBase && nivelBase.tipo === "ruta"
                    ? {
                          id: nivelBase.scheduleId,
                          route_id: nivelBase.routeId,
                          route_name: nivelBase.routeName,
                      }
                    : null,
            // Lo que sigue en la pila guardada después del nivel base
            // -- RutaDetalle (si screen es "ruta-detalle") lo usa para
            // reconstruir en cascada lo que había más adentro (visita,
            // catálogo, carrito...) -- ver el comentario grande de
            // back_stack.js.
            pilaRestante: indiceBase >= 0 ? pila.slice(indiceBase + 1) : [],
        });
    }

    /**
     * Siempre se llega acá desde el hub (RutasHub, pestaña "rutas").
     */
    abrirRuta(schedule) {
        const profundidad = abrirNivel({
            tipo: "ruta",
            scheduleId: schedule.id,
            routeId: schedule.route_id,
            routeName: schedule.route_name,
        });
        // Ver el comentario en setup() -- profundidad ya incluye este
        // nivel recién empujado, así que "antes" es un menos.
        this._profundidadAntesRuta = profundidad - 1;
        this.state.screen = "ruta-detalle";
        this.state.scheduleActivo = schedule;
        this.state.pilaRestante = [];
    }

    /**
     * "←" propio de RutaDetalle. Su topbar se muestra siempre (no se
     * oculta si hay una visita/catálogo/carrito abiertos encima -- ver
     * ruta_detalle.xml), así que este salto puede estar cerrando varios
     * niveles a la vez, no solo el "ruta". Hace falta cerrarNivelesHasta()
     * (no cerrarNivel(), que solo saca uno) para que la pila guardada
     * quede sincronizada con lo que en verdad se ve en pantalla después
     * (el hub) -- ver el comentario grande de esa función en
     * back_stack.js.
     */
    volverARutas() {
        cerrarNivelesHasta(this._profundidadAntesRuta != null ? this._profundidadAntesRuta : 0);
        this.state.screen = "rutas";
        this.state.scheduleActivo = null;
        this.state.pilaRestante = [];
    }

    /**
     * Pestañas de la barra inferior (Rutas/Cotizaciones/Clientes).
     * Tocar la pestaña ya activa no hace nada.
     */
    irA(pantalla) {
        if (pantalla === this.state.screen) {
            return;
        }
        abrirNivel({tipo: "tab", pantalla});
        this.state.screen = pantalla;
        this.state.scheduleActivo = null;
        this.state.pilaRestante = [];
    }
}

registry.category("actions").add("shalom_ruta_app", ShalomRutaApp);
