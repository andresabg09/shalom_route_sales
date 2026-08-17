/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {cargarMapboxGl, getMapboxToken, parseWktLineString} from "./mapbox_utils";
import {ESTADO_ETIQUETA, estadoDesdeStageName} from "./stage_utils";
import {VisitSheet} from "./visit_sheet";

/**
 * Detalle de una ruta (una fsm.route.schedule): tabs Lista/Mapa.
 *
 * Lista: las fsm.order vinculadas a esta ocurrencia semanal
 * (x_route_schedule_id), en el mismo orden en que se generaron
 * (sequence, que ya refleja x_orden_ruta al momento de crearlas). Cada
 * fila abre la hoja de visita (Fase 2, VisitSheet) al tocarla.
 *
 * Mapa: Mapbox GL real -- un pin coloreado por estado por cada cliente
 * con coordenadas (con su número de orden), un punto pulsante en la
 * posición GPS actual del vendedor, y el trazado real de calles
 * guardado en fsm.route.x_ruta_trazado (si ya se calculó desde el
 * formulario de Ruta). Mismo patrón que static/src/js/mini_mapa_widget.js.
 */

const COLOR_MARCADOR = {
    pendiente: "#c1791d",
    completado: "#2c7a56",
    no_quiso: "#8c5060",
    cancelado: "#5c6470",
};

// Por debajo de esto se considera una lectura de GPS confiable -- por
// encima (típico de Android con "ubicación aproximada" en vez de
// "precisa"), se descarta: un punto ausente es mejor que uno a
// kilómetros de la posición real.
const PRECISION_MAXIMA_ACEPTABLE_M = 500;

// Margen (px) entre el borde real del mapa y dónde se dibuja la
// paletita direccional, para que no quede pegada literal al borde.
const PALETA_MARGEN_PX = 30;

/**
 * Rumbo (bearing) en grados desde (lat1,lng1) hacia (lat2,lng2), 0-360,
 * 0 = norte, sentido horario (90 = este, 180 = sur, 270 = oeste) --
 * fórmula estándar de navegación (great-circle bearing), de sobra para
 * la escala de una ciudad.
 */
function calcularRumbo(lat1, lng1, lat2, lng2) {
    const rad = Math.PI / 180;
    const φ1 = lat1 * rad;
    const φ2 = lat2 * rad;
    const Δλ = (lng2 - lng1) * rad;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    return ((θ * 180) / Math.PI + 360) % 360;
}

/**
 * Punto (x,y en px, relativo a un contenedor de ancho/alto dados) donde
 * un rayo que sale del centro con rumbo `anguloDeg` toca el borde del
 * rectángulo (con un margen) -- así la paletita queda pegada al borde
 * del mapa apuntando en la dirección real hacia el cliente.
 */
function posicionEnBorde(anguloDeg, ancho, alto, margen) {
    const rad = (anguloDeg * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad); // "arriba" en pantalla es y negativo
    const maxX = ancho / 2 - margen;
    const maxY = alto / 2 - margen;
    const escala = Math.min(
        dx !== 0 ? Math.abs(maxX / dx) : Infinity,
        dy !== 0 ? Math.abs(maxY / dy) : Infinity
    );
    return {x: ancho / 2 + dx * escala, y: alto / 2 + dy * escala};
}

export class RutaDetalle extends Component {
    static template = "shalom_location_map.RutaDetalle";
    static components = {VisitSheet};
    static props = {
        schedule: Object,
        onVolver: Function,
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.mapaRef = useRef("mapa");
        this.mapboxMap = null;
        // Datos "vivos" del mapa que no necesitan disparar un re-render
        // de Owl por sí solos (se usan desde callbacks de Mapbox) --
        // separados de this.state a propósito.
        this.posicionVendedor = null; // {lat, lng} -- última lectura de GPS válida
        this._marcadorVendedor = null;
        this._markersPorVisita = {}; // {visitaId: mapboxgl.Marker}
        this._clienteObjetivoActual = null; // visita a la que apunta la paletita
        this.state = useState({
            cargando: true,
            visitas: [],
            trazadoWkt: false,
            tab: "lista",
            visitaAbiertaId: null,
            mostrarVisitados: false,
            busquedaCliente: "",
            paletaVisible: false,
            paletaX: 0,
            paletaY: 0,
            paletaAngulo: 0,
        });

        onWillStart(() => this.cargar());
        onWillUnmount(() => {
            if (this.mapboxMap) {
                this.mapboxMap.remove();
            }
        });

        // OJO: la condición de re-dibujado deliberadamente NO depende de
        // this.mapaRef.el (bug real encontrado en producción). Cualquier
        // escritura de estado mientras se navega el mapa (ej. la
        // paletita direccional actualizándose en cada "moveend") dispara
        // un re-render de Owl -- si mapaRef.el estuviera en el array de
        // dependencias y por lo que sea Owl no reusara el mismo nodo DOM
        // entre renders, este efecto se re-disparaba, destruyendo y
        // recreando el mapa entero (con un pedido de GPS nuevo cada vez,
        // que el celular responde con una lectura levemente distinta) --
        // eso se veía como si el punto del vendedor "saltara" solo por
        // hacer zoom. Con tab/cargando alcanza: para cuando este efecto
        // corre, mapaRef.el ya está poblado si la pestaña es "mapa".
        useEffect(
            () => {
                if (this.state.tab === "mapa" && this.mapaRef.el && !this.state.cargando) {
                    this.dibujarMapa();
                }
            },
            () => [this.state.tab, this.state.cargando]
        );
    }

    async cargar() {
        this.state.cargando = true;
        try {
            // Ordenado por x_cliente_orden_ruta (posición actual del
            // cliente en la ruta), no por "sequence" -- sequence queda
            // fijo desde que se generó la visita, así que si el
            // vendedor reordenaba un cliente después (ClienteForm), la
            // lista seguía mostrando el orden viejo. x_cliente_orden_ruta
            // es un related con store=True a fsm.location.x_orden_ruta,
            // así que siempre refleja la posición actual.
            const ordenes = await this.orm.searchRead(
                "fsm.order",
                [["x_route_schedule_id", "=", this.props.schedule.id]],
                ["location_id", "x_cliente_orden_ruta", "stage_name", "x_cliente_lat", "x_cliente_lng"],
                {order: "x_cliente_orden_ruta asc"}
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

    /** Pendientes = todavía sin resolver hoy. Es lo que se muestra por
     * defecto en la Lista de clientes, para no mezclar con las ya
     * resueltas y no tener que scrollear tanto (pedido explícito). */
    get visitasPendientes() {
        return this.state.visitas.filter((v) => v.estado === "pendiente");
    }

    /** Visitadas = cualquier estado que no sea "pendiente"
     * (completado, no_quiso o cancelado -- cualquiera de los tres
     * significa que ya se pasó por ese cliente). */
    get visitasVisitadas() {
        return this.state.visitas.filter((v) => v.estado !== "pendiente");
    }

    /**
     * Lo que efectivamente se muestra en la pestaña Lista: pendientes o
     * visitadas según el toggle, y de ahí filtradas por el buscador de
     * cliente (nombre o dirección) -- misma barra sirve para las dos
     * vistas, por ejemplo para encontrar rápido un cliente puntual que
     * quedó mal posicionado en el orden de ruta.
     */
    get visitasFiltradas() {
        const base = this.state.mostrarVisitados ? this.visitasVisitadas : this.visitasPendientes;
        const texto = this.state.busquedaCliente.trim().toLowerCase();
        if (!texto) {
            return base;
        }
        return base.filter(
            (v) =>
                (v.nombre || "").toLowerCase().includes(texto) ||
                (v.direccion || "").toLowerCase().includes(texto)
        );
    }

    toggleMostrarVisitados() {
        this.state.mostrarVisitados = !this.state.mostrarVisitados;
    }

    etiquetaEstado(estado) {
        return ESTADO_ETIQUETA[estado] || estado;
    }

    cambiarTab(tab) {
        this.state.tab = tab;
    }

    abrirVisita(visita) {
        this.state.visitaAbiertaId = visita.id;
    }

    cerrarVisita() {
        this.state.visitaAbiertaId = null;
    }

    /**
     * La hoja de visita avisa con esto cuando cambió algo (estado,
     * GPS, datos del cliente) -- recargamos la lista/mapa por debajo
     * sin cerrar la hoja, para que el vendedor siga viendo el dato
     * actualizado sin perder su lugar.
     */
    recargarVisitas() {
        this.cargar();
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

        // Se destruye y se vuelve a crear cada vez que se entra a la
        // pestaña Mapa (el contenedor <div t-ref="mapa"> es un nodo DOM
        // nuevo cada vez, porque .map-wrap tiene t-if -- se desmonta al
        // salir de la pestaña). El efecto que llama a esto ya NO se
        // dispara solo (ver comentario en setup()), así que esto corre
        // una vez por entrada real a la pestaña, no en cada zoom/pan.
        if (this.mapboxMap) {
            this.mapboxMap.remove();
        }
        this._marcadorVendedor = null;
        this._markersPorVisita = {};
        this._clienteObjetivoActual = null;
        this.state.paletaVisible = false;

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
                // Pin NATIVO de Mapbox (Marker sin `element` propio,
                // solo `color`) -- prueba/fix para el reporte de que
                // los puntos se desubicaban al hacer zoom (nunca al
                // mover el mapa). Antes tenían un <div> con CSS propio
                // (gota + insignia con el número de orden); se saca esa
                // capa para descartarla como causa. El número de orden
                // se muestra ahora en el popup en vez de sobre el pin.
                //
                // Popup con nombre + orden + botón "Ir con Maps" propio
                // (antes solo mostraba el nombre en texto plano, con el
                // estilo por defecto de Mapbox -- casi ilegible).
                // setDOMContent en vez de setHTML para poder colgar el
                // listener del botón directo, reusando abrirMaps()
                // (misma acción que ya existe en la Lista).
                const popupEl = document.createElement("div");
                popupEl.className = "shalom-map-popup";
                const nombreEl = document.createElement("div");
                nombreEl.className = "shalom-map-popup-name";
                nombreEl.textContent = (v.orden ? "#" + v.orden + " · " : "") + v.nombre;
                popupEl.appendChild(nombreEl);
                const btnEl = document.createElement("button");
                btnEl.type = "button";
                btnEl.className = "shalom-map-popup-btn";
                btnEl.textContent = "🧭 Ir con Maps";
                btnEl.addEventListener("click", () => this.abrirMaps(v));
                popupEl.appendChild(btnEl);

                const marker = new window.mapboxgl.Marker({color: COLOR_MARCADOR[v.estado]})
                    .setLngLat([v.lng, v.lat])
                    .setPopup(new window.mapboxgl.Popup({offset: 24}).setDOMContent(popupEl))
                    .addTo(this.mapboxMap);
                this._markersPorVisita[v.id] = marker;
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

            this.mostrarPosicionVendedor();
            this.actualizarPaleta();
            // Recalcular la paletita cada vez que el vendedor mueve o
            // zoomea el mapa -- si el próximo pendiente entra en
            // pantalla, se esconde sola; si sale, aparece apuntando
            // para el lado que corresponda.
            this.mapboxMap.on("moveend", () => this.actualizarPaleta());
        });
    }

    /**
     * Punto pulsante en el color de marca (no un punto azul genérico)
     * en la posición GPS actual del vendedor -- pedido explícito para
     * poder ver a simple vista qué cliente queda más cerca. Es una sola
     * lectura (no seguimiento en vivo con watchPosition) cada vez que
     * se abre la pestaña Mapa o se toca "Centrar en mí", mismo patrón
     * que el resto de la app (capturarGps en visit_sheet.js, etc.). Si
     * no hay permiso de ubicación, falla en silencio -- el mapa sigue
     * funcionando igual sin el punto, no tiene sentido interrumpir con
     * un aviso cada vez que se abre la pestaña. `cb` (opcional) se
     * llama siempre al terminar, haya salido bien o no -- lo usa
     * centrarEnVendedor() para saber cuándo ya tiene this.posicionVendedor
     * disponible.
     *
     * Deliberadamente NUNCA toca fitBounds/el zoom ya fijado para los
     * clientes -- reportado en producción: al incluir la posición del
     * vendedor en un segundo fitBounds, una lectura de GPS imprecisa
     * forzaba que el mapa se alejara muchísimo para hacerla entrar,
     * dejando todo "amontonado" hasta zoomear manualmente. Por eso
     * además se descarta la lectura directamente si coords.accuracy es
     * demasiado mala -- un punto ausente es mejor que uno engañoso.
     */
    mostrarPosicionVendedor(cb) {
        if (!navigator.geolocation) {
            if (cb) {
                cb();
            }
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (position) => {
                if (!this.mapboxMap) {
                    if (cb) {
                        cb();
                    }
                    return; // la pantalla ya se cerró/recargó mientras esperábamos el GPS
                }
                if (
                    position.coords.accuracy &&
                    position.coords.accuracy > PRECISION_MAXIMA_ACEPTABLE_M
                ) {
                    // Lectura de baja precisión (típico de "ubicación
                    // aproximada" en vez de "precisa") -- se descarta en
                    // vez de mostrar un punto que puede estar a
                    // kilómetros de la posición real.
                    if (cb) {
                        cb();
                    }
                    return;
                }
                const {latitude, longitude} = position.coords;
                this.posicionVendedor = {lat: latitude, lng: longitude};
                if (this._marcadorVendedor) {
                    this._marcadorVendedor.setLngLat([longitude, latitude]);
                } else {
                    const el = document.createElement("div");
                    el.className = "shalom-marker-vendedor";
                    el.innerHTML = '<span class="shalom-marker-vendedor-punto"></span>';
                    this._marcadorVendedor = new window.mapboxgl.Marker({element: el})
                        .setLngLat([longitude, latitude])
                        .addTo(this.mapboxMap);
                }
                this.actualizarPaleta();
                if (cb) {
                    cb();
                }
            },
            () => {
                // Sin permiso o sin señal GPS -- se deja el mapa como
                // estaba, sin el punto del vendedor.
                if (cb) {
                    cb();
                }
            },
            {enableHighAccuracy: true, timeout: 10000, maximumAge: 30000}
        );
    }

    /**
     * Paletita direccional: apunta hacia el próximo cliente pendiente
     * en orden de ruta (el mismo que aparece primero en la pestaña
     * Lista) cada vez que ese cliente queda fuera del encuadre actual
     * del mapa -- pedido explícito, para no tener que andar buscándolo
     * a ojo. Se esconde sola si ya está a la vista, o si no queda
     * ningún pendiente con coordenadas.
     */
    actualizarPaleta() {
        if (!this.mapboxMap || !this.mapaRef.el) {
            return;
        }
        const objetivo = this.visitasPendientes.find((v) => v.lat && v.lng);
        this._clienteObjetivoActual = objetivo || null;
        if (!objetivo) {
            this.state.paletaVisible = false;
            return;
        }
        if (this.mapboxMap.getBounds().contains([objetivo.lng, objetivo.lat])) {
            this.state.paletaVisible = false;
            return;
        }
        const centro = this.mapboxMap.getCenter();
        const rumbo = calcularRumbo(centro.lat, centro.lng, objetivo.lat, objetivo.lng);
        const {x, y} = posicionEnBorde(
            rumbo,
            this.mapaRef.el.clientWidth,
            this.mapaRef.el.clientHeight,
            PALETA_MARGEN_PX
        );
        this.state.paletaVisible = true;
        this.state.paletaX = x;
        this.state.paletaY = y;
        this.state.paletaAngulo = rumbo;
    }

    /**
     * Click en la paletita: viaje SUAVE (no salto instantáneo, pedido
     * explícito) hacia el próximo cliente pendiente, y al terminar de
     * moverse le abre el popup -- así el vendedor decide ahí mismo si
     * usar "Ir con Maps" o seguir solo porque ya conoce el camino.
     */
    irAlSiguientePendiente() {
        const objetivo = this._clienteObjetivoActual;
        if (!objetivo || !this.mapboxMap) {
            return;
        }
        this.mapboxMap.easeTo({
            center: [objetivo.lng, objetivo.lat],
            zoom: Math.max(this.mapboxMap.getZoom(), 15),
            duration: 900,
        });
        this.mapboxMap.once("moveend", () => {
            const marker = this._markersPorVisita[objetivo.id];
            if (marker) {
                marker.togglePopup();
            }
        });
    }

    zoomMapaIn() {
        if (this.mapboxMap) {
            this.mapboxMap.zoomIn({duration: 250});
        }
    }

    zoomMapaOut() {
        if (this.mapboxMap) {
            this.mapboxMap.zoomOut({duration: 250});
        }
    }

    /**
     * Botón "Centrar en mí" -- si ya se tiene una lectura de GPS de
     * esta sesión (this.posicionVendedor) la reusa para no pedir el
     * permiso/GPS de nuevo; si no, lo pide en el momento.
     */
    centrarEnVendedor() {
        if (!this.mapboxMap) {
            return;
        }
        if (this.posicionVendedor) {
            this.mapboxMap.easeTo({
                center: [this.posicionVendedor.lng, this.posicionVendedor.lat],
                zoom: 15,
                duration: 800,
            });
            return;
        }
        this.mostrarPosicionVendedor(() => {
            if (this.posicionVendedor) {
                this.mapboxMap.easeTo({
                    center: [this.posicionVendedor.lng, this.posicionVendedor.lat],
                    zoom: 15,
                    duration: 800,
                });
            } else {
                this.notification.add("No se pudo obtener tu ubicación GPS.", {
                    type: "warning",
                });
            }
        });
    }

    volver() {
        this.props.onVolver();
    }
}
