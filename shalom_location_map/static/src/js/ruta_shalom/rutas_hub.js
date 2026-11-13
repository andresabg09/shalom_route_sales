/** @odoo-module **/

import {Component, onMounted, onWillStart, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {cargarMapboxGl, getMapboxToken} from "./mapbox_utils";
import {TemaSelector} from "./tema_selector";
import {Avisos} from "./avisos";
import {JuegoPanel} from "./juego_panel";
import {Tutorial} from "./tutorial";
import {useEsAncha} from "./pantalla_utils";
import {estadoDeResultado, quienAtiende, resaltar} from "./busqueda_utils";

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
const TOMAS_REFRESCO_MS = 30000;
// Última lista de rutas vista (se conserva al entrar y salir de una ruta).
let CACHE_RUTAS = null;
const CACHE_RUTAS_MS = 10 * 60 * 1000;
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
        onIrAClientes: {type: Function, optional: true},
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            cargando: true,
            schedules: [],
            busqueda: "",
            // Búsqueda de clientes en todas las rutas (se dispara al escribir).
            clientesEncontrados: [],
            buscandoClientes: false,
            filtroBusqueda: "todos", // todos | clientes | rutas
            // Filtro permanente: las rutas donde ningún cliente ha comprado
            // quedan ocultas; este interruptor las muestra (solo consulta).
            verSinVentas: false,
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
        this.pantalla = useEsAncha();
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
            () => [
                this.state.vista,
                this.state.cargando,
                this.schedulesFiltrados.map((s) => s.id).join(","),
                this.firmaTomas,
            ]
        );
        // Al escribir en el buscador también se buscan CLIENTES de todas las
        // rutas (con una pausa corta para no consultar en cada letra).
        useEffect(
            () => {
                clearTimeout(this._busquedaTimer);
                const texto = this.state.busqueda.trim();
                if (texto.length < 2) {
                    this._busquedaSeq = (this._busquedaSeq || 0) + 1;
                    this.state.clientesEncontrados = [];
                    this.state.buscandoClientes = false;
                    return;
                }
                this.state.buscandoClientes = true;
                this._busquedaTimer = setTimeout(() => this.buscarClientes(texto), 250);
            },
            () => [this.state.busqueda]
        );
        onWillUnmount(() => {
            this.quitarMapa();
            clearInterval(this._tomasTimer);
            clearTimeout(this._busquedaTimer);
        });
        onWillStart(() => this.cargar());
        onMounted(() => {
            // Quién trabaja cada ruta cambia mientras estás en el mapa: se
            // refresca solo cada 30 s (y al volver a la pestaña).
            this._tomasTimer = setInterval(() => !document.hidden && this.refrescarTomas(), TOMAS_REFRESCO_MS);
            this.cargarEstrategias();
            this.cargarProgreso();
            this.cargarAvisos();
            this.cargarTutorial();
        });
    }

    async buscarClientes(texto) {
        const seq = (this._busquedaSeq = (this._busquedaSeq || 0) + 1);
        try {
            const res = await this.orm.call("fsm.person", "shalom_buscar", [texto]);
            if (seq === this._busquedaSeq) {
                this.state.clientesEncontrados = res;
            }
        } catch (error) {
            console.error("shalom: error al buscar clientes", error);
            if (seq === this._busquedaSeq) {
                this.state.clientesEncontrados = [];
            }
        } finally {
            if (seq === this._busquedaSeq) {
                this.state.buscandoClientes = false;
            }
        }
    }

    get textoBusqueda() {
        return this.state.busqueda.trim();
    }

    /** Hay una búsqueda en curso (2 letras o más). */
    get buscando() {
        return this.textoBusqueda.length >= 2;
    }

    get mostrarResultadosClientes() {
        return this.buscando && this.state.filtroBusqueda !== "rutas";
    }

    /** El mapa y las tarjetas de ruta se ocultan si la búsqueda es solo de clientes
     * o si ninguna ruta coincide. */
    get mostrarRutasEnBusqueda() {
        if (!this.buscando) {
            return true;
        }
        return this.state.filtroBusqueda !== "clientes" && this.schedulesFiltrados.length > 0;
    }

    get resumenBusqueda() {
        const c = this.state.clientesEncontrados.length;
        const r = this.schedulesFiltrados.length;
        const partesC = c ? `${c} cliente${c === 1 ? "" : "s"} encontrado${c === 1 ? "" : "s"}` : "ningún cliente";
        const partesR = r ? `${r} ruta${r === 1 ? "" : "s"}` : "ninguna ruta se llama así";
        return `${partesC} · ${partesR}`;
    }

    setFiltroBusqueda(filtro) {
        this.state.filtroBusqueda = filtro;
    }

    limpiarBusqueda() {
        this.state.busqueda = "";
        this.state.filtroBusqueda = "todos";
    }

    resaltarTexto(texto) {
        return resaltar(texto, this.textoBusqueda);
    }

    estadoResultado(r) {
        return estadoDeResultado(r);
    }

    quienAtiendeResultado(r) {
        return quienAtiende(r.tomada_por);
    }

    /** "Ir a la ruta": abre esa ruta directo en la visita del cliente elegido
     * (sin dejar el buscador escrito); si ahí no tiene visita, cae al texto. */
    irARutaDeResultado(r) {
        if (!r.schedule) {
            this.notification.add("Esa ruta no tiene un ciclo activo todavía.", {type: "warning"});
            return;
        }
        try {
            window.sessionStorage.setItem(
                "shalom_detalle_traspaso",
                JSON.stringify({texto: r.name || this.textoBusqueda, verSinVentas: true, locationId: r.location_id})
            );
        } catch (error) {
            // sin sessionStorage solo se pierde el texto ya escrito
        }
        this.props.onAbrirRuta(r.schedule);
    }

    llamarResultado(r) {
        if (!r.phone) {
            this.notification.add("Este cliente no tiene teléfono guardado.", {type: "warning"});
            return;
        }
        window.open(`tel:${r.phone}`, "_self");
    }

    buscarEnTodosLosClientes() {
        if (this.props.onIrAClientes) {
            this.props.onIrAClientes(this.textoBusqueda, null);
        }
    }

    crearClienteDesdeBusqueda() {
        if (this.props.onIrAClientes) {
            this.props.onIrAClientes(this.textoBusqueda, "alta");
        }
    }

    /** Vendedores que hoy tienen alguna ruta (para la leyenda del mapa). */
    get leyendaTomas() {
        const vistos = new Map();
        for (const s of this.state.schedules) {
            for (const t of s.tomada_por || []) {
                vistos.set(t.person_id, t);
            }
        }
        return [...vistos.values()];
    }

    /** Texto estable de quién tiene cada ruta: si cambia, el mapa se redibuja. */
    get firmaTomas() {
        return this.state.schedules
            .map((s) => (s.tomada_por || []).map((t) => t.person_id).join("+"))
            .join(",");
    }

    async refrescarTomas() {
        if (!this._ventana || this.state.cargando) {
            return;
        }
        try {
            const nuevas = await this.orm.call("fsm.person", "shalom_mis_rutas_programadas", this._ventana);
            const porId = new Map(nuevas.map((s) => [s.id, s]));
            for (const s of this.state.schedules) {
                const n = porId.get(s.id);
                if (n) {
                    s.tomada_por = n.tomada_por;
                }
            }
        } catch (error) {
            console.error("shalom: error al refrescar quién trabaja las rutas", error);
        }
    }

    /** "Luis", "Luis y Milciades" -- quién la está atendiendo (sin contarme a mí). */
    textoQuien(schedule) {
        const otros = (schedule.tomada_por || []).filter((t) => !t.es_yo).map((t) => t.nombre.split(" ")[0]);
        return otros.length ? otros.join(" y ") : "";
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
                    // Una letra de color por vendedor que ya la está atendiendo.
                    (s.tomada_por || []).forEach((t, i) => {
                        const quien = document.createElement("span");
                        quien.className = `shalom-ruta-pin-quien tc-${t.color}`;
                        quien.style.right = `${-6 + i * 14}px`;
                        quien.textContent = t.inicial;
                        pinEl.appendChild(quien);
                    });

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
                    const quienTxt = this.textoQuien(s);
                    if (quienTxt) {
                        const quienEl = document.createElement("div");
                        quienEl.className = "shalom-map-popup-detalle";
                        quienEl.textContent = `La está atendiendo ${quienTxt}`;
                        popupEl.appendChild(quienEl);
                    }
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

    async cargar(silencioso = false) {
        // Al volver de una ruta se muestra al instante lo último que se vio
        // y se refresca por detrás (antes se esperaba la consulta completa).
        if (!silencioso && CACHE_RUTAS && Date.now() - CACHE_RUTAS.ts < CACHE_RUTAS_MS) {
            this.state.schedules = CACHE_RUTAS.schedules;
            this._ventana = CACHE_RUTAS.ventana;
            this.state.cargando = false;
            this.cargar(true);
            return;
        }
        if (!silencioso) {
            this.state.cargando = true;
        }
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
            this._ventana = [aFechaStr(desde), aFechaStr(hasta)];
            CACHE_RUTAS = {ts: Date.now(), schedules: resultado, ventana: this._ventana};

        } catch (error) {
            if (silencioso) {
                console.error("shalom: error al refrescar las rutas", error);
                return;
            }
            this.notification.add(
                "No se pudieron cargar tus rutas. Revisá tu conexión e intentá de nuevo.",
                {type: "danger"}
            );
        } finally {
            this.state.cargando = false;
        }
    }

    /** Ruta sin nada que vender: ningún cliente por atender ha comprado antes
     * (sin ventas, o ya atendida entera). Visita Exprés nunca. */
    _sinVentas(s) {
        return !s.es_visita_express && s.pendientes_con_ventas === 0;
    }

    get cantidadRutasSinVentas() {
        return this.state.schedules.filter((s) => this._sinVentas(s)).length;
    }

    toggleSinVentas() {
        this.state.verSinVentas = !this.state.verSinVentas;
    }

    get schedulesFiltrados() {
        const q = this.state.busqueda.trim().toLowerCase();
        const filtradas = this.state.schedules.filter((s) => {
            if (q && !s.route_name.toLowerCase().includes(q)) {
                return false;
            }
            if (this._sinVentas(s) && !this.state.verSinVentas) {
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

    /** Rango de fechas de ESTA ocurrencia puntual, para la tarjeta de
     * cada ruta: se muestran las fechas reales
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

    abrir(schedule) {
        this.props.onAbrirRuta(schedule);
    }
}
