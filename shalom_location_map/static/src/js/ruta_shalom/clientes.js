/** @odoo-module **/

import {Component, onWillStart, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {ClienteForm} from "./cliente_form";

/**
 * Pestaña "Clientes" (Fase 4): directorio de fsm.location asignadas al
 * vendedor logueado (vía sus rutas -- puede tener más de una, por eso
 * cada tarjeta muestra a cuál pertenece cada cliente), con búsqueda y
 * acciones rápidas (llamar / Maps). Tocar un cliente abre el mismo
 * ClienteForm (modo "editar") que usa "Editar cliente" en la hoja de
 * visita; el botón flotante "+" lo abre en modo "crear" (alta rápida,
 * caso ocasional -- ver docs/plan_fase_1_a_4.md).
 */
export class Clientes extends Component {
    static template = "shalom_location_map.Clientes";
    static components = {ClienteForm};
    static props = {};

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            cargando: true,
            clientes: [],
            busqueda: "",
            formularioAbierto: false,
            modoFormulario: "crear",
            locationIdEditando: null,
        });
        onWillStart(() => this.cargar());
    }

    async cargar() {
        this.state.cargando = true;
        try {
            this.state.clientes = await this.orm.call("fsm.person", "shalom_mis_clientes", []);
        } catch (error) {
            this.notification.add("No se pudieron cargar tus clientes.", {type: "danger"});
        } finally {
            this.state.cargando = false;
        }
    }

    get clientesFiltrados() {
        const texto = this.state.busqueda.trim().toLowerCase();
        if (!texto) {
            return this.state.clientes;
        }
        return this.state.clientes.filter(
            (c) =>
                (c.name || "").toLowerCase().includes(texto) ||
                (c.street || "").toLowerCase().includes(texto)
        );
    }

    llamar(cliente) {
        if (!cliente.phone) {
            this.notification.add("Este cliente no tiene teléfono guardado.", {type: "warning"});
            return;
        }
        window.open(`tel:${cliente.phone}`, "_self");
    }

    abrirMaps(cliente) {
        // No tenemos lat/lng en esta lista liviana -- se abre una
        // búsqueda por dirección/nombre en vez de coordenadas exactas.
        const consulta = encodeURIComponent(`${cliente.name} ${cliente.street || ""}`.trim());
        window.open(`https://www.google.com/maps/search/?api=1&query=${consulta}`, "_blank");
    }

    abrirAlta() {
        this.state.modoFormulario = "crear";
        this.state.locationIdEditando = null;
        this.state.formularioAbierto = true;
    }

    abrirEdicion(cliente) {
        this.state.modoFormulario = "editar";
        this.state.locationIdEditando = cliente.id;
        this.state.formularioAbierto = true;
    }

    cerrarFormulario() {
        this.state.formularioAbierto = false;
    }

    async formularioGuardado() {
        this.state.formularioAbierto = false;
        await this.cargar();
    }
}
