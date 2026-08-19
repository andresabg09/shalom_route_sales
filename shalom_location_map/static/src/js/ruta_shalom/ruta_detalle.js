/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {cargarMapboxGl, getMapboxToken, parseWktLineString} from "./mapbox_utils";
import {
    distanciaMetros,
    obtenerDirecciones,
    recortarPolilineaDesde,
} from "./navegacion_utils";
import {ESTADO_ETIQUETA, estadoDesdeStageName} from "./stage_utils";
import {ClienteForm} from "./cliente_form";
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

// -- "Trazar ruta aquí": navegación en vivo estilo Waze -------------

// Si el vendedor se aleja más de esto de la línea trazada, se pide una
// ruta nueva a Mapbox sola (se desvió, dobló mal, etc.) -- pedido
// explícito ("recalculo automático"). No tan chico como para
// recalcular por el ruido normal de una lectura de GPS en la calle, ni
// tan grande como para tardar en notar un desvío real.
const NAV_UMBRAL_RECALCULO_M = 45;

// Piso de tiempo entre dos recalculados, aunque el GPS siga
// reportando "lejos de la línea" -- evita hacer una request a Mapbox
// por cada lectura de watchPosition (puede llegar cada 1-2s) mientras
// arranca a alejarse.
const NAV_INTERVALO_MIN_RECALCULO_MS = 8000;

// Debajo de esto se considera "llegó" al cliente -- corta la
// navegación sola, no hace falta que el vendedor la cierre a mano.
const NAV_UMBRAL_LLEGADA_M = 35;

// Largo del "destello"/hueco del patrón que anima la línea (unidades
// = ancho de línea, propias de line-dasharray) y cuántos pasos tiene
// un ciclo completo -- valores elegidos a ojo para que la animación
// se lea como una chispa recorriendo el cable, ni tan rápida que
// maree ni tan lenta que no se note.
const NAV_FLUJO_DASH = 1.4;
const NAV_FLUJO_HUECO = 2.6;
const NAV_FLUJO_PASOS = 28;
const NAV_FLUJO_INTERVALO_MS = 55;

const NAV_COLOR_GLOW_FALLBACK = "#b1245a"; // = --shalom-accent en modo claro
const NAV_COLOR_CHISPA = "#ff9dc2"; // tono claro sobre el color de marca, efecto "electricidad"

// Cuánto se pausa el auto-seguimiento de cámara (easeTo recentrando en
// el vendedor) después de que el vendedor mueve el mapa a mano durante
// una navegación en vivo -- pedido explícito: antes se recentraba en
// CADA lectura de GPS sin importar que el vendedor estuviera paneando
// para mirar el resto de la ruta, así que el mapa se sentía "pegado"
// / imposible de mover. 60s le da tiempo de examinar antes de que
// vuelva a seguirlo solo -- y tocar "Centrar en mí" (ícono fa-crosshairs, ya existía)
// lo reactiva antes si el vendedor ya terminó de mirar (ver
// centrarEnVendedor()).
const NAV_PAUSA_SEGUIMIENTO_MS = 60000;

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
    static components = {VisitSheet, ClienteForm};
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
        this._navPendiente = null; // visita a navegar en cuanto el mapa esté listo (disparado desde la Lista)
        this._navObjetivo = null; // visita destino de la navegación en curso
        this._navRouteCoords = null; // [[lng,lat], ...] del trazado actual, se va recortando
        this._navToken = null; // token público de Mapbox, cacheado para no volver a pedirlo en cada recálculo
        this._navWatchId = null; // id de navigator.geolocation.watchPosition
        this._navUltimoRecalculoTs = 0;
        this._navFlujoIntervalId = null; // setInterval de la animación de la línea
        this._navFlujoPaso = 0;
        this._navUltimaInteraccionUsuarioTs = 0; // último gesto real (drag/pinch) del vendedor sobre el mapa
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
            edicionLocationId: null,
            navegando: false,
            navNombreObjetivo: "",
            navDistanciaTexto: "",
            navDuracionTexto: "",
            navExpandido: false,
        });

        onWillStart(() => this.cargar());
        onWillUnmount(() => {
            this.detenerNavegacion();
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
                    "x_venta_mas_alta",
                ]);
                datosPorLocation = Object.fromEntries(locaciones.map((l) => [l.id, l]));
            }

            this.state.visitas = ordenes.map((o) => {
                const loc = o.location_id ? datosPorLocation[o.location_id[0]] : null;
                return {
                    id: o.id,
                    locationId: o.location_id ? o.location_id[0] : null,
                    nombre: o.location_id ? o.location_id[1] : "Sin cliente",
                    orden: o.x_cliente_orden_ruta,
                    estado: estadoDesdeStageName(o.stage_name),
                    lat: o.x_cliente_lat,
                    lng: o.x_cliente_lng,
                    telefono: loc ? loc.phone : "",
                    direccion: loc ? loc.street : "",
                    metaVenta: loc ? loc.x_venta_mas_alta : 0,
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
        // Salir de la pestaña Mapa corta cualquier navegación en curso
        // -- el contenedor del mapa se desmonta (t-if en .map-wrap), así
        // que seguir escribiendo sobre el mapa/GPS desde acá no tendría
        // dónde mostrarse y solo gastaría batería/datos de más.
        if (this.state.tab === "mapa" && tab !== "mapa") {
            this.detenerNavegacion();
        }
        this.state.tab = tab;
    }

    abrirVisita(visita) {
        this.state.visitaAbiertaId = visita.id;
    }

    cerrarVisita() {
        this.state.visitaAbiertaId = null;
    }

    /**
     * Tocar el nombre del cliente dentro del popup de su pin (Mapa) --
     * abre el mismo ClienteForm (modo "editar") que ya usan la pestaña
     * Clientes y "Editar cliente" en la Hoja de Visita, como overlay
     * sobre esta pantalla.
     */
    abrirEdicionCliente(visita) {
        if (!visita.locationId) {
            return;
        }
        this.state.edicionLocationId = visita.locationId;
    }

    cerrarEdicionCliente() {
        this.state.edicionLocationId = null;
    }

    async edicionClienteGuardada() {
        this.state.edicionLocationId = null;
        await this.cargar();
        // El nombre puede haber cambiado -- si el mapa está a la vista,
        // se vuelve a dibujar para que el popup/pin reflejen el dato
        // nuevo (mismo criterio que recargarVisitas() con VisitSheet).
        if (this.state.tab === "mapa" && this.mapaRef.el) {
            this.dibujarMapa();
        }
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
        this._navToken = token;
        await cargarMapboxGl();
        window.mapboxgl.accessToken = token;

        const conCoordenadas = this.state.visitas.filter((v) => v.lat && v.lng);

        // Se destruye y se vuelve a crear cada vez que se entra a la
        // pestaña Mapa (el contenedor <div t-ref="mapa"> es un nodo DOM
        // nuevo cada vez, porque .map-wrap tiene t-if -- se desmonta al
        // salir de la pestaña). El efecto que llama a esto ya NO se
        // dispara solo (ver comentario en setup()), así que esto corre
        // una vez por entrada real a la pestaña, no en cada zoom/pan.
        this.detenerNavegacion();
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
                // Pin con `element` propio: círculo de color por
                // estado (--pin-color) con el número de orden adentro
                // -- clase .shalom-marker-numero (ruta_shalom.scss).
                //
                // OJO -- historial real en producción, para quien
                // toque esto después: se probaron DOS formas de gota
                // custom (border-radius+rotate primero, un <svg> con
                // el path ya dibujado sin rotate después) y las DOS
                // reprodujeron el mismo bug ("los pines se desubican
                // al hacer zoom"). Es decir, la causa no era el
                // rotate() en sí -- sigue sin confirmarse qué es
                // exactamente (sospecha: anchor "bottom" con un
                // elemento no cuadrado, y/o el filter: drop-shadow del
                // SVG interactuando mal con el transform que aplica
                // Mapbox durante el pinch-zoom). Este círculo simple
                // (cuadrado 30x30, anchor "center", sin filter/rotate)
                // es la ÚNICA versión confirmada estable en producción
                // -- no cambiar la forma del pin sin probar a fondo el
                // zoom en el celular real antes de darlo por bueno.
                const pinEl = document.createElement("div");
                pinEl.className = "shalom-marker-numero";
                pinEl.style.setProperty("--pin-color", COLOR_MARCADOR[v.estado]);
                if (v.orden) {
                    const numEl = document.createElement("span");
                    numEl.className = "shalom-marker-numero-txt";
                    numEl.textContent = String(v.orden);
                    pinEl.appendChild(numEl);
                }

                // Popup: nombre tocable (abre la ficha de edición del
                // cliente, mismo ClienteForm que la pestaña Clientes) +
                // "Ir con Maps" + "Trazar ruta aquí" (navegación en
                // vivo con Mapbox). setDOMContent en vez de setHTML
                // para poder colgar los listeners directo.
                const popupEl = document.createElement("div");
                popupEl.className = "shalom-map-popup";
                const nombreEl = document.createElement("button");
                nombreEl.type = "button";
                nombreEl.className = "shalom-map-popup-name shalom-map-popup-name-btn";
                nombreEl.textContent = (v.orden ? "#" + v.orden + " · " : "") + v.nombre;
                const editIconEl = document.createElement("i");
                editIconEl.className = "fa fa-pencil";
                editIconEl.setAttribute("aria-hidden", "true");
                nombreEl.appendChild(document.createTextNode(" "));
                nombreEl.appendChild(editIconEl);
                nombreEl.title = "Editar cliente";
                nombreEl.addEventListener("click", () => this.abrirEdicionCliente(v));
                popupEl.appendChild(nombreEl);

                const accionesEl = document.createElement("div");
                accionesEl.className = "shalom-map-popup-acciones";
                const btnMapsEl = document.createElement("button");
                btnMapsEl.type = "button";
                btnMapsEl.className = "shalom-map-popup-btn";
                btnMapsEl.innerHTML = '<i class="fa fa-location-arrow" aria-hidden="true"></i> Ir con Maps';
                btnMapsEl.addEventListener("click", () => this.abrirMaps(v));
                accionesEl.appendChild(btnMapsEl);
                const btnNavEl = document.createElement("button");
                btnNavEl.type = "button";
                btnNavEl.className = "shalom-map-popup-btn shalom-map-popup-btn-nav";
                btnNavEl.innerHTML = '<i class="fa fa-map-pin" aria-hidden="true"></i> Trazar ruta aquí';
                btnNavEl.addEventListener("click", () => this.iniciarNavegacion(v));
                accionesEl.appendChild(btnNavEl);
                popupEl.appendChild(accionesEl);

                const marker = new window.mapboxgl.Marker({element: pinEl, anchor: "center"})
                    .setLngLat([v.lng, v.lat])
                    .setPopup(new window.mapboxgl.Popup({offset: 30}).setDOMContent(popupEl))
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

            // Distingue un gesto REAL del vendedor (drag, pellizco de
            // zoom, rueda del mouse) de un movimiento programático
            // nuestro (easeTo/flyTo, ej. el auto-seguimiento durante
            // "Trazar ruta aquí") -- Mapbox solo llena `originalEvent`
            // en el primer caso. Se usa para pausar el auto-seguimiento
            // mientras el vendedor está paneando a propósito (ver
            // _moverMarcadorVendedor).
            this.mapboxMap.on("movestart", (e) => {
                if (e.originalEvent) {
                    this._navUltimaInteraccionUsuarioTs = Date.now();
                }
            });

            // "Trazar ruta aquí" tocado desde la Lista (no había mapa
            // todavía) -- quedó guardado en _navPendiente al cambiar de
            // pestaña; recién ahora, con el mapa ya cargado, arranca.
            if (this._navPendiente) {
                const objetivo = this._navPendiente;
                this._navPendiente = null;
                this.iniciarNavegacion(objetivo);
            }
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
     * permiso/GPS de nuevo; si no, lo pide en el momento. Durante una
     * navegación en vivo, tocarlo también reactiva el auto-seguimiento
     * al toque (sin esperar los 60s de NAV_PAUSA_SEGUIMIENTO_MS) --
     * es la forma explícita en que el vendedor dice "ya terminé de
     * mirar, seguime de nuevo".
     */
    centrarEnVendedor() {
        if (!this.mapboxMap) {
            return;
        }
        if (this.state.navegando) {
            this._navUltimaInteraccionUsuarioTs = 0;
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

    // -- "Trazar ruta aquí": navegación en vivo estilo Waze ---------

    /**
     * Punto de entrada desde la Lista (donde todavía no hay mapa
     * dibujado): cambia a la pestaña Mapa y deja la visita guardada en
     * _navPendiente -- dibujarMapa() la retoma sola en cuanto el mapa
     * termine de cargar (evento "load"). Desde el popup del pin (Mapa
     * ya abierto) se llama a iniciarNavegacion() directo, sin pasar
     * por acá.
     */
    trazarRutaAquiDesdeLista(visita) {
        if (!visita.lat && !visita.lng) {
            this.notification.add(
                "Este cliente todavía no tiene coordenadas GPS guardadas.",
                {type: "warning"}
            );
            return;
        }
        this._navPendiente = visita;
        this.cambiarTab("mapa");
    }

    /**
     * Arranca (o reinicia, si ya se estaba navegando hacia otro
     * cliente) la navegación en vivo: pide la posición GPS actual,
     * pide a Mapbox el trazado calle-por-calle hasta `visita`, lo
     * dibuja, y arranca watchPosition para ir recortando la línea y
     * siguiendo al vendedor en el mapa -- ver recortarPolilineaDesde()
     * en navegacion_utils.js para el detalle de cómo se recorta.
     */
    iniciarNavegacion(visita) {
        if (!visita.lat || !visita.lng) {
            this.notification.add(
                "Este cliente todavía no tiene coordenadas GPS guardadas.",
                {type: "warning"}
            );
            return;
        }
        if (!this.mapboxMap) {
            return;
        }
        if (!navigator.geolocation) {
            this.notification.add("Este navegador no soporta geolocalización.", {
                type: "danger",
            });
            return;
        }
        // Si ya había una navegación activa (hacia otro cliente, o el
        // vendedor tocó "Trazar ruta aquí" dos veces), se corta la
        // anterior primero -- una sola navegación a la vez.
        this.detenerNavegacion();

        this._navObjetivo = visita;
        this.state.navegando = true;
        this.state.navNombreObjetivo = visita.nombre;
        this.state.navDistanciaTexto = "";
        this.state.navDuracionTexto = "";
        this.state.navExpandido = false;

        // Primera ruta: se pide con una sola lectura de GPS (no hace
        // falta esperar a watchPosition para el trazado inicial).
        navigator.geolocation.getCurrentPosition(
            (position) => this._procesarPosicionNav(position, true),
            () => {
                this.notification.add(
                    "No se pudo obtener tu ubicación GPS para trazar la ruta.",
                    {type: "danger"}
                );
                this.detenerNavegacion();
            },
            {enableHighAccuracy: true, timeout: 15000, maximumAge: 0}
        );

        // A partir de ahí, seguimiento en vivo -- a diferencia del
        // resto del mapa (una sola lectura por entrada a la pestaña),
        // acá sí hace falta watchPosition: es lo que permite recortar
        // la línea y recalcular si el vendedor se desvía.
        this._navWatchId = navigator.geolocation.watchPosition(
            (position) => this._procesarPosicionNav(position, false),
            () => {
                // Sin señal puntual -- se deja la última línea/posición
                // como estaba, no tiene sentido cortar la navegación
                // por una lectura fallida aislada.
            },
            {enableHighAccuracy: true, timeout: 15000, maximumAge: 0}
        );

        this._iniciarAnimacionFlujo();
    }

    /**
     * Callback común de la primera lectura (getCurrentPosition) y de
     * cada actualización en vivo (watchPosition): recorta la línea
     * hasta la posición actual, sigue al vendedor en el mapa, y decide
     * si hace falta pedir una ruta nueva a Mapbox (primera vez siempre,
     * o si el vendedor se alejó demasiado de la línea trazada).
     */
    async _procesarPosicionNav(position, esPrimeraVez) {
        if (!this.state.navegando || !this._navObjetivo || !this.mapboxMap) {
            return;
        }
        if (
            position.coords.accuracy &&
            position.coords.accuracy > PRECISION_MAXIMA_ACEPTABLE_M
        ) {
            return; // mismo criterio que mostrarPosicionVendedor(): descartar lecturas malas
        }
        const punto = {lat: position.coords.latitude, lng: position.coords.longitude};
        this.posicionVendedor = punto;
        this._moverMarcadorVendedor(punto);

        const objetivo = this._navObjetivo;
        const distanciaAlDestinoM = distanciaMetros(
            punto.lat,
            punto.lng,
            objetivo.lat,
            objetivo.lng
        );
        if (distanciaAlDestinoM <= NAV_UMBRAL_LLEGADA_M) {
            this.notification.add(`Llegaste a ${objetivo.nombre}. 🎉`, {type: "success"});
            this.detenerNavegacion();
            return;
        }

        if (!esPrimeraVez && this._navRouteCoords) {
            const {coordenadas, distanciaALaLineaM} = recortarPolilineaDesde(
                punto,
                this._navRouteCoords
            );
            const ahora = Date.now();
            const puedeRecalcular =
                ahora - this._navUltimoRecalculoTs > NAV_INTERVALO_MIN_RECALCULO_MS;
            if (distanciaALaLineaM > NAV_UMBRAL_RECALCULO_M && puedeRecalcular) {
                // Se desvió de la línea trazada -- ruta nueva desde
                // donde está parado ahora, en vez de seguir recortando
                // una línea que ya no representa el camino real.
                await this._pedirRutaNav(punto, objetivo);
                return;
            }
            this._navRouteCoords = coordenadas;
            this._actualizarLineaNav(coordenadas);
            return;
        }

        // Primera lectura (o todavía no había línea por algún motivo):
        // pedir el trazado inicial completo.
        await this._pedirRutaNav(punto, objetivo);
    }

    /** Pide a Mapbox el trazado punto→punto y lo deja dibujado. */
    async _pedirRutaNav(origen, objetivo) {
        try {
            const resultado = await obtenerDirecciones(
                origen,
                {lat: objetivo.lat, lng: objetivo.lng},
                this._navToken
            );
            this._navUltimoRecalculoTs = Date.now();
            if (!this.state.navegando || this._navObjetivo !== objetivo) {
                return; // se canceló o cambió de objetivo mientras esperaba la respuesta
            }
            if (!resultado) {
                this.notification.add(
                    "Mapbox no encontró una ruta hasta este cliente.",
                    {type: "warning"}
                );
                return;
            }
            this._navRouteCoords = resultado.coordenadas;
            this._dibujarLineaNav(resultado.coordenadas);
            this.state.navDistanciaTexto = this._formatearDistancia(resultado.distanciaM);
            this.state.navDuracionTexto = this._formatearDuracion(resultado.duracionS);
        } catch (error) {
            this.notification.add("No se pudo trazar la ruta con Mapbox.", {type: "danger"});
        }
    }

    _formatearDistancia(metros) {
        return metros >= 1000 ? `${(metros / 1000).toFixed(1)} km` : `${Math.round(metros)} m`;
    }

    _formatearDuracion(segundos) {
        const minutos = Math.round(segundos / 60);
        return minutos < 1 ? "< 1 min" : `${minutos} min`;
    }

    _moverMarcadorVendedor(punto) {
        if (this._marcadorVendedor) {
            this._marcadorVendedor.setLngLat([punto.lng, punto.lat]);
        } else {
            const el = document.createElement("div");
            el.className = "shalom-marker-vendedor";
            el.innerHTML = '<span class="shalom-marker-vendedor-punto"></span>';
            this._marcadorVendedor = new window.mapboxgl.Marker({element: el})
                .setLngLat([punto.lng, punto.lat])
                .addTo(this.mapboxMap);
        }
        // Modo "seguidor": el mapa sigue centrado en el vendedor
        // mientras navega, como Waze/Maps -- pero NO si el vendedor
        // panéo el mapa a mano hace poco (ver NAV_PAUSA_SEGUIMIENTO_MS
        // y el listener "movestart" en dibujarMapa): antes se
        // recentraba en cada lectura de GPS sin excepción, así que
        // cualquier intento de mirar el resto de la ruta se sentía
        // "pegado" -- el mapa volvía solo casi al toque.
        const pausado =
            Date.now() - this._navUltimaInteraccionUsuarioTs < NAV_PAUSA_SEGUIMIENTO_MS;
        if (!pausado) {
            this.mapboxMap.easeTo({center: [punto.lng, punto.lat], duration: 400});
        }
    }

    /**
     * Crea (primera vez) o reemplaza (recálculo) las 3 capas de la
     * línea de navegación -- ver constantes NAV_* al principio del
     * archivo:
     *   - "shalom-nav-glow": halo ancho y difuminado en el color de
     *     marca -- el "brillo" pedido, mismo color que ya usa el resto
     *     de la app (--shalom-accent).
     *   - "shalom-nav-base": línea sólida fina, mismo color, marca el
     *     camino real.
     *   - "shalom-nav-chispa": línea más clara con line-dasharray
     *     animado (ver _iniciarAnimacionFlujo) -- el destello que
     *     recorre el cable, efecto "serpiente de luz"/corriente
     *     eléctrica pedido.
     */
    _dibujarLineaNav(coordenadas) {
        const geojson = {
            type: "Feature",
            properties: {},
            geometry: {type: "LineString", coordinates: coordenadas},
        };
        const fuente = this.mapboxMap.getSource("shalom-nav-ruta");
        if (fuente) {
            fuente.setData(geojson);
            return;
        }

        const colorMarca = this._colorAccentActual();
        this.mapboxMap.addSource("shalom-nav-ruta", {type: "geojson", data: geojson});
        this.mapboxMap.addLayer({
            id: "shalom-nav-glow",
            type: "line",
            source: "shalom-nav-ruta",
            layout: {"line-join": "round", "line-cap": "round"},
            paint: {
                "line-color": colorMarca,
                "line-width": 16,
                "line-opacity": 0.28,
                "line-blur": 8,
            },
        });
        this.mapboxMap.addLayer({
            id: "shalom-nav-base",
            type: "line",
            source: "shalom-nav-ruta",
            layout: {"line-join": "round", "line-cap": "round"},
            paint: {"line-color": colorMarca, "line-width": 5, "line-opacity": 0.9},
        });
        this.mapboxMap.addLayer({
            id: "shalom-nav-chispa",
            type: "line",
            source: "shalom-nav-ruta",
            layout: {"line-join": "round", "line-cap": "round"},
            paint: {
                "line-color": NAV_COLOR_CHISPA,
                "line-width": 5,
                "line-opacity": 0.95,
                "line-blur": 1.2,
                "line-dasharray": [0, NAV_FLUJO_HUECO, NAV_FLUJO_DASH],
            },
        });
    }

    _actualizarLineaNav(coordenadas) {
        const fuente = this.mapboxMap && this.mapboxMap.getSource("shalom-nav-ruta");
        if (!fuente) {
            return;
        }
        fuente.setData({
            type: "Feature",
            properties: {},
            geometry: {type: "LineString", coordinates: coordenadas},
        });
    }

    /** Lee --shalom-accent ya resuelto (claro u oscuro) del DOM real. */
    _colorAccentActual() {
        if (!this.mapaRef.el) {
            return NAV_COLOR_GLOW_FALLBACK;
        }
        const valor = getComputedStyle(this.mapaRef.el).getPropertyValue("--shalom-accent").trim();
        return valor || NAV_COLOR_GLOW_FALLBACK;
    }

    /**
     * Anima la capa "shalom-nav-chispa" recorriendo line-dasharray en
     * pasos -- técnica estándar de Mapbox GL para simular movimiento
     * sobre una línea (no hay una propiedad de "offset" nativa): en
     * cada paso el destello (largo NAV_FLUJO_DASH) avanza un poco
     * dentro de un ciclo de largo NAV_FLUJO_DASH+NAV_FLUJO_HUECO, y al
     * completar el ciclo vuelve a 0 sin que se note el salto.
     */
    _iniciarAnimacionFlujo() {
        this._detenerAnimacionFlujo();
        const periodo = NAV_FLUJO_DASH + NAV_FLUJO_HUECO;
        this._navFlujoPaso = 0;
        this._navFlujoIntervalId = setInterval(() => {
            if (!this.mapboxMap || !this.mapboxMap.getLayer("shalom-nav-chispa")) {
                return;
            }
            this._navFlujoPaso = (this._navFlujoPaso + 1) % NAV_FLUJO_PASOS;
            const avance = (this._navFlujoPaso / NAV_FLUJO_PASOS) * periodo;
            const dasharray =
                avance <= NAV_FLUJO_DASH
                    ? [avance, NAV_FLUJO_HUECO, NAV_FLUJO_DASH - avance]
                    : [0, avance - NAV_FLUJO_DASH, NAV_FLUJO_DASH, periodo - avance];
            this.mapboxMap.setPaintProperty("shalom-nav-chispa", "line-dasharray", dasharray);
        }, NAV_FLUJO_INTERVALO_MS);
    }

    _detenerAnimacionFlujo() {
        if (this._navFlujoIntervalId) {
            clearInterval(this._navFlujoIntervalId);
            this._navFlujoIntervalId = null;
        }
    }

    /**
     * Corta la navegación en vivo por completo: watchPosition,
     * animación de la chispa, y las 3 capas de la línea -- se llama al
     * llegar, al tocar "Salir" a mano, al cambiar de pestaña, al
     * volver a dibujar el mapa, o al desmontar el componente. Nunca
     * lanza aunque se llame varias veces seguidas (todos los `if`
     * guardan contra el caso "ya estaba parado").
     */
    detenerNavegacion() {
        if (this._navWatchId !== null && navigator.geolocation) {
            navigator.geolocation.clearWatch(this._navWatchId);
            this._navWatchId = null;
        }
        this._detenerAnimacionFlujo();
        this._navObjetivo = null;
        this._navRouteCoords = null;
        this.state.navegando = false;
        this.state.navNombreObjetivo = "";
        this.state.navDistanciaTexto = "";
        this.state.navDuracionTexto = "";
        this.state.navExpandido = false;
        if (this.mapboxMap) {
            ["shalom-nav-glow", "shalom-nav-base", "shalom-nav-chispa"].forEach((id) => {
                if (this.mapboxMap.getLayer(id)) {
                    this.mapboxMap.removeLayer(id);
                }
            });
            if (this.mapboxMap.getSource("shalom-nav-ruta")) {
                this.mapboxMap.removeSource("shalom-nav-ruta");
            }
        }
    }

    /**
     * La barra de navegación arranca colapsada (solo el ícono fa-map-o) para
     * no taparle la vista del mapa al vendedor -- pedido explícito. Un
     * toque la expande mostrando destino + distancia/tiempo, otro
     * toque la vuelve a colapsar. La animación (ancho + opacidad) es
     * puramente CSS, ver .nav-barra/.nav-barra-expandida en
     * ruta_shalom.scss.
     */
    toggleNavExpandido() {
        this.state.navExpandido = !this.state.navExpandido;
    }

    volver() {
        this.props.onVolver();
    }
}
