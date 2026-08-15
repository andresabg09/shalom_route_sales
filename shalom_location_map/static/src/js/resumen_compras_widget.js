/** @odoo-module **/

import {Component, onMounted, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {loadJS} from "@web/core/assets";
import {registry} from "@web/core/registry";
import {standardWidgetProps} from "@web/views/widgets/standard_widget_props";
import {useService} from "@web/core/utils/hooks";

const CHARTJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";

const COLORES = [
    "#2a78d6",
    "#1baf7a",
    "#eda100",
    "#4a3aa7",
    "#e34948",
    "#e87ba4",
];

/**
 * Widget embebido en el formulario de fsm.order que muestra un gráfico
 * de línea de tiempo (últimos 12 meses) con la cantidad comprada por
 * mes de los productos más relevantes del cliente de esta visita, y
 * un botón para alternar hacia la lista de "productos olvidados"
 * (sin comprar hace 3+ meses), con su última fecha de compra.
 *
 * Reemplaza el antiguo botón "Resumen de compras" (que mostraba una
 * notificación de texto) por este widget visual, a pedido del usuario.
 */
class ShalomResumenComprasWidget extends Component {
    static template = "shalom_location_map.ResumenComprasWidget";
    static props = {
        ...standardWidgetProps,
    };

    setup() {
        this.orm = useService("orm");
        this.canvasRef = useRef("canvas");
        this.chart = null;
        this.state = useState({
            vista: "grafico",
            datos: null,
            cargando: true,
        });

        onMounted(async () => {
            await loadJS(CHARTJS_URL);
            await this.cargarDatos();
        });

        onWillUnmount(() => {
            if (this.chart) {
                this.chart.destroy();
            }
        });

        // Se dispara cada vez que el canvas entra/sale del DOM (por el
        // t-if de la vista "grafico") o cuando cambian los datos, ya
        // con el DOM real actualizado -- evita la condición de carrera
        // de intentar dibujar sobre un canvas que Owl todavía no montó.
        useEffect(
            () => {
                if (this.canvasRef.el && this.state.datos && window.Chart) {
                    this.renderGrafico();
                }
            },
            () => [this.canvasRef.el, this.state.datos, this.state.vista]
        );
    }

    get resId() {
        return this.props.record.resId;
    }

    async cargarDatos() {
        const resId = this.resId;
        if (!resId) {
            this.state.cargando = false;
            return;
        }
        const datos = await this.orm.call(
            "fsm.order",
            "get_datos_grafico_compras",
            [[resId]]
        );
        this.state.datos = datos;
        this.state.cargando = false;
    }

    toggleVista() {
        this.state.vista = this.state.vista === "grafico" ? "olvidados" : "grafico";
    }

    renderGrafico() {
        if (!this.state.datos || !this.canvasRef.el) {
            return;
        }
        if (this.chart) {
            this.chart.destroy();
        }
        const {meses, series} = this.state.datos;
        this.chart = new window.Chart(this.canvasRef.el, {
            type: "line",
            data: {
                labels: meses,
                datasets: series.map((serie, idx) => ({
                    label: serie.producto,
                    data: serie.datos,
                    borderColor: COLORES[idx % COLORES.length],
                    backgroundColor: COLORES[idx % COLORES.length] + "1A",
                    fill: true,
                    tension: 0.3,
                    pointRadius: 3,
                })),
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {legend: {display: false}},
                scales: {
                    y: {beginAtZero: true, grid: {color: "#e1e0d9"}},
                    x: {grid: {display: false}},
                },
            },
        });
    }
}

export const shalomResumenCompras = {
    component: ShalomResumenComprasWidget,
};
registry.category("view_widgets").add("shalom_resumen_compras", shalomResumenCompras);
