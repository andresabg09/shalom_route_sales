/** @odoo-module **/

import {Component, onWillStart, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";

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
        });
        onWillStart(() => this.cargar());
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

            const hoyStr = aFechaStr(hoy);
            const semanaActual = resultado.find(
                (s) => s.date_start <= hoyStr && s.date_end >= hoyStr
            );
            this.state.periodo = semanaActual ? semanaActual.date_start : "todos";
        } catch (error) {
            this.notification.add(
                "No se pudieron cargar tus rutas. Revisá tu conexión e intentá de nuevo.",
                {type: "danger"}
            );
        } finally {
            this.state.cargando = false;
        }
    }

    get semanas() {
        const vistas = new Map();
        for (const s of this.state.schedules) {
            if (!vistas.has(s.date_start)) {
                vistas.set(s.date_start, {date_start: s.date_start, date_end: s.date_end});
            }
        }
        return [...vistas.values()].sort((a, b) => (a.date_start < b.date_start ? -1 : 1));
    }

    get schedulesFiltrados() {
        const q = this.state.busqueda.trim().toLowerCase();
        return this.state.schedules.filter((s) => {
            if (this.state.periodo !== "todos" && s.date_start !== this.state.periodo) {
                return false;
            }
            if (q && !s.route_name.toLowerCase().includes(q)) {
                return false;
            }
            return true;
        });
    }

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
        return `Semana del ${inicio} al ${fin}`;
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
