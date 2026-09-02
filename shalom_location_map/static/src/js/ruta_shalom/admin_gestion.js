/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useRef, useState} from "@odoo/owl";
import {registry} from "@web/core/registry";
import {useService} from "@web/core/utils/hooks";
import {ClienteForm} from "./cliente_form";
import {ESTADO_ETIQUETA, estadoDesdeStageName} from "./stage_utils";
import {getMapboxToken, cargarMapboxGl} from "./mapbox_utils";

/**
 * Administración (punto 4 de la ronda "administración", ver README.md):
 * UNA sola página con dos secciones -- Seguimiento de Visitas arriba,
 * Rutas de mis vendedores abajo -- mismo mockup aprobado, no dos
 * pantallas separadas (versión anterior, se juntan a pedido explícito
 * del usuario: "me gustaba más cuando estaban juntas").
 *
 * A propósito NO reusa VisitSheet/RutaDetalle acá: esos abren el flujo
 * de VENTA del vendedor (Tomar pedido, catálogo). Administración es
 * para revisar/arreglar datos de clientes, no para vender -- pedido
 * explícito también. Lo que SÍ se reusa: ClienteForm (editar cliente,
 * sin nada de venta) y el wizard nativo "Buscar GPS por nombre" (se
 * abre con su propia action, con active_ids=[locationId] para que
 * arranque cargado con un solo cliente).
 *
 * El mapa de "Rutas de mis vendedores" es una versión chica, propia,
 * de dibujarMapa() (ruta_detalle.js): mismos helpers de
 * mapbox_utils.js y el mismo pin .shalom-marker-numero, pero sin
 * trazado, sin seguimiento en vivo del vendedor y sin popup de
 * venta -- tocar un pin abre ClienteForm directo.
 */

const ESTADOS_SEGUIMIENTO_DEFAULT = ["cancelado", "no_quiso"];

export class AdminGestion extends Component {
    static template = "shalom_location_map.AdminGestion";
    static components = {ClienteForm};
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        this.mapaRef = useRef("mapaAdmin");
        this.mapboxMap = null;

        this.state = useState({
            // -- Seguimiento de Visitas --
            cargandoVisitas: true,
            visitas: [],
            estadosActivos: [...ESTADOS_SEGUIMIENTO_DEFAULT],

            // -- Rutas de mis vendedores --
            cargandoVendedores: true,
            vendedores: [],
            vendedorSeleccionadoId: null,
            scheduleSeleccionadoId: null,
            cargandoClientesRuta: false,
            clientesRuta: [],

            // -- compartido --
            locationIdEditando: null,
        });

        onWillStart(async () => {
            await Promise.all([this.cargarVisitas(), this.cargarVendedores()]);
        });
        onWillUnmount(() => {
            if (this.mapboxMap) {
                this.mapboxMap.remove();
            }
        });
    }

    // ==================================================================
    // Seguimiento de Visitas
    // ==================================================================

    get estadosDisponibles() {
        return ["cancelado", "no_quiso", "completado", "pendiente"];
    }

    etiquetaEstado(estado) {
        return ESTADO_ETIQUETA[estado] || estado;
    }

    async cargarVisitas() {
        this.state.cargandoVisitas = true;
        try {
            const visitas = await this.orm.call(
                "fsm.order",
                "shalom_admin_seguimiento_visitas",
                [this.state.estadosActivos]
            );
            // Mismo slug que ya usan ruta_detalle.js/visit_sheet.js para
            // el color/badge -- un solo CSS (.stop-card.st-*) para toda
            // la app, sin reinventarlo acá.
            this.state.visitas = visitas.map((v) => ({
                ...v,
                estado: estadoDesdeStageName(v.estado_nombre),
            }));
        } catch (error) {
            console.error("shalom: error al cargar seguimiento de visitas", error);
            this.notification.add("No se pudo cargar el listado de visitas.", {type: "danger"});
        } finally {
            this.state.cargandoVisitas = false;
        }
    }

    toggleEstado(estado) {
        const idx = this.state.estadosActivos.indexOf(estado);
        if (idx >= 0) {
            this.state.estadosActivos.splice(idx, 1);
        } else {
            this.state.estadosActivos.push(estado);
        }
        this.cargarVisitas();
    }

    async toggleRevisado(ev, visita) {
        ev.stopPropagation();
        try {
            await this.orm.call("fsm.order", "shalom_toggle_revisado", [[visita.id]]);
            visita.revisado = !visita.revisado;
        } catch (error) {
            this.notification.add("No se pudo marcar como revisado.", {type: "danger"});
        }
    }

    async archivarCliente(ev, item) {
        ev.stopPropagation();
        // eslint-disable-next-line no-alert
        const acepta = window.confirm(
            `Vas a archivar a "${item.cliente_nombre || item.nombre}" -- deja de ` +
            `generarle visitas nuevas en su ruta. Se puede reactivar después desde ` +
            `Contactos archivados.\n\n¿Confirmás?`
        );
        if (!acepta) {
            return;
        }
        try {
            await this.orm.call("fsm.location", "shalom_admin_archivar_cliente", [
                [item.location_id],
            ]);
            this.notification.add(`"${item.cliente_nombre || item.nombre}" archivado.`, {
                type: "success",
            });
            await this.cargarVisitas();
            if (this.state.scheduleSeleccionadoId) {
                await this.cargarClientesRuta();
            }
        } catch (error) {
            const mensajeServidor = error && error.data && error.data.message;
            this.notification.add(
                mensajeServidor || "No se pudo archivar el cliente.",
                {type: "danger"}
            );
        }
    }

    // ==================================================================
    // Rutas de mis vendedores
    // ==================================================================

    async cargarVendedores() {
        this.state.cargandoVendedores = true;
        try {
            this.state.vendedores = await this.orm.call(
                "fsm.person",
                "shalom_admin_rutas_programadas",
                []
            );
            if (this.state.vendedores.length) {
                this.state.vendedorSeleccionadoId = this.state.vendedores[0].persona_id;
            }
        } catch (error) {
            console.error("shalom: error al cargar rutas de vendedores", error);
            this.notification.add("No se pudieron cargar las rutas.", {type: "danger"});
        } finally {
            this.state.cargandoVendedores = false;
        }
    }

    get vendedorSeleccionado() {
        return this.state.vendedores.find(
            (v) => v.persona_id === this.state.vendedorSeleccionadoId
        );
    }

    elegirVendedor(ev) {
        this.state.vendedorSeleccionadoId = Number(ev.target.value);
        this.state.scheduleSeleccionadoId = null;
        this.state.clientesRuta = [];
    }

    async elegirRuta(ruta) {
        this.state.scheduleSeleccionadoId = ruta.id;
        await this.cargarClientesRuta();
        // El contenedor del mapa recién existe en el DOM después de
        // este render (t-if de la sección mapa) -- se dibuja en el
        // próximo microtask, ya con this.mapaRef.el poblado.
        await Promise.resolve();
        setTimeout(() => this.dibujarMapaAdmin(), 0);
    }

    async cargarClientesRuta() {
        this.state.cargandoClientesRuta = true;
        this.state.clientesRuta = [];
        try {
            const ordenes = await this.orm.searchRead(
                "fsm.order",
                [["x_route_schedule_id", "=", this.state.scheduleSeleccionadoId]],
                ["location_id", "x_cliente_orden_ruta", "x_cliente_lat", "x_cliente_lng", "stage_name"],
                {order: "x_cliente_orden_ruta asc"}
            );
            const locationIds = ordenes
                .map((o) => o.location_id && o.location_id[0])
                .filter(Boolean);
            let datosPorLocation = {};
            if (locationIds.length) {
                const locaciones = await this.orm.read("fsm.location", locationIds, ["name"]);
                datosPorLocation = Object.fromEntries(locaciones.map((l) => [l.id, l]));
            }
            this.state.clientesRuta = ordenes.map((o) => {
                const loc = o.location_id ? datosPorLocation[o.location_id[0]] : null;
                return {
                    ordenId: o.id,
                    locationId: o.location_id ? o.location_id[0] : false,
                    nombre: loc ? loc.name : o.location_id ? o.location_id[1] : "Sin cliente",
                    orden: o.x_cliente_orden_ruta,
                    lat: o.x_cliente_lat,
                    lng: o.x_cliente_lng,
                    estado: estadoDesdeStageName(o.stage_name),
                };
            });
        } catch (error) {
            console.error("shalom: error al cargar clientes de la ruta", error);
            this.notification.add("No se pudieron cargar los clientes de la ruta.", {
                type: "danger",
            });
        } finally {
            this.state.cargandoClientesRuta = false;
        }
    }

    /** Mapa chico de solo ubicar/editar -- ver el docstring grande al
     * principio del archivo para por qué NO es dibujarMapa() de
     * ruta_detalle.js reusado. */
    async dibujarMapaAdmin() {
        if (!this.mapaRef.el) {
            return;
        }
        const token = await getMapboxToken();
        if (!token) {
            this.notification.add("No se encontró el token de Mapbox.", {type: "danger"});
            return;
        }
        await cargarMapboxGl();
        window.mapboxgl.accessToken = token;

        if (this.mapboxMap) {
            this.mapboxMap.remove();
            this.mapboxMap = null;
        }

        const conCoordenadas = this.state.clientesRuta.filter((c) => c.lat && c.lng);
        const centro = conCoordenadas.length
            ? [conCoordenadas[0].lng, conCoordenadas[0].lat]
            : [-79.5199, 8.9824]; // fallback: Ciudad de Panamá

        this.mapboxMap = new window.mapboxgl.Map({
            container: this.mapaRef.el,
            style: "mapbox://styles/mapbox/navigation-day-v1",
            center: centro,
            zoom: 12,
        });

        this.mapboxMap.on("load", () => {
            if (!conCoordenadas.length) {
                return;
            }
            const bounds = new window.mapboxgl.LngLatBounds();
            conCoordenadas.forEach((c) => {
                const pinEl = document.createElement("div");
                pinEl.className = "shalom-marker-numero";
                pinEl.style.setProperty(
                    "--pin-color",
                    c.estado === "cancelado" || (!c.lat && !c.lng)
                        ? "var(--shalom-alerta)"
                        : "var(--shalom-accent)"
                );
                pinEl.title = c.nombre;
                if (c.orden) {
                    const numEl = document.createElement("span");
                    numEl.className = "shalom-marker-numero-txt";
                    numEl.textContent = String(c.orden);
                    pinEl.appendChild(numEl);
                }
                pinEl.addEventListener("click", () => this.abrirEdicionCliente(c.locationId));
                new window.mapboxgl.Marker({element: pinEl, anchor: "center"})
                    .setLngLat([c.lng, c.lat])
                    .addTo(this.mapboxMap);
                bounds.extend([c.lng, c.lat]);
            });
            if (conCoordenadas.length > 1) {
                this.mapboxMap.fitBounds(bounds, {padding: 50, maxZoom: 15});
            }
        });
    }

    /** Botón "Buscar GPS" (la mira) de una fila: abre el wizard nativo
     * "Buscar GPS por nombre" (shalom.buscar.gps.wizard) precargado
     * con ESTE cliente -- mismo wizard que ya existe, no uno nuevo. */
    buscarGps(ev, locationId) {
        if (ev) {
            ev.stopPropagation();
        }
        this.action.doAction("shalom_location_map.shalom_buscar_gps_wizard_action", {
            additionalContext: {active_model: "fsm.location", active_ids: [locationId]},
        });
    }

    // ==================================================================
    // Editar cliente (compartido por las dos secciones)
    // ==================================================================

    abrirEdicionCliente(locationId) {
        this.state.locationIdEditando = locationId;
    }

    cerrarEdicionCliente() {
        this.state.locationIdEditando = null;
    }

    async clienteEditado() {
        this.state.locationIdEditando = null;
        await this.cargarVisitas();
        if (this.state.scheduleSeleccionadoId) {
            await this.cargarClientesRuta();
        }
    }
}

registry.category("actions").add("shalom_admin_gestion", AdminGestion);
