/** @odoo-module **/

import {Component, onMounted, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {loadJS} from "@web/core/assets";
import {registry} from "@web/core/registry";
import {rpc} from "@web/core/network/rpc";
import {standardWidgetProps} from "@web/views/widgets/standard_widget_props";

const MAPBOX_GL_JS_URL = "https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.js";
const MAPBOX_GL_CSS_URL = "https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.css";

let mapboxTokenCache = null;

async function getMapboxToken() {
    if (mapboxTokenCache) {
        return mapboxTokenCache;
    }
    mapboxTokenCache = await rpc("/shalom_location_map/mapbox_public_token");
    return mapboxTokenCache;
}

function cargarCssMapboxGl() {
    if (document.querySelector(`link[href="${MAPBOX_GL_CSS_URL}"]`)) {
        return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = MAPBOX_GL_CSS_URL;
    document.head.appendChild(link);
}

/**
 * Widget embebido en la tarjeta de fsm.order: mini-mapa con el
 * trazado dinámico (Mapbox Directions) desde la posición GPS ACTUAL
 * del vendedor (leída del navegador, sin guardar nada) hasta el
 * cliente de esta visita.
 *
 * Solo lectura -- no requiere confirmación como el botón "Capturar mi
 * ubicación GPS" (ese sí sobreescribe datos del cliente).
 *
 * Si el navegador no tiene el permiso de geolocalización concedido de
 * antes, NO se lo solicita de forma insistente: se muestra un aviso
 * simple en su lugar.
 */
class ShalomMiniMapaWidget extends Component {
    static template = "shalom_location_map.MiniMapaWidget";
    static props = {
        ...standardWidgetProps,
    };

    setup() {
        this.mapRef = useRef("mapa");
        this.map = null;
        this.state = useState({
            cargando: true,
            error: null,
            sinPermiso: false,
            lat: null,
            lng: null,
        });

        onMounted(async () => {
            await this.inicializar();
        });

        onWillUnmount(() => {
            if (this.map) {
                this.map.remove();
            }
        });

        useEffect(
            () => {
                if (this.mapRef.el && this.state.lat && this.state.lng && window.mapboxgl) {
                    this.dibujarMapa();
                }
            },
            () => [this.mapRef.el, this.state.lat, this.state.lng]
        );
    }

    async inicializar() {
        if (!navigator.permissions || !navigator.geolocation) {
            this.state.cargando = false;
            this.state.error = "Este navegador no soporta geolocalización.";
            return;
        }

        let estadoPermiso;
        try {
            estadoPermiso = await navigator.permissions.query({name: "geolocation"});
        } catch {
            estadoPermiso = null;
        }

        if (estadoPermiso && estadoPermiso.state !== "granted") {
            this.state.cargando = false;
            this.state.sinPermiso = true;
            return;
        }

        navigator.geolocation.getCurrentPosition(
            async (position) => {
                this.state.lat = position.coords.latitude;
                this.state.lng = position.coords.longitude;
                await loadJS(MAPBOX_GL_JS_URL);
                cargarCssMapboxGl();
                this.state.cargando = false;
            },
            () => {
                this.state.cargando = false;
                this.state.sinPermiso = true;
            },
            {enableHighAccuracy: true, timeout: 10000, maximumAge: 60000}
        );
    }

    async dibujarMapa() {
        const token = await getMapboxToken();
        if (!token) {
            this.state.error = "No se encontró el token de Mapbox.";
            return;
        }
        window.mapboxgl.accessToken = token;

        const clienteLat = this.props.record.data.x_cliente_lat;
        const clienteLng = this.props.record.data.x_cliente_lng;

        if (this.map) {
            this.map.remove();
        }

        this.map = new window.mapboxgl.Map({
            container: this.mapRef.el,
            style: "mapbox://styles/mapbox/streets-v12",
            center: [this.state.lng, this.state.lat],
            zoom: 12,
        });

        this.map.on("load", async () => {
            new window.mapboxgl.Marker({color: "#2a78d6"})
                .setLngLat([this.state.lng, this.state.lat])
                .addTo(this.map);

            if (!clienteLat && !clienteLng) {
                return;
            }

            new window.mapboxgl.Marker({color: "#e34948"})
                .setLngLat([clienteLng, clienteLat])
                .addTo(this.map);

            try {
                const resp = await fetch(
                    "https://api.mapbox.com/directions/v5/mapbox/driving/" +
                        `${this.state.lng},${this.state.lat};${clienteLng},${clienteLat}` +
                        `?geometries=geojson&access_token=${token}`
                );
                const data = await resp.json();
                if (data.routes && data.routes.length) {
                    const geometry = data.routes[0].geometry;
                    this.map.addSource("shalom-ruta", {
                        type: "geojson",
                        data: {type: "Feature", properties: {}, geometry},
                    });
                    this.map.addLayer({
                        id: "shalom-ruta-linea",
                        type: "line",
                        source: "shalom-ruta",
                        layout: {"line-join": "round", "line-cap": "round"},
                        paint: {"line-color": "#2a78d6", "line-width": 4},
                    });

                    const bounds = new window.mapboxgl.LngLatBounds();
                    geometry.coordinates.forEach((coord) => bounds.extend(coord));
                    this.map.fitBounds(bounds, {padding: 30});
                }
            } catch {
                // Si falla el trazado, el mapa igual queda mostrando
                // ambos marcadores centrados; no es un error bloqueante.
            }
        });
    }
}

export const shalomMiniMapa = {
    component: ShalomMiniMapaWidget,
};
registry.category("view_widgets").add("shalom_mini_mapa", shalomMiniMapa);
