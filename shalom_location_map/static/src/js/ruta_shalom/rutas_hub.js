/** @odoo-module **/

import {Component, onMounted, onWillStart, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {cargarMapboxGl, getMapboxToken} from "./mapbox_utils";
import {TemaSelector} from "./tema_selector";
import {Avisos} from "./avisos";
import {JuegoPanel} from "./juego_panel";
import {Tutorial} from "./tutorial";

/**
 * Pestaña "Rutas" de la app del vendedor: lista de fsm.route.schedule
 * (ocurrencias semanales) asignadas al usuario logueado, con búsqueda
 * por nombre de ruta y filtro de periodo (una semana puntual o "todo
 * el periodo" cargado). Usa fsm.person.shalom_mis_rutas_programadas,
 * el mismo método "mis datos" pensado en Fase 0 para esta pantalla.
 *
 * El filtro de periodo se arma solo con las semanas que efectivamente
 * tienen una fsm.route.schedule cargada por oficina en la ventana
 * consultada -- no se inventan semanas vacías.
 */

// Ventana de consulta: desde el lunes de esta semana, 8 semanas hacia
// adelante. Suficiente para que el vendedor vea el mes en curso y el
// siguiente sin pedirle a oficina que programe con más anticipación.
const SEMANAS_VENTANA = 8;

const ESTADO_RUTA_ETIQUETA = {
    por_iniciar: "Por iniciar",
    en_curso: "En curso",
    completada: "Completada",
};
const ESTADO_RUTA_CLASE = {
    por_iniciar: "cancelado",
    en_curso: "pendiente",
    completada: "completado",
};

// Color del pin de cada ruta en el mapa, por estado del ciclo (mismos
// tonos que los pines de clientes de RutaDetalle).
const COLOR_RUTA = {
    por_iniciar: "#c1791d",
    en_curso: "#b1245a",
    completada: "#2c7a56",
};

const CLAVE_VISTA_HUB = "shalom_hub_vista";

function leerVistaGuardada() {
    try {
        const v = localStorage.getItem(CLAVE_VISTA_HUB);
        return v === "lista" || v === "mapa" ? v : "mapa";
    } catch (error) {
        return "mapa";
    }
}

/** "$2.1k" / "$850" -- corto para caber dentro del pin. */
function dineroCorto(valor) {
    if (!valor) {
        return "";
    }
    return valor >= 1000 ? `$${(valor / 1000).toFixed(1)}k` : `$${Math.round(valor)}`;
}

function inicioSemana(fecha) {
    const d = new Date(fecha);
    const dia = (d.getDay() + 6) % 7; // lunes = 0
    d.setDate(d.getDate() - dia);
    d.setHours(0, 0, 0, 0);
    return d;
}

function aFechaStr(d) {
    return d.toISOString().slice(0, 10);
}

function formatoFechaCorta(d) {
    return d.toLocaleDateString("es-PA", {day: "numeric", month: "short"});
}

function formatoHorasImpl(horas) {
    if (!horas) {
        return "0h";
    }
    const h = Math.floor(horas);
    const m = Math.round((horas - h) * 60);
    return m ? `${h}h ${m}min` : `${h}h`;
}

export class RutasHub extends Component {
    static template = "shalom_location_map.RutasHub";
    static components = {TemaSelector, Avisos, JuegoPanel, Tutorial};
    static props = {
        onAbrirRuta: Function,
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            cargando: true,
            schedules: [],
            busqueda: "",
            periodo: "todos",
            menuPeriodoAbierto: false,
            // Botón flotante "Estrategias" (qué empujar / no ofrezcas),
            // editables por el dueño desde Administración.
            estrategias: {empujar: [], no_ofrecer: []},
            estrategiasAbiertas: false,
            // XP / nivel del vendedor (juego) -- null si no hay datos.
            progreso: null,
            // Fase 6A: panel de juego (Logros / Equipo / Temporada) y
            // tutorial de bienvenida (una vez por usuario, o repaso).
            juegoAbierto: false,
            tutorialAbierto: false,
            tutorialRepaso: false,
            tutorialNombre: "",
            logrosNuevosHoy: 0,
            // Mapa de rutas (Fase 5): la pestaña abre en el mapa para
            // elegir ruta; "lista" es la vista de siempre. Se recuerda la
            // última elegida por dispositivo.
            vista: leerVistaGuardada(),
            // Avisos a 3 días por WhatsApp (Fase 6B): null = sin datos
            // (el botón no sale); si no, cuántos faltan por avisar.
            avisosPendientes: null,
            avisosAbiertos: false,
        });
        this.mapaRef = useRef("mapaRutas");
        this.mapboxMap = null;
        this._mapaSeq = 0;
        // Se redibuja cuando cambia la vista, termina de cargar o cambia
        // el conjunto de rutas visibles (periodo / búsqueda).
        useEffect(
            () => {
                if (this.state.vista === "mapa" && !this.state.cargando && this.mapaRef.el) {
                    this.dibujarMapaRutas();
                } else {
                    this.quitarMapa();
                }
            },
            () => [this.state.vista, this.state.cargando, this.schedulesFiltrados.map((s) => s.id).join(",")]
        );
        onWillUnmount(() => this.quitarMapa());
        onWillStart(() => this.cargar());
        onMounted(() => {
            this.cargarEstrategias();
            this.cargarProgreso();
            this.cargarAvisos();
            this.cargarTutorial();
        });
    }

    async cargarAvisos() {
        try {
            const avisos = await this.orm.call("fsm.person", "shalom_avisos_proximos", []);
            this.state.avisosPendientes = avisos.filter((a) => !a.avisado).length;
        } catch (error) {
            // No es crítico: sin avisos el botón simplemente no sale.
            console.error("shalom: error al leer los avisos", error);
        }
    }

    abrirAvisos() {
        this.state.avisosAbiertos = true;
    }

    cerrarAvisos() {
        this.state.avisosAbiertos = false;
        this.cargarAvisos(); // el contador refleja lo que se acaba de avisar
    }

    async cargarProgreso() {
        try {
            // Recoge los logros pendientes (su XP suma al nivel) antes de
            // leer el progreso. Si falla, el progreso se lee igual.
            try {
                const logros = await this.orm.call("shalom.juego.evento", "shalom_mis_logros", []);
                this.state.logrosNuevosHoy = (logros && logros.nuevos_hoy) || 0;
            } catch (error) {
                console.error("shalom: error al leer los logros", error);
            }
            this.state.progreso = await this.orm.call("shalom.juego.evento", "shalom_mi_progreso", []);
        } catch (error) {
            console.error("shalom: error al leer el progreso", error);
        }
    }

    /** Tutorial de bienvenida: solo si el servidor dice que este usuario
     * todavía no lo vio. Si la consulta falla, Rutas sigue normal. */
    async cargarTutorial() {
        try {
            const estado = await this.orm.call("shalom.juego.evento", "shalom_tutorial_estado", []);
            this.state.tutorialNombre = (estado && estado.nombre) || "";
            if (estado && estado.mostrar) {
                this.state.tutorialAbierto = true;
                this.state.tutorialRepaso = false;
            }
        } catch (error) {
            console.error("shalom: error al leer el estado del tutorial", error);
        }
    }

    abrirJuego() {
        this.state.juegoAbierto = true;
    }

    cerrarJuego() {
        this.state.juegoAbierto = false;
        this.cargarProgreso(); // el panel pudo recoger logros nuevos
    }

    repasarTutorial() {
        this.state.juegoAbierto = false;
        this.state.tutorialRepaso = true;
        this.state.tutorialAbierto = true;
    }

    cerrarTutorial() {
        this.state.tutorialAbierto = false;
        this.cargarProgreso();
    }

    irAlMapaDesdeTutorial() {
        this.cambiarVista("mapa");
        this.cerrarTutorial();
    }

    get progresoVista() {
        const p = this.state.progreso;
        if (!p) {
            return null;
        }
        const tramo = p.xp_siguiente ? p.xp_siguiente - p.xp_nivel : 0;
        return {...p, avance: tramo ? Math.min(100, ((p.xp_total - p.xp_nivel) / tramo) * 100) : 100};
    }

    async cargarEstrategias() {
        try {
            const resultado = await this.orm.call("shalom.estrategia", "shalom_estrategias_vigentes", []);
            this.state.estrategias = {empujar: resultado.empujar, no_ofrecer: resultado.no_ofrecer};
        } catch (error) {
            // No es crítico: sin estrategias el botón simplemente no sale.
            console.error("shalom: error al leer estrategias", error);
        }
    }

    cambiarVista(vista) {
        this.state.vista = vista;
        try {
            localStorage.setItem(CLAVE_VISTA_HUB, vista);
        } catch (error) {
            // sin localStorage: simplemente no se recuerda la elección
        }
    }

    quitarMapa() {
        this._mapaSeq += 1;
        if (this.mapboxMap) {
            this.mapboxMap.remove();
            this.mapboxMap = null;
        }
    }

    /** Rutas del filtro actual que se pueden ubicar en el mapa (tienen
     * al menos un cliente con GPS). */
    get rutasEnMapa() {
        return this.schedulesFiltrados.filter((s) => s.centro_lat && s.centro_lng);
    }

    get rutasSinGps() {
        return this.schedulesFiltrados.length - this.rutasEnMapa.length;
    }

    /** Un pin por ruta, en el centro de sus clientes con GPS: color por
     * estado y, adentro, lo que te toca vender ahí (valor esperado de tu
     * cartera). Tocar un pin muestra la ruta y "Abrir ruta". */
    async dibujarMapaRutas() {
        const seq = ++this._mapaSeq;
        try {
            const token = await getMapboxToken();
            if (!token) {
                throw new Error("sin token de Mapbox");
            }
            await cargarMapboxGl();
            if (seq !== this._mapaSeq || !this.mapaRef.el) {
                return; // cambió algo mientras cargaba
            }
            window.mapboxgl.accessToken = token;
            if (this.mapboxMap) {
                this.mapboxMap.remove();
            }
            const rutas = this.rutasEnMapa;
            this.mapboxMap = new window.mapboxgl.Map({
                container: this.mapaRef.el,
                style: "mapbox://styles/mapbox/navigation-day-v1",
                center: rutas.length ? [rutas[0].centro_lng, rutas[0].centro_lat] : [-79.5199, 8.9824],
                zoom: 8,
            });
            const mapa = this.mapboxMap;
            mapa.on("load", () => {
                const bounds = new window.mapboxgl.LngLatBounds();
                for (const s of rutas) {
                    // Círculo cuadrado, anchor "center", sin filter/rotate: la
                    // única forma de pin estable al hacer zoom (ver el
                    // comentario de .shalom-marker-numero en el SCSS).
                    const pinEl = document.createElement("div");
                    pinEl.className = "shalom-ruta-pin";
                    pinEl.style.setProperty("--pin-color", COLOR_RUTA[s.estado] || COLOR_RUTA.por_iniciar);
                    const texto = document.createElement("span");
                    texto.className = "shalom-ruta-pin-txt";
                    texto.textContent = dineroCorto(s.esperado_mio) || String(s.cantidad_clientes);
                    pinEl.appendChild(texto);

                    const popupEl = document.createElement("div");
                    popupEl.className = "shalom-map-popup";
                    const nombreEl = document.createElement("div");
                    nombreEl.className = "shalom-map-popup-name";
                    nombreEl.textContent = s.route_name;
                    popupEl.appendChild(nombreEl);
                    const detalleEl = document.createElement("div");
                    detalleEl.className = "shalom-map-popup-detalle";
                    detalleEl.textContent =
                        `${s.pendientes_mios} por visitar` +
                        (s.esperado_mio ? ` · ~$${Math.round(s.esperado_mio).toLocaleString("en-US")} esperados` : "") +
                        ` · ${this.etiquetaRangoSchedule(s)}`;
                    popupEl.appendChild(detalleEl);
                    const botonEl = document.createElement("button");
                    botonEl.type = "button";
                    botonEl.className = "shalom-map-popup-btn shalom-map-popup-btn-nav";
                    botonEl.textContent = "Abrir ruta";
                    botonEl.addEventListener("click", () => this.abrir(s));
                    popupEl.appendChild(botonEl);

                    new window.mapboxgl.Marker({element: pinEl, anchor: "center"})
                        .setLngLat([s.centro_lng, s.centro_lat])
                        .setPopup(new window.mapboxgl.Popup({offset: 26}).setDOMContent(popupEl))
                        .addTo(mapa);
                    bounds.extend([s.centro_lng, s.centro_lat]);
                }
                if (rutas.length > 1) {
                    mapa.fitBounds(bounds, {padding: 60, maxZoom: 11});
                } else if (rutas.length === 1) {
                    mapa.setCenter([rutas[0].centro_lng, rutas[0].centro_lat]);
                    mapa.setZoom(11);
                }
            });
        } catch (error) {
            // Sin mapa (token, red) la lista sigue ahí: se vuelve a ella sola.
            console.error("shalom: error al dibujar el mapa de rutas", error);
            this.state.vista = "lista";
            this.notification.add("No se pudo cargar el mapa. Te muestro la lista.", {type: "warning"});
        }
    }

    get totalEstrategias() {
        return this.state.estrategias.empujar.length + this.state.estrategias.no_ofrecer.length;
    }

    toggleEstrategias() {
        this.state.estrategiasAbiertas = !this.state.estrategiasAbiertas;
    }

    async cargar() {
        this.state.cargando = true;
        const hoy = new Date();
        const desde = inicioSemana(hoy);
        const hasta = new Date(desde);
        hasta.setDate(hasta.getDate() + 7 * SEMANAS_VENTANA - 1);

        try {
            const resultado = await this.orm.call(
                "fsm.person",
                "shalom_mis_rutas_programadas",
                [aFechaStr(desde), aFechaStr(hasta)]
            );
            this.state.schedules = resultado;

            // Por defecto, la semana calendario de HOY -- si no hay
            // ninguna ruta cuya semana de arranque sea esta, se cae a
            // "todo el periodo" (mismo criterio que antes, adaptado a
            // que "periodo" ahora es la clave de un bucket de semana,
            // no el date_start de una ocurrencia puntual -- ver
            // semanas()/schedulesFiltrados()).
            const semanaDeHoy = aFechaStr(desde);
            const hayRutasEstaSemana = resultado.some(
                (s) => aFechaStr(inicioSemana(s.date_start + "T00:00:00")) === semanaDeHoy
            );
            this.state.periodo = hayRutasEstaSemana ? semanaDeHoy : "todos";
        } catch (error) {
            this.notification.add(
                "No se pudieron cargar tus rutas. Revisá tu conexión e intentá de nuevo.",
                {type: "danger"}
            );
        } finally {
            this.state.cargando = false;
        }
    }

    /** Agrupa las ocurrencias por SEMANA CALENDARIO real (lunes a
     * domingo, ver inicioSemana()) en la que arranca cada una -- antes
     * agrupaba por el date_start literal de cada ocurrencia, así que
     * un vendedor con 11 rutas con fechas de inicio escalonadas (una
     * empieza el 1, otra el 3, otra el 7...) veía 11 "semanas"
     * distintas en el filtro, una por ruta, en vez de agrupadas por
     * semana real -- pedido explícito: "que aparezcan todas las rutas
     * de mi semana juntas". Cada bucket trae "cantidad" (cuántas rutas
     * caen en esa semana) para mostrarlo en el filtro. */
    get semanas() {
        const vistas = new Map();
        for (const s of this.state.schedules) {
            const inicio = aFechaStr(inicioSemana(s.date_start + "T00:00:00"));
            if (!vistas.has(inicio)) {
                const fin = new Date(inicio + "T00:00:00");
                fin.setDate(fin.getDate() + 6);
                vistas.set(inicio, {date_start: inicio, date_end: aFechaStr(fin), cantidad: 0});
            }
            vistas.get(inicio).cantidad += 1;
        }
        return [...vistas.values()].sort((a, b) => (a.date_start < b.date_start ? -1 : 1));
    }

    get schedulesFiltrados() {
        const q = this.state.busqueda.trim().toLowerCase();
        const filtradas = this.state.schedules.filter((s) => {
            if (this.state.periodo !== "todos") {
                const semanaDeEsta = aFechaStr(inicioSemana(s.date_start + "T00:00:00"));
                if (semanaDeEsta !== this.state.periodo) {
                    return false;
                }
            }
            if (q && !s.route_name.toLowerCase().includes(q)) {
                return false;
            }
            return true;
        });
        // Visita Exprés SIEMPRE arriba de todo, sea cual sea la
        // semana filtrada -- pedido explícito: "que se sepa que es
        // una visita urgente" apenas se abre la pestaña, sin tener
        // que buscarla entre las demás.
        return [...filtradas].sort(
            (a, b) => (b.es_visita_express ? 1 : 0) - (a.es_visita_express ? 1 : 0)
        );
    }

    /** Etiqueta del filtro de período (menú desplegable) -- une la
     * semana calendario con cuántas rutas tiene, para elegir sin tener
     * que abrir cada una ("Semana del 1 al 7 sep · 3 rutas"). */
    etiquetaPeriodo(dateStart) {
        if (dateStart === "todos") {
            return "Todo el periodo";
        }
        const semana = this.semanas.find((s) => s.date_start === dateStart);
        if (!semana) {
            return "";
        }
        const inicio = formatoFechaCorta(new Date(semana.date_start + "T00:00:00"));
        const fin = formatoFechaCorta(new Date(semana.date_end + "T00:00:00"));
        const rutas = semana.cantidad === 1 ? "1 ruta" : `${semana.cantidad} rutas`;
        return `Semana del ${inicio} al ${fin} · ${rutas}`;
    }

    /** Rango de fechas de ESTA ocurrencia puntual, para la tarjeta de
     * cada ruta -- a diferencia de etiquetaPeriodo() (que describe la
     * semana calendario del filtro), acá se muestran las fechas reales
     * de la ocurrencia tal cual las cargó oficina, aunque no coincidan
     * exactamente con el lunes/domingo de su semana. */
    etiquetaRangoSchedule(schedule) {
        const inicio = formatoFechaCorta(new Date(schedule.date_start + "T00:00:00"));
        const fin = formatoFechaCorta(new Date(schedule.date_end + "T00:00:00"));
        return `${inicio} al ${fin}`;
    }

    formatoHoras(horas) {
        return formatoHorasImpl(horas);
    }

    claseEstado(estado) {
        return ESTADO_RUTA_CLASE[estado] || "cancelado";
    }

    etiquetaEstado(estado) {
        return ESTADO_RUTA_ETIQUETA[estado] || estado;
    }

    toggleMenuPeriodo() {
        this.state.menuPeriodoAbierto = !this.state.menuPeriodoAbierto;
    }

    elegirPeriodo(dateStart) {
        this.state.periodo = dateStart;
        this.state.menuPeriodoAbierto = false;
    }

    abrir(schedule) {
        this.props.onAbrirRuta(schedule);
    }
}
