/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {registry} from "@web/core/registry";
import {useService} from "@web/core/utils/hooks";
import {ClienteForm} from "./cliente_form";
import {OrderScreen} from "./order_screen";
import {ESTADO_ETIQUETA, estadoDesdeStageName} from "./stage_utils";
import {getMapboxToken, cargarMapboxGl} from "./mapbox_utils";

// Cada cuánto se refresca la lista de "Visitas en vivo" (quién tiene
// el catálogo abierto ahora mismo) -- más espaciado que el heartbeat
// de visit_sheet.js porque acá es una lista completa, no una sola
// visita.
const SHALOM_INTERVALO_LISTA_EN_VIVO_MS = 3000;

/**
 * Administración (punto 4 de la ronda "administración", ver README.md):
 * dos secciones -- Seguimiento de Visitas y Rutas de mis vendedores --
 * en pestañas conmutables (mismo `.segmented` de ruta_detalle.js,
 * Lista/Mapa), no apiladas en una sola página. Se probaron apiladas
 * (ronda anterior) y era inusable con volumen real: con varias visitas
 * pendientes, la lista de Seguimiento empujaba el mapa de Rutas a un
 * tamaño ridículo (bug real de flexbox: `.admin-mapa-wrap` tiene
 * `overflow` propio, así que su "automatic minimum size" es 0 en vez
 * del tamaño de su contenido -- el flex-shrink de `.admin-body` lo
 * exprimía para que todo entrara). Con pestañas, cada sección tiene
 * toda la altura disponible para sí sola.
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
    static components = {ClienteForm, OrderScreen};
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        this.mapaRef = useRef("mapaAdmin");
        this.mapboxMap = null;
        // {ordenId: {marker, pinEl}} -- para la resaltada bidireccional
        // pin<->fila de la lista (ver resaltarDesdeLista/DesdeMapa).
        this._markersPorCliente = {};

        this.state = useState({
            // -- pestaña activa --
            tab: "seguimiento",

            // -- Seguimiento de Visitas --
            cargandoVisitas: true,
            visitas: [],
            estadosActivos: [...ESTADOS_SEGUIMIENTO_DEFAULT],
            filtroVendedorNombre: "",
            filtroRutaNombre: "",
            busquedaVisita: "",

            // -- Rutas de mis vendedores --
            cargandoVendedores: true,
            vendedores: [],
            vendedorSeleccionadoId: null,
            scheduleSeleccionadoId: null,
            cargandoClientesRuta: false,
            clientesRuta: [],
            busquedaClienteRuta: "",
            clienteResaltadoId: null,

            // -- En vivo --
            cargandoEnVivo: true,
            visitasEnVivo: [],
            orderIdEnVivo: null,
            clienteEnVivoNombre: "",

            // -- compartido --
            locationIdEditando: null,
        });
        this._enVivoTimer = null;

        onWillStart(async () => {
            await Promise.all([this.cargarVisitas(), this.cargarVendedores(), this.cargarVisitasEnVivo()]);
        });
        this._enVivoTimer = setInterval(
            () => this.cargarVisitasEnVivo(), SHALOM_INTERVALO_LISTA_EN_VIVO_MS
        );
        onWillUnmount(() => {
            if (this.mapboxMap) {
                this.mapboxMap.remove();
            }
            if (this._enVivoTimer) {
                clearInterval(this._enVivoTimer);
            }
        });

        // Mismo patrón que ruta_detalle.js (ver su comentario grande al
        // respecto): NO dibujar el mapa con un setTimeout "a mano"
        // después de elegirRuta() -- bug real reportado en producción
        // ("el mapa aparece un instante y desaparece"). Owl programa
        // sus repintados de forma asíncrona, así que ese setTimeout
        // podía correr sobre un <div> viejo, a punto de ser reemplazado
        // por el nodo real que Owl termina dejando en pantalla. Con
        // useEffect, este código corre recién DESPUÉS de que Owl
        // terminó de pintar el DOM, con this.mapaRef.el ya poblado y
        // estable.
        useEffect(
            () => {
                if (
                    this.state.scheduleSeleccionadoId &&
                    this.mapaRef.el &&
                    !this.state.cargandoClientesRuta
                ) {
                    this.dibujarMapaAdmin();
                }
            },
            () => [this.state.scheduleSeleccionadoId, this.state.cargandoClientesRuta]
        );
    }

    cambiarTab(tab) {
        this.state.tab = tab;
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

    /** Vendedores presentes en el listado actual de visitas (no el de
     * "Rutas de mis vendedores" -- distintos vendedores pueden tener
     * visitas en seguimiento aunque no tengan rutas programadas hoy),
     * para el filtro. Se recalcula solo de los datos ya cargados, sin
     * pedir nada nuevo al servidor. */
    get vendedoresConVisitas() {
        return [...new Set(this.state.visitas.map((v) => v.vendedor_nombre || "Sin vendedor"))].sort();
    }

    /** Rutas presentes en el listado actual, acotadas al vendedor
     * elegido en el filtro (si hay uno) -- para que el select de ruta
     * no muestre rutas de otros vendedores. A propósito sale de
     * `state.visitas` (solo las rutas con alguna visita en el estado
     * activo ahora), no de la lista completa de rutas del vendedor --
     * se probó mostrar todas (9-11 por vendedor) y no gustó: ocupa
     * espacio de más para rutas sin nada que revisar. */
    get rutasConVisitas() {
        const visitas = this.state.filtroVendedorNombre
            ? this.state.visitas.filter(
                  (v) => (v.vendedor_nombre || "Sin vendedor") === this.state.filtroVendedorNombre
              )
            : this.state.visitas;
        return [...new Set(visitas.map((v) => v.ruta_nombre || "Sin ruta"))].sort();
    }

    get visitasFiltradas() {
        const texto = this.state.busquedaVisita.trim().toLowerCase();
        return this.state.visitas.filter((v) => {
            if (
                this.state.filtroVendedorNombre &&
                (v.vendedor_nombre || "Sin vendedor") !== this.state.filtroVendedorNombre
            ) {
                return false;
            }
            if (
                this.state.filtroRutaNombre &&
                (v.ruta_nombre || "Sin ruta") !== this.state.filtroRutaNombre
            ) {
                return false;
            }
            if (texto && !(v.cliente_nombre || "").toLowerCase().includes(texto)) {
                return false;
            }
            return true;
        });
    }

    elegirFiltroVendedor(ev) {
        this.state.filtroVendedorNombre = ev.target.value;
        // La ruta elegida podría no pertenecer al vendedor nuevo --
        // mejor arrancar de nuevo que mostrar una lista vacía confusa.
        this.state.filtroRutaNombre = "";
    }

    elegirFiltroRuta(ev) {
        this.state.filtroRutaNombre = ev.target.value;
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
    // En vivo (punto C): mismo catálogo/carrito que usa el vendedor,
    // embebido acá igual que ClienteForm más abajo -- no es una
    // pantalla "de solo mirar" aparte, es la misma con la que ya
    // trabaja el vendedor (ver order_screen.js para la sincronización
    // de ~1 seg entre dispositivos).
    // ==================================================================

    async cargarVisitasEnVivo() {
        // No usar el "cargando" para tapar la lista en cada refresco
        // automático (solo la primera vez) -- si no, la lista
        // parpadea cada 3 seg mientras el admin está mirándola.
        if (!this.state.visitasEnVivo.length) {
            this.state.cargandoEnVivo = true;
        }
        try {
            this.state.visitasEnVivo = await this.orm.call(
                "fsm.order", "shalom_admin_visitas_en_vivo", []
            );
        } catch (error) {
            console.error("shalom: error al cargar visitas en vivo", error);
        } finally {
            this.state.cargandoEnVivo = false;
        }
    }

    abrirEnVivo(visita) {
        this.state.orderIdEnVivo = visita.id;
        this.state.clienteEnVivoNombre = visita.cliente_nombre || "";
    }

    cerrarEnVivo() {
        this.state.orderIdEnVivo = null;
        this.cargarVisitasEnVivo();
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

    /** Ruta activa completa (route_name/cantidad_clientes) -- para el
     * chip flotante sobre el mapa (mockup aprobado, "Vista previa:
     * Administración"), que reemplaza el título repetido que antes
     * llevaba cada tarjeta de ruta. */
    get rutaSeleccionada() {
        const vendedor = this.vendedorSeleccionado;
        if (!vendedor) {
            return null;
        }
        return vendedor.rutas.find((r) => r.id === this.state.scheduleSeleccionadoId) || null;
    }

    elegirVendedor(ev) {
        this.state.vendedorSeleccionadoId = Number(ev.target.value);
        this.state.scheduleSeleccionadoId = null;
        this.state.clientesRuta = [];
    }

    async elegirRuta(ruta) {
        this.state.scheduleSeleccionadoId = ruta.id;
        this.state.busquedaClienteRuta = "";
        this.state.clienteResaltadoId = null;
        await this.cargarClientesRuta();
        // El dibujo del mapa lo dispara el useEffect de setup() cuando
        // Owl termina de pintar el DOM -- ver el comentario grande ahí.
    }

    get clientesRutaFiltrados() {
        const texto = this.state.busquedaClienteRuta.trim().toLowerCase();
        if (!texto) {
            return this.state.clientesRuta;
        }
        return this.state.clientesRuta.filter((c) => c.nombre.toLowerCase().includes(texto));
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

        // Defensivo -- bug real reportado ("el mapa se ve chiquito"):
        // si en el instante exacto de crear el mapa el contenedor
        // todavía no tenía aplicado su alto final de CSS, Mapbox mide
        // un <canvas> chico y se queda así aunque el contenedor crezca
        // un instante después. Un resize() explícito, ya en el próximo
        // frame y de nuevo cuando el estilo terminó de cargar ("load"),
        // fuerza a que vuelva a medir el contenedor con su tamaño real.
        requestAnimationFrame(() => this.mapboxMap && this.mapboxMap.resize());

        this._markersPorCliente = {};

        this.mapboxMap.on("load", () => {
            this.mapboxMap.resize();
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

                // Mismo popup que ruta_detalle.js al tocar un pin (name +
                // fila de botones) en vez de saltar directo a editar --
                // pedido explícito: acá los botones son Editar cliente y
                // Buscar GPS (no Waze/Trazar ruta, que son de venta).
                const popupEl = document.createElement("div");
                popupEl.className = "shalom-map-popup";
                const nombreEl = document.createElement("div");
                nombreEl.className = "shalom-map-popup-name";
                nombreEl.textContent = (c.orden ? "#" + c.orden + " · " : "") + c.nombre;
                popupEl.appendChild(nombreEl);

                const accionesEl = document.createElement("div");
                accionesEl.className = "shalom-map-popup-acciones";
                const btnEditarEl = document.createElement("button");
                btnEditarEl.type = "button";
                btnEditarEl.className = "shalom-map-popup-btn";
                btnEditarEl.innerHTML = '<i class="fa fa-pencil" aria-hidden="true"></i> Editar cliente';
                btnEditarEl.addEventListener("click", () => this.abrirEdicionCliente(c.locationId));
                accionesEl.appendChild(btnEditarEl);
                const btnGpsEl = document.createElement("button");
                btnGpsEl.type = "button";
                btnGpsEl.className = "shalom-map-popup-btn shalom-map-popup-btn-nav";
                btnGpsEl.innerHTML = '<i class="fa fa-crosshairs" aria-hidden="true"></i> Buscar GPS';
                btnGpsEl.addEventListener("click", () => this.buscarGps(null, c.locationId));
                accionesEl.appendChild(btnGpsEl);
                popupEl.appendChild(accionesEl);

                const marker = new window.mapboxgl.Marker({element: pinEl, anchor: "center"})
                    .setLngLat([c.lng, c.lat])
                    .setPopup(new window.mapboxgl.Popup({offset: 30}).setDOMContent(popupEl))
                    .addTo(this.mapboxMap);

                // Resaltado bidireccional pin<->fila de la lista, pedido
                // explícito: tocar un pin resalta su fila (para ubicar
                // cuál cliente es en la lista) y viceversa (ver
                // resaltarDesdeLista(), del lado de la fila). El propio
                // Marker de Mapbox ya togglea su popup solo al hacer
                // click en el elemento -- este listener solo agrega el
                // resaltado, no reemplaza eso.
                if (c.ordenId !== undefined) {
                    this._markersPorCliente[c.ordenId] = {marker, pinEl};
                    pinEl.addEventListener("click", () => this.resaltarDesdeMapa(c.ordenId));
                }

                bounds.extend([c.lng, c.lat]);
            });
            if (conCoordenadas.length > 1) {
                this.mapboxMap.fitBounds(bounds, {padding: 50, maxZoom: 15});
            }
        });
    }

    /** Tocar un pin del mapa: resalta la fila correspondiente en la
     * lista de la derecha (scrollea hasta ella si hace falta). El
     * popup del pin (Editar/GPS) ya lo abre Mapbox solo. */
    resaltarDesdeMapa(ordenId) {
        this.state.clienteResaltadoId = ordenId;
        this._marcarPinResaltado(ordenId);
        const fila = document.querySelector(`[data-orden-id="${ordenId}"]`);
        if (fila) {
            fila.scrollIntoView({block: "nearest", behavior: "smooth"});
        }
    }

    /** Tocar una fila de la lista: resalta y centra su pin en el mapa,
     * y abre su popup -- mismo propósito que resaltarDesdeMapa() pero
     * en el sentido contrario, para ubicar un cliente "raro" de la
     * lista en el mapa (pedido explícito: detectar mal posicionados). */
    resaltarDesdeLista(cliente) {
        this.state.clienteResaltadoId = cliente.ordenId;
        this._marcarPinResaltado(cliente.ordenId);
        const entry = this._markersPorCliente[cliente.ordenId];
        if (!entry || !this.mapboxMap) {
            return;
        }
        this.mapboxMap.flyTo({
            center: entry.marker.getLngLat(),
            zoom: Math.max(this.mapboxMap.getZoom(), 15),
        });
        if (!entry.marker.getPopup().isOpen()) {
            entry.marker.togglePopup();
        }
    }

    /** Clase .shalom-marker-numero-resaltado sobre el pin elegido (y
     * ninguno de los demás) -- a propósito NO usa `transform` (ver el
     * comentario grande de ruta_detalle.js sobre pines custom: Mapbox
     * ya escribe su propio transform de posición en este mismo
     * elemento en cada frame, así que uno propio en CSS se pisaría
     * solo). El resaltado es con box-shadow/borde nada más. */
    _marcarPinResaltado(ordenId) {
        Object.entries(this._markersPorCliente).forEach(([id, entry]) => {
            entry.pinEl.classList.toggle(
                "shalom-marker-numero-resaltado",
                String(id) === String(ordenId)
            );
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

    /** Botón "Archivar visita" (papelera) de una fila de "Rutas de mis
     * vendedores": archiva SOLO esta fsm.order puntual -- mismo botón
     * "Eliminar" que ya existe en la lista de "Visitas generadas" de
     * una fsm.route.schedule (action_shalom_archivar_visita), reusado
     * acá tal cual, sin duplicar el método. Caso típico: un cliente se
     * cambió a otra ruta y queda una visita colada en la ruta vieja --
     * esto la saca de la lista sin tocar al cliente ni a su Ubicación
     * (a diferencia de "Archivar cliente" de Seguimiento de Visitas). */
    async archivarVisita(ev, cliente) {
        ev.stopPropagation();
        // eslint-disable-next-line no-alert
        const acepta = window.confirm(
            `¿Sacar la visita de "${cliente.nombre}" de esta ruta? Se archiva ` +
            `(no se borra del todo) -- si te equivocaste, se puede recuperar ` +
            `buscándola con el filtro de archivados en fsm.order. No afecta a ` +
            `ninguna otra visita de esta ocurrencia.`
        );
        if (!acepta) {
            return;
        }
        try {
            await this.orm.call("fsm.order", "action_shalom_archivar_visita", [
                [cliente.ordenId],
            ]);
            this.notification.add(`Visita de "${cliente.nombre}" archivada.`, {
                type: "success",
            });
            await this.cargarClientesRuta();
        } catch (error) {
            this.notification.add("No se pudo archivar la visita.", {type: "danger"});
        }
    }

    // ==================================================================
    // Editar cliente (compartido por las dos secciones)
    // ==================================================================

    abrirEdicionCliente(locationId, ev) {
        // `ev` es opcional (solo lo pasa la fila de "Rutas de mis
        // vendedores", que ahora también reacciona al click con
        // resaltarDesdeLista() -- frena la propagación para no
        // disparar las dos cosas por el mismo toque en el botón).
        if (ev) {
            ev.stopPropagation();
        }
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
