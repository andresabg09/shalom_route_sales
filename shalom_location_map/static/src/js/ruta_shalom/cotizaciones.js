/** @odoo-module **/

import {Component, onWillStart, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";

/**
 * Pestaña "Cotizaciones" (Fase 4): todas las sale.order de los
 * clientes asignados al vendedor logueado (no solo las de la ruta de
 * hoy), usando fsm.person.shalom_mis_cotizaciones -- el mismo método
 * "mis datos" pensado en Fase 0 para esta pantalla (incluye borradores
 * y confirmadas, excluye canceladas). Tocar una fila abre esa
 * cotización en el formulario nativo de Ventas, mismo lugar donde ya
 * se ajustan precios/promociones para las que se arman desde "Revisar
 * cotización" en el carrito de la hoja de visita.
 */
export class Cotizaciones extends Component {
    static template = "shalom_location_map.Cotizaciones";
    static props = {};

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        this.state = useState({
            cargando: true,
            cotizaciones: [],
            busqueda: "",
        });
        onWillStart(() => this.cargar());
    }

    async cargar() {
        this.state.cargando = true;
        try {
            this.state.cotizaciones = await this.orm.call(
                "fsm.person",
                "shalom_mis_cotizaciones",
                []
            );
        } catch (error) {
            this.notification.add("No se pudieron cargar tus cotizaciones.", {
                type: "danger",
            });
        } finally {
            this.state.cargando = false;
        }
    }

    get cotizacionesFiltradas() {
        const texto = this.state.busqueda.trim().toLowerCase();
        if (!texto) {
            return this.state.cotizaciones;
        }
        return this.state.cotizaciones.filter(
            (c) =>
                c.name.toLowerCase().includes(texto) ||
                (c.partner_name || "").toLowerCase().includes(texto)
        );
    }

    formatoFecha(iso) {
        if (!iso) {
            return "";
        }
        return new Date(iso).toLocaleDateString("es-PA", {
            day: "numeric",
            month: "short",
            year: "numeric",
        });
    }

    abrir(cotizacion) {
        this.action.doAction({
            type: "ir.actions.act_window",
            res_model: "sale.order",
            res_id: cotizacion.id,
            view_mode: "form",
            views: [[false, "form"]],
            target: "current",
        });
    }
}
