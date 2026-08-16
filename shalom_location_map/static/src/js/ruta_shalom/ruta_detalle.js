/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {cargarMapboxGl, getMapboxToken, parseWktLineString} from "./mapbox_utils";

/**
 * Detalle de una ruta (una fsm.route.schedule): tabs Lista/Mapa.
 *
 * Lista: las fsm.order vinculadas a esta ocurrencia semanal
 * (x_route_schedule_id), en el mismo orden en que se generaron
 * (sequence, que ya refleja x_orden_ruta al momento de crearlas).
 *
 * Mapa: Mapbox GL real -- un marcador coloreado por estado por cada
 * cliente con coordenadas, y el trazado real de calles guardado en
 * fsm.route.x_ruta_trazado (si ya se calculó desde el formulario de
 * Ruta). Mismo patrón que static/src/js/mini_mapa_widget.js.
 *
 * El detalle de cada visita (hoja con estado, observaciones, "Tomar
 * pedido") es Fase 2 -- acá la lista es de solo lectura, salvo el
 * ícono rápido de "Ir con Maps" que ya reusa un flujo existente
 * (misma URL que fsm.order.action_abrir_maps).
 */

const ETIQUETA_ESTADO_VISITA = {
    pendiente: "Pendiente",
    completado: "Completada",
    no_quiso: "No quiso",
    cancelado: "Cancelado",
};

const COLOR_MARCADOR = {
    pendiente: "#c1791d",
    completado: "#2c7a56",
    no_quiso: "#8c5060",
    cancelado: "#5c6470",
};

function estadoDesdeStageName(stageName) {
    if (stageName === "Completado") {
        return "completado";
    }
    if (stageName === "Cancelado") {
        return "cancelado";
    }
    if (stageName === "No quiso") {
        return "no_quiso";
    }
    return "pendiente";
}

export class RutaDetalle extends Component {
    static template = "shalom_location_map.RutaDetalle";
    static props = {
        schedule: Object,
        onVolver: Function,
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.mapaRef = useRef("mapa");
        this.mapboxMap = null;
        this.state = useState({
            cargando: true,
            visitas: [],
            trazadoWkt: false,
            tab: "lista",
        });

        onWillStart(() => this.cargar());
        onWillUnmount(() => {
            if (this.mapboxMap) {
                this.mapboxMap.remove();
            }
        });

        useEffect(
            () => {
                if (this.state.tab === "mapa" && this.mapaRef.el && !this.state.cargando) {
                    this.dibujarMapa();
                }
            },
            () => [this.state.tab, this.mapaRef.el, this.state.cargando]
        );
    }

    async cargar() {
        this.state.cargando = true;
        try {
            const ordenes = await this.orm.searchRead(
                "fsm.order",
                [["x_route_schedule_id", "=", this.props.schedule.id]],
                ["location_id", "x_cliente_orden_ruta", "stage_name", "x_cliente_lat", "x_cliente_lng"],
                {order: "sequence asc"}
            );

            const locationIds = ordenes
                .map((o) => o.location_id && o.location_id[0])
                .filter(Boolean);
            let datosPorLocation = {};
            if (locationIds.length) {
                const locaciones = await this.orm.read("fsm.location", locationIds, [
                    "phone",
                    "street",
                ]);
                datosPorLocation = Object.fromEntries(locaciones.map((l) => [l.id, l]));
            }

            this.state.visitas = ordenes.map((o) => {
                const loc = o.location_id ? datosPorLocation[o.location_id[0]] : null;
                return {
                    id: o.id,
                    nombre: o.location_id ? o.location_id[1] : "Sin cliente",
                    orden: o.x_cliente_orden_ruta,
                    estado: estadoDesdeStageName(o.stage_name),
                    lat: o.x_cliente_lat,
                    lng: o.x_cliente_lng,
                    telefono: loc ? loc.phone : "",
                    direccion: loc ? loc.street : "",
                };
            });

            const ruta = await this.orm.read("fsm.route", [this.props.schedule.route_id], [
                "x_ruta_trazado",
            ]);
            this.state.trazadoWkt = ruta.length ? ruta[0].x_ruta_trazado : false;
        } catch (error) {
            this.notification.add("No se pudieron cargar las visitas de esta ruta.", {
                type: "danger",
            });
        } finally {
            this.state.cargando = false;
        }
    }

    get resumen() {
        const total = this.state.visitas.length;
        const resueltas = this.state.visitas.filter((v) => v.estado !== "pendiente").length;
        return `${resueltas}/${total} resueltas`;
    }

    etiquetaEstado(estado) {
        return ETIQUETA_ESTADO_VISITA[estado] || estado;
    }

    cambiarTab(tab) {
        this.state.tab = tab;
    }

    abrirMaps(visita) {
        if (!visita.lat && !visita.lng) {
            this.notification.add(
                "Este cliente todavía no tiene coordenadas GPS guardadas.",
                {type: "warning"}
            );
            return;
        }
        window.open(
            `https://www.google.com/maps/dir/?api=1&destination=${visita.lat},${visita.lng}`,
            "_blank"
        );
    }

    async dibujarMapa() {
        const token = await getMapboxToken();
        if (!token) {
            this.notification.add("No se encontró el token de Mapbox.", {type: "danger"});
            return;
        }
        await cargarMapboxGl();
        window.mapboxgl.accessToken = token;

        const conCoordenadas = this.state.visitas.filter((v) => v.lat && v.lng);

        if (this.mapboxMap) {
            this.mapboxMap.remove();
        }

        const centro = conCoordenadas.length
            ? [conCoordenadas[0].lng, conCoordenadas[0].lat]
            : [-79.5199, 8.9824]; // fallback: Ciudad de Panamá

        this.mapboxMap = new window.mapboxgl.Map({
            container: this.mapaRef.el,
            style: "mapbox://styles/mapbox/streets-v12",
            center: centro,
            zoom: 12,
        });

        this.mapboxMap.on("load", () => {
            const bounds = new window.mapboxgl.LngLatBounds();

            conCoordenadas.forEach((v) => {
                const marcador = document.createElement("div");
                marcador.className = "shalom-marker";
                marcador.style.background = COLOR_MARCADOR[v.estado];
                marcador.textContent = v.orden || "";
                new window.mapboxgl.Marker({element: marcador})
                    .setLngLat([v.lng, v.lat])
                    .setPopup(new window.mapboxgl.Popup({offset: 16}).setText(v.nombre))
                    .addTo(this.mapboxMap);
                bounds.extend([v.lng, v.lat]);
            });

            const coordenadasTrazado = parseWktLineString(this.state.trazadoWkt);
            if (coordenadasTrazado) {
                this.mapboxMap.addSource("shalom-ruta-trazado", {
                    type: "geojson",
                    data: {
                        type: "Feature",
                        properties: {},
                        geometry: {type: "LineString", coordinates: coordenadasTrazado},
                    },
                });
                this.mapboxMap.addLayer({
                    id: "shalom-ruta-trazado-linea",
                    type: "line",
                    source: "shalom-ruta-trazado",
                    layout: {"line-join": "round", "line-cap": "round"},
                    paint: {"line-color": "#b1245a", "line-width": 4},
                });
            }

            if (!bounds.isEmpty()) {
                this.mapboxMap.fitBounds(bounds, {padding: 50, maxZoom: 15});
            }
        });
    }

    volver() {
        this.props.onVolver();
    }
}
