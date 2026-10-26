/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {cerrarConAnimacion} from "./animacion_utils";
import {abrirNivel, cerrarNivel} from "./back_stack";

/**
 * Hoja "Avisos" (Fase 6B del juego de ventas), se abre desde el botón
 * "Avisos" de la pestaña Rutas. Dos secciones:
 *
 * - "Avisar por WhatsApp": clientes grandes de MI cartera/mis rutas que
 *   visitaré entre mañana y dentro de 3 días (fsm.person.
 *   shalom_avisos_proximos). El botón de cada cliente abre en otra
 *   pestaña el enlace https://wa.me/<número>?text=<mensaje armado> que
 *   ya trae el servidor, y marca el aviso como hecho (shalom_marcar_
 *   avisado) para que no se repita. NO hay integración con WhatsApp: el
 *   vendedor revisa y envía el mensaje él mismo.
 * - "Distribuidoras: solo escríbeles": clientes marcados como
 *   distribuidora (fsm.person.shalom_distribuidoras). Nunca se visitan
 *   en persona; aquí solo se les escribe. No se marca nada.
 *
 * Es un nivel de la pila de navegación (el Atrás de Android la cierra,
 * igual que ClienteForm: ver back_stack.js). Cubre toda la pantalla
 * (también la barra inferior), así que no se puede cambiar de pestaña
 * con la hoja abierta.
 */
export class Avisos extends Component {
    static template = "shalom_location_map.Avisos";
    static props = {
        onCerrar: Function,
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            cargando: true,
            avisos: [],
            distribuidoras: [],
            errorAvisos: false,
            errorDistribuidoras: false,
            cerrando: false,
        });
        abrirNivel({tipo: "avisos"});
        this._nivelCerrado = false;
        onWillUnmount(() => this._cerrarMiNivel());
        onWillStart(() => this.cargar());
    }

    /** Saca este nivel de la pila de navegación -- una sola vez. */
    _cerrarMiNivel() {
        if (this._nivelCerrado) {
            return;
        }
        this._nivelCerrado = true;
        cerrarNivel();
    }

    /** Las dos listas se piden por separado: si una falla, la otra se
     * muestra igual. */
    async cargar() {
        const [avisos, distribuidoras] = await Promise.allSettled([
            this.orm.call("fsm.person", "shalom_avisos_proximos", []),
            this.orm.call("fsm.person", "shalom_distribuidoras", []),
        ]);
        if (avisos.status === "fulfilled") {
            this.state.avisos = avisos.value || [];
        } else {
            this.state.errorAvisos = true;
            console.error("shalom: error al leer los avisos", avisos.reason);
        }
        if (distribuidoras.status === "fulfilled") {
            this.state.distribuidoras = distribuidoras.value || [];
        } else {
            this.state.errorDistribuidoras = true;
            console.error("shalom: error al leer las distribuidoras", distribuidoras.reason);
        }
        this.state.cargando = false;
    }

    get pendientes() {
        return this.state.avisos.filter((a) => !a.avisado);
    }

    get avisados() {
        return this.state.avisos.filter((a) => a.avisado);
    }

    dinero(valor) {
        return "$" + Math.round(valor || 0).toLocaleString("en-US");
    }

    cuando(dias) {
        if (dias === 1) {
            return "mañana";
        }
        return `en ${dias} días`;
    }

    hace(dias) {
        if (dias === false || dias === null || dias === undefined) {
            return "Sin pedidos todavía";
        }
        if (dias <= 0) {
            return "compró hoy";
        }
        return dias === 1 ? "compró ayer" : `hace ${dias} días`;
    }

    /** Abre WhatsApp con el mensaje armado y marca el aviso como hecho.
     * window.open va PRIMERO y de forma síncrona (dentro del toque del
     * usuario) para que el navegador no lo bloquee como ventana emergente. */
    avisar(aviso) {
        window.open(aviso.url, "_blank", "noopener");
        if (!aviso.avisado) {
            this.marcarAvisado(aviso);
        }
    }

    async marcarAvisado(aviso) {
        aviso.avisado = true; // se ve al instante; si el servidor falla, se revierte
        try {
            await this.orm.call("fsm.person", "shalom_marcar_avisado", [[aviso.order_id]]);
        } catch (error) {
            console.error("shalom: error al marcar el aviso", error);
            aviso.avisado = false;
            this.notification.add(
                "No se pudo marcar como avisado. Revisa tu conexión.",
                {type: "warning"}
            );
        }
    }

    /** Distribuidoras: solo abre el enlace, no hay nada que marcar. */
    escribir(distribuidora) {
        window.open(distribuidora.url, "_blank", "noopener");
    }

    cerrar() {
        this._cerrarMiNivel();
        cerrarConAnimacion(this.state, () => this.props.onCerrar());
    }
}
