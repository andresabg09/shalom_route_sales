/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {registry} from "@web/core/registry";
import {useService} from "@web/core/utils/hooks";
import {DateTimeInput} from "@web/core/datetime/datetime_input";
import {ClienteForm} from "./cliente_form";
import {OrderScreen} from "./order_screen";
import {ESTADO_ETIQUETA, estadoDesdeStageName} from "./stage_utils";
import {getMapboxToken, cargarMapboxGl} from "./mapbox_utils";

const {DateTime} = luxon;

// Cada cuánto se refresca la lista de "Visitas en vivo" (quién tiene
// el catálogo abierto ahora mismo) -- más espaciado que el heartbeat
// de visit_sheet.js porque acá es una lista completa, no una sola
// visita.
const SHALOM_INTERVALO_LISTA_EN_VIVO_MS = 3000;

/** Clave de localStorage para los clientes "por confirmar" de la
 * Visita Exprés de UN vendedor (elegidos con el buscador pero
 * TODAVÍA sin tocar la base) -- pedido explícito: si Administración
 * sale de la pantalla por accidente (o se olvida de tocar "Confirmar
 * Visita Exprés"), la lista que ya armó no se puede perder sin aviso;
 * puede tener 20 clientes cargados. Se guarda en cada cambio y se
 * restaura sola al reabrir Visita Exprés de ese mismo vendedor; se
 * borra recién cuando se confirma con éxito. */
function claveVisitaExpressPendientes(vendedorId) {
    return `shalom_visita_express_pendientes_${vendedorId}`;
}

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

const ESTADOS_SEGUIMIENTO_DEFAULT = ["cancelado", "no_quiso", "no_atendido"];

// Extensión LOCAL de ESTADO_ETIQUETA (stage_utils.js) solo para esta
// pantalla ("Seguimiento de Visitas") -- "No atendido" NO se agrega
// al diccionario compartido a propósito, para no cambiar cómo se ve
// en ningún otro lado de la app (ej. las tarjetas de "Rutas de mis
// vendedores" más abajo en este mismo archivo, o la app del
// vendedor), donde una visita "No atendido" sigue etiquetándose como
// "Pendiente" tal cual estaba.
const ESTADO_ETIQUETA_SEGUIMIENTO = {...ESTADO_ETIQUETA, no_atendido: "No atendido"};

/** Igual que estadoDesdeStageName (stage_utils.js), pero reconociendo
 * también "No atendido" -- usado tanto por "Seguimiento de Visitas"
 * (cargarVisitas) como por "Rutas de mis vendedores" (cargarClientesRuta,
 * para el color del pin en el mapa -- pedido explícito: un ciclo viejo
 * que quedó con visitas colgadas, marcadas "No atendido" por el cron
 * de reposición automática, se sigue mostrando en esta pantalla junto
 * con el ciclo nuevo, ver shalom_admin_rutas_programadas). Antes solo
 * se usaba para Seguimiento -- clientesRuta se quedaba con
 * estadoDesdeStageName y "No atendido" se veía igual que "Pendiente"
 * en el mapa. */
function estadoSeguimientoDesdeStageName(stageName) {
    if (stageName === "No atendido") {
        return "no_atendido";
    }
    return estadoDesdeStageName(stageName);
}

/** Color del pin en el mapa de "Rutas de mis vendedores", uno por
 * estado -- mismos colores que ya usan las tarjetas de "Seguimiento de
 * Visitas" (.stop-badge en ruta_shalom.scss), para que el significado
 * de cada color sea el mismo en toda la app. Ver también
 * .admin-mapa-leyenda en admin_gestion.xml. */
const COLOR_PIN_POR_ESTADO = {
    completado: "var(--shalom-completado)",
    pendiente: "var(--shalom-pendiente)",
    no_quiso: "var(--shalom-no_quiso)",
    no_atendido: "var(--shalom-no_atendido)",
    cancelado: "var(--shalom-cancelado)",
};

export class AdminGestion extends Component {
    static template = "shalom_location_map.AdminGestion";
    static components = {ClienteForm, OrderScreen, DateTimeInput};
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

            // -- Visita Exprés: DENTRO del vendedor elegido arriba (es
            // la Visita Exprés de ESE vendedor, una por cada uno -- ver
            // docstring grande de la sección más abajo) --
            visitaExpressAbierta: false,
            visitaExpressCargando: false,
            visitaExpressScheduleId: null,
            visitaExpressFechaInicio: null, // luxon DateTime -- SIEMPRE editable
            visitaExpressFechaFin: null, // luxon DateTime -- SIEMPRE editable
            visitaExpressClientes: [], // ya confirmados (fsm.order reales)
            visitaExpressPendientes: [], // elegidos, TODAVÍA sin confirmar
            visitaExpressConfirmando: false,
            visitaExpressBuscadorAbierto: false,
            visitaExpressBusqueda: "",
            visitaExpressBuscando: false,
            visitaExpressResultados: [],

            // -- En vivo --
            cargandoEnVivo: true,
            visitasEnVivo: [],
            orderIdEnVivo: null,
            clienteEnVivoNombre: "",
            // -- Carritos pendientes (mismo catálogo, sin nadie tocándolo
            // ahora mismo -- ver shalom_admin_carritos_pendientes) --
            cargandoCarritosPendientes: true,
            carritosPendientes: [],

            // -- compartido --
            locationIdEditando: null,
        });
        this._enVivoTimer = null;

        onWillStart(async () => {
            await Promise.all([
                this.cargarVisitas(),
                this.cargarVendedores(),
                this.cargarVisitasEnVivo(),
                this.cargarCarritosPendientes(),
            ]);
        });
        this._enVivoTimer = setInterval(() => {
            this.cargarVisitasEnVivo();
            this.cargarCarritosPendientes();
        }, SHALOM_INTERVALO_LISTA_EN_VIVO_MS);
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
        return ["cancelado", "no_quiso", "no_atendido", "completado", "pendiente"];
    }

    etiquetaEstado(estado) {
        return ESTADO_ETIQUETA_SEGUIMIENTO[estado] || estado;
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
                estado: estadoSeguimientoDesdeStageName(v.estado_nombre),
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
        this.cargarCarritosPendientes();
    }

    /** Carritos con productos cargados pero sin nadie tocándolos ahora
     * mismo (pedido explícito: verlos también acá, no solo cuando el
     * vendedor reabre esa visita) -- se abren con el mismo modal/
     * componente que "en vivo" (abrirEnVivo), es el mismo catálogo. */
    async cargarCarritosPendientes() {
        if (!this.state.carritosPendientes.length) {
            this.state.cargandoCarritosPendientes = true;
        }
        try {
            this.state.carritosPendientes = await this.orm.call(
                "fsm.order", "shalom_admin_carritos_pendientes", []
            );
        } catch (error) {
            console.error("shalom: error al cargar carritos pendientes", error);
        } finally {
            this.state.cargandoCarritosPendientes = false;
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
        // Visita Exprés es DE un vendedor específico -- si se cambia
        // de vendedor arriba, se cierra el panel (y se descarta
        // cualquier cliente elegido sin confirmar) para no quedar
        // mirando/editando por error la Visita Exprés de otro
        // vendedor.
        this.cerrarVisitaExpress();
    }

    async elegirRuta(ruta) {
        this.state.scheduleSeleccionadoId = ruta.id;
        this.state.busquedaClienteRuta = "";
        this.state.clienteResaltadoId = null;
        await this.cargarClientesRuta();
        // El dibujo del mapa lo dispara el useEffect de setup() cuando
        // Owl termina de pintar el DOM -- ver el comentario grande ahí.
    }

    /** Leyenda de colores del mapa (ver COLOR_PIN_POR_ESTADO) -- orden
     * fijo, no el de aparición en clientesRuta, para que no salte de
     * lugar entre una ruta y otra. */
    get leyendaEstadosMapa() {
        return ["completado", "pendiente", "no_quiso", "no_atendido", "cancelado"].map((estado) => ({
            estado,
            etiqueta: ESTADO_ETIQUETA_SEGUIMIENTO[estado] || estado,
            color: COLOR_PIN_POR_ESTADO[estado],
        }));
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
                // x_venta_mas_alta: mismo campo ya calculado en
                // fsm.location (ver ruta_detalle.js/"meta-venta" en la
                // app del vendedor) -- se reusa tal cual acá, no se
                // recalcula de nuevo.
                const locaciones = await this.orm.read("fsm.location", locationIds, [
                    "name",
                    "x_venta_mas_alta",
                ]);
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
                    estado: estadoSeguimientoDesdeStageName(o.stage_name),
                    ventaMasAlta: loc ? loc.x_venta_mas_alta : 0,
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
                // Pedido explícito: un color por estado (ver
                // COLOR_PIN_POR_ESTADO), no solo "cancelado vs. el
                // resto" como antes -- así se ve de un vistazo quién
                // fue atendido y quién no en el mapa de cada ruta.
                pinEl.style.setProperty(
                    "--pin-color",
                    COLOR_PIN_POR_ESTADO[c.estado] || "var(--shalom-accent)"
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
     * popup del pin (Editar/GPS) ya lo abre Mapbox solo.
     *
     * block: "start" (no "nearest") a propósito -- pedido explícito:
     * en celular, la lista y el mapa están apilados (una sola columna
     * angosta, ver @media (min-width: 900px) más arriba) y se ve muy
     * poco de la lista a la vez. Con "nearest" la fila resaltada podía
     * quedar centrada o parcialmente tapada, obligando a scrollear más
     * para encontrarla. Con "start" queda pegada arriba de todo,
     * justo debajo del buscador, visible de una sin explorar. En
     * desktop (lista completa siempre visible al lado del mapa) este
     * mismo comportamiento no tiene contra: la fila igual queda a la
     * vista, solo que arriba en vez de en el medio. */
    resaltarDesdeMapa(ordenId) {
        this.state.clienteResaltadoId = ordenId;
        this._marcarPinResaltado(ordenId);
        const fila = document.querySelector(`[data-orden-id="${ordenId}"]`);
        if (fila) {
            fila.scrollIntoView({block: "start", behavior: "smooth"});
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
    // Visita Exprés: atención de un cliente FUERA de su ciclo normal,
    // a demanda ("el cliente llamó pidiendo que lo visiten mañana").
    // Vive DENTRO del vendedor elegido arriba (state.vendedorSeleccionadoId)
    // -- es la Visita Exprés de ESE vendedor específico; puede haber
    // varias al mismo tiempo, una por cada vendedor que la use, sin
    // pisarse (ver fsm_route.py). Aparece/desaparece sola en la app
    // del vendedor: eso es 100% del lado del backend
    // (fsm.route.schedule.estado), acá solo mostramos/ocultamos el
    // panel según lo que devuelva shalom_visita_express_info().
    //
    // Flujo de dos pasos, pedido explícito: elegir clientes con el
    // buscador solo los junta en visitaExpressPendientes (frontend,
    // no toca nada todavía) -- recién "Confirmar Visita Exprés"
    // (confirmarLoteVisitaExpress) manda TODOS juntos al backend, que
    // ahí sí archiva sus visitas viejas y crea las nuevas de una.
    // ==================================================================

    /** Botón "Visita Exprés" (dentro del vendedor elegido arriba):
     * trae el estado actual (ocurrencia abierta con sus clientes ya
     * confirmados, si hay) en una sola llamada. Un segundo click sobre
     * la pastilla cierra el panel (mismo gesto que cualquier otra
     * pastilla de ruta). */
    async abrirVisitaExpress() {
        if (this.state.visitaExpressAbierta) {
            this.cerrarVisitaExpress();
            return;
        }
        if (!this.state.vendedorSeleccionadoId) {
            this.notification.add("Elegí un vendedor arriba antes de abrir Visita Exprés.", {
                type: "warning",
            });
            return;
        }
        this.state.visitaExpressCargando = true;
        try {
            const datos = await this.orm.call(
                "fsm.route", "shalom_visita_express_info", [this.state.vendedorSeleccionadoId]
            );
            this._aplicarDatosVisitaExpress(datos);
            this._restaurarPendientesVisitaExpress();
        } catch (error) {
            this.notification.add("No se pudo abrir Visita Exprés.", {type: "danger"});
        } finally {
            this.state.visitaExpressCargando = false;
        }
    }

    cerrarVisitaExpress() {
        this.state.visitaExpressAbierta = false;
        this.state.visitaExpressPendientes = [];
        this.state.visitaExpressBuscadorAbierto = false;
        this.state.visitaExpressBusqueda = "";
        this.state.visitaExpressResultados = [];
    }

    _aplicarDatosVisitaExpress(datos) {
        this.state.visitaExpressAbierta = true;
        this.state.visitaExpressScheduleId = datos.schedule_id || null;
        // Fecha por defecto = hoy (para las dos) si todavía no hay
        // ocurrencia -- así no hace falta tocar nada si el lote es
        // para hoy mismo. Se pisan enseguida si había una fecha
        // guardada en el "por confirmar" recuperado (ver más abajo).
        this.state.visitaExpressFechaInicio = datos.date_start
            ? DateTime.fromISO(datos.date_start)
            : DateTime.local().startOf("day");
        this.state.visitaExpressFechaFin = datos.date_end
            ? DateTime.fromISO(datos.date_end)
            : DateTime.local().startOf("day");
        this.state.visitaExpressClientes = datos.clientes || [];
    }

    /** Fecha de Inicio/Fin del calendario (widget nativo de Odoo, mismo
     * que ya se usa para programar una ruta) -- SIEMPRE editable,
     * tenga o no ya una ocurrencia creada (pedido explícito). Si la
     * ocurrencia ya existe, el cambio se guarda solo, de una, contra
     * el servidor (shalom_actualizar_fechas_visita_express); si
     * todavía no existe, solo queda en memoria/localStorage hasta que
     * se confirme el primer cliente. */
    async onCambiarFechaInicioVisitaExpress(valor) {
        this.state.visitaExpressFechaInicio = valor;
        this._guardarPendientesVisitaExpress();
        await this._guardarFechasSiYaExisteOcurrencia();
    }

    async onCambiarFechaFinVisitaExpress(valor) {
        this.state.visitaExpressFechaFin = valor;
        this._guardarPendientesVisitaExpress();
        await this._guardarFechasSiYaExisteOcurrencia();
    }

    async _guardarFechasSiYaExisteOcurrencia() {
        if (!this.state.visitaExpressScheduleId) {
            return;
        }
        try {
            await this.orm.call("fsm.route", "shalom_actualizar_fechas_visita_express", [
                this.state.visitaExpressScheduleId,
                this.state.visitaExpressFechaInicio.toISODate(),
                this.state.visitaExpressFechaFin.toISODate(),
            ]);
        } catch (error) {
            this.notification.add("No se pudieron guardar las fechas.", {type: "danger"});
        }
    }

    // -- Memoria de "por confirmar" (ver claveVisitaExpressPendientes
    // más arriba): guarda/restaura/borra en localStorage la lista de
    // clientes elegidos con el buscador y todavía sin confirmar (más
    // las fechas elegidas), por vendedor -- pedido explícito, para no
    // perderla si Administración sale de la pantalla sin tocar
    // "Confirmar Visita Exprés". --

    _guardarPendientesVisitaExpress() {
        if (!this.state.vendedorSeleccionadoId) {
            return;
        }
        try {
            localStorage.setItem(
                claveVisitaExpressPendientes(this.state.vendedorSeleccionadoId),
                JSON.stringify({
                    pendientes: this.state.visitaExpressPendientes,
                    fechaInicio: this.state.visitaExpressFechaInicio
                        ? this.state.visitaExpressFechaInicio.toISODate()
                        : null,
                    fechaFin: this.state.visitaExpressFechaFin
                        ? this.state.visitaExpressFechaFin.toISODate()
                        : null,
                })
            );
        } catch (error) {
            // localStorage puede fallar (modo privado del navegador,
            // cuota llena, etc.) -- no es crítico para seguir armando
            // el lote en memoria, solo se pierde la posibilidad de
            // recuperarlo si la pantalla se cierra por accidente.
        }
    }

    _borrarPendientesVisitaExpress(vendedorId) {
        try {
            localStorage.removeItem(claveVisitaExpressPendientes(vendedorId));
        } catch (error) {
            // ver _guardarPendientesVisitaExpress()
        }
    }

    /** Llamado al abrir Visita Exprés de un vendedor: si había clientes
     * "por confirmar" guardados de una sesión anterior (se salió sin
     * confirmar), los recupera solos, sin preguntar -- mismo criterio
     * que el borrador de carrito del vendedor (ver order_screen.js). */
    _restaurarPendientesVisitaExpress() {
        let crudo;
        try {
            crudo = localStorage.getItem(
                claveVisitaExpressPendientes(this.state.vendedorSeleccionadoId)
            );
        } catch (error) {
            return;
        }
        if (!crudo) {
            return;
        }
        let borrador;
        try {
            borrador = JSON.parse(crudo);
        } catch (error) {
            this._borrarPendientesVisitaExpress(this.state.vendedorSeleccionadoId);
            return;
        }
        if (!borrador.pendientes || !borrador.pendientes.length) {
            this._borrarPendientesVisitaExpress(this.state.vendedorSeleccionadoId);
            return;
        }
        this.state.visitaExpressPendientes = borrador.pendientes;
        if (borrador.fechaInicio) {
            this.state.visitaExpressFechaInicio = DateTime.fromISO(borrador.fechaInicio);
        }
        if (borrador.fechaFin) {
            this.state.visitaExpressFechaFin = DateTime.fromISO(borrador.fechaFin);
        }
        this.notification.add(
            `Se recuperaron ${borrador.pendientes.length} cliente(s) que habías elegido sin ` +
            `confirmar.`,
            {type: "info"}
        );
    }

    async cargarVisitaExpressClientes() {
        if (!this.state.visitaExpressScheduleId) {
            return;
        }
        this.state.visitaExpressClientes = await this.orm.call(
            "fsm.route", "shalom_visita_express_clientes", [this.state.visitaExpressScheduleId]
        );
    }

    /** Botón "Archivar visita" de una fila YA CONFIRMADA de Visita
     * Exprés -- mismo método nativo que el de "Rutas de mis
     * vendedores" (ver archivarVisita más arriba), solo que acá
     * refresca la lista de Visita Exprés en vez de la de la ruta
     * normal. */
    async archivarVisitaExpress(ev, cliente) {
        ev.stopPropagation();
        // eslint-disable-next-line no-alert
        const acepta = window.confirm(
            `¿Sacar a "${cliente.cliente_nombre}" de Visita Exprés? Se archiva ` +
            `(no se borra del todo) -- si te equivocaste, se puede recuperar ` +
            `buscándola con el filtro de archivados en fsm.order.`
        );
        if (!acepta) {
            return;
        }
        try {
            await this.orm.call("fsm.order", "action_shalom_archivar_visita", [
                [cliente.order_id],
            ]);
            this.notification.add(`"${cliente.cliente_nombre}" sacado de Visita Exprés.`, {
                type: "success",
            });
            await this.cargarVisitaExpressClientes();
        } catch (error) {
            this.notification.add("No se pudo archivar la visita.", {type: "danger"});
        }
    }

    /** Botón "+": abre el buscador chico -- se queda abierto entre un
     * agregado y el siguiente (pedido explícito: elegir varios
     * clientes seguidos sin tener que reabrir nada cada vez). */
    abrirBuscadorVisitaExpress() {
        this.state.visitaExpressBuscadorAbierto = true;
        this.state.visitaExpressBusqueda = "";
        this.state.visitaExpressResultados = [];
    }

    cerrarBuscadorVisitaExpress() {
        this.state.visitaExpressBuscadorAbierto = false;
    }

    /** Busca fsm.location por nombre en TODA la base (no acotado a una
     * ruta -- el cliente puede venir de cualquiera), excluyendo a los
     * que ya están en Visita Exprés (confirmados O todavía pendientes
     * de confirmar) para no ofrecer agregarlos dos veces por error.
     * Trae ruta/vendedor/dirección de cada resultado
     * (shalom_buscar_clientes_admin, en fsm_location.py) -- pedido
     * explícito: hay clientes con el mismo nombre en zonas distintas,
     * y sin esa info no se podía saber cuál era el correcto antes de
     * elegirlo. */
    async buscarClienteVisitaExpress(ev) {
        const texto = ev.target.value;
        this.state.visitaExpressBusqueda = texto;
        const textoLimpio = texto.trim();
        if (!textoLimpio) {
            this.state.visitaExpressResultados = [];
            return;
        }
        this.state.visitaExpressBuscando = true;
        try {
            const yaAgregados = [
                ...this.state.visitaExpressClientes.map((c) => c.location_id),
                ...this.state.visitaExpressPendientes.map((c) => c.id),
            ];
            this.state.visitaExpressResultados = await this.orm.call(
                "fsm.location", "shalom_buscar_clientes_admin", [textoLimpio, yaAgregados]
            );
        } catch (error) {
            this.notification.add("No se pudo buscar clientes.", {type: "danger"});
        } finally {
            this.state.visitaExpressBuscando = false;
        }
    }

    /** Tocar un resultado del buscador: lo pasa a la lista "por
     * confirmar" -- TODAVÍA no toca nada en el servidor, ver docstring
     * grande de la sección. El buscador se queda abierto para seguir
     * eligiendo el siguiente ("tin, tin, tin"). */
    elegirClienteVisitaExpress(resultado) {
        this.state.visitaExpressPendientes.push(resultado);
        this.state.visitaExpressResultados = this.state.visitaExpressResultados.filter(
            (r) => r.id !== resultado.id
        );
        this._guardarPendientesVisitaExpress();
    }

    /** Saca a un cliente de la lista "por confirmar" antes de tocar
     * "Confirmar Visita Exprés" -- como todavía no se creó nada en el
     * servidor, esto es solo sacarlo del array del frontend (y del
     * localStorage). */
    quitarPendienteVisitaExpress(resultado) {
        this.state.visitaExpressPendientes = this.state.visitaExpressPendientes.filter(
            (r) => r.id !== resultado.id
        );
        this._guardarPendientesVisitaExpress();
    }

    /** Botón de flecha (chevron) junto a la ruta/vendedor/dirección de
     * un resultado del buscador o de un "por confirmar": pedido
     * explícito -- ese texto viene truncado por defecto (con "…") para
     * no ocupar tanto espacio al escrolear, sobre todo en celular/
     * tablet; un toque lo expande a texto completo, otro toque lo
     * vuelve a truncar. stopPropagation() porque la fila entera
     * también reacciona al click (agregar/nada) -- este toque es
     * solo para expandir, no debe disparar eso. */
    toggleExpandido(item, ev) {
        ev.stopPropagation();
        item.expandido = !item.expandido;
    }

    /** Botón "Confirmar Visita Exprés": el único punto donde esto
     * toca la base -- manda TODOS los clientes elegidos de una, el
     * backend (shalom_confirmar_lote_visita_express) archiva sus
     * visitas viejas y crea las nuevas para todos juntos. */
    async confirmarLoteVisitaExpress() {
        if (!this.state.visitaExpressPendientes.length) {
            return;
        }
        if (!this.state.visitaExpressFechaInicio || !this.state.visitaExpressFechaFin) {
            this.notification.add(
                "Elegí la fecha de inicio y de fin en que se debe visitar a estos clientes.",
                {type: "warning"}
            );
            return;
        }
        this.state.visitaExpressConfirmando = true;
        try {
            const datos = await this.orm.call("fsm.route", "shalom_confirmar_lote_visita_express", [
                this.state.vendedorSeleccionadoId,
                this.state.visitaExpressFechaInicio.toISODate(),
                this.state.visitaExpressFechaFin.toISODate(),
                this.state.visitaExpressPendientes.map((c) => c.id),
            ]);
            this.notification.add(
                `Visita Exprés confirmada: ${this.state.visitaExpressPendientes.length} ` +
                `cliente(s) agregado(s).`,
                {type: "success"}
            );
            this._borrarPendientesVisitaExpress(this.state.vendedorSeleccionadoId);
            this.state.visitaExpressPendientes = [];
            this._aplicarDatosVisitaExpress(datos);
        } catch (error) {
            const mensajeServidor = error && error.data && error.data.message;
            this.notification.add(
                mensajeServidor || "No se pudo confirmar Visita Exprés.",
                {type: "danger"}
            );
        } finally {
            this.state.visitaExpressConfirmando = false;
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
