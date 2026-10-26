/** @odoo-module **/

import {Component, onWillUnmount, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {abrirNivel, cerrarNivel} from "./back_stack";

/**
 * Panel del juego (Fase 6A), con tres pestañas: Logros / Equipo /
 * Temporada. Se abre desde la tarjeta de progreso (nivel y XP) de la
 * pestaña Rutas.
 *
 * - Juego COOPERATIVO: la pestaña Equipo muestra el marcador del equipo
 *   (piso y jefe final del mes), nunca una tabla de posiciones.
 * - Cada pestaña carga sus datos al abrirla; si la RPC falla, esa
 *   pestaña muestra un aviso con "Reintentar" y el resto sigue
 *   funcionando.
 * - Atrás de Android: se registra como un nivel en back_stack.js (igual
 *   que ClienteForm): empuja su nivel al abrirse y lo cierra al
 *   desmontarse. Un Atrás real recarga la app y el panel queda cerrado.
 */

function dinero(valor) {
    return "$" + Math.round(valor || 0).toLocaleString("en-US");
}

function numero(valor) {
    return Math.round(valor || 0).toLocaleString("en-US");
}

const PESTANAS = [
    {id: "logros", etiqueta: "Logros"},
    {id: "equipo", etiqueta: "Equipo"},
    {id: "temporada", etiqueta: "Temporada"},
];

const RPC = {
    logros: "shalom_mis_logros",
    equipo: "shalom_equipo_mes",
    temporada: "shalom_temporada",
};

export class JuegoPanel extends Component {
    static template = "shalom_location_map.JuegoPanel";
    static props = {
        onCerrar: Function,
        onRepasarTutorial: {type: Function, optional: true},
        // Pestaña con la que se abre (por defecto Logros)
        pestana: {type: String, optional: true},
    };

    setup() {
        this.orm = useService("orm");
        this.pestanas = PESTANAS;
        this.dinero = dinero;
        this.numero = numero;
        this.state = useState({
            pestana: this.props.pestana || "logros",
            // por pestaña: {estado: "cargando" | "ok" | "vacio" | "error", datos}
            logros: {estado: "cargando", datos: null},
            equipo: {estado: "cargando", datos: null},
            temporada: {estado: "cargando", datos: null},
        });
        // Nivel propio en la pila de navegación (Atrás de Android).
        abrirNivel({tipo: "juego_panel"});
        this._nivelCerrado = false;
        onWillUnmount(() => this._cerrarMiNivel());
        this.cargar(this.state.pestana);
    }

    _cerrarMiNivel() {
        if (this._nivelCerrado) {
            return;
        }
        this._nivelCerrado = true;
        cerrarNivel();
    }

    cerrar() {
        this.props.onCerrar();
    }

    elegirPestana(id) {
        this.state.pestana = id;
        if (this.state[id].estado !== "ok") {
            this.cargar(id);
        }
    }

    async cargar(id) {
        const celda = this.state[id];
        celda.estado = "cargando";
        try {
            const datos = await this.orm.call("shalom.juego.evento", RPC[id], []);
            celda.datos = datos || null;
            // Sin fsm.person vinculado el servidor devuelve null.
            celda.estado = datos ? "ok" : "vacio";
        } catch (error) {
            console.error(`shalom: error al cargar ${id}`, error);
            celda.estado = "error";
        }
    }

    reintentar(id) {
        this.cargar(id);
    }

    repasarTutorial() {
        if (this.props.onRepasarTutorial) {
            this.props.onRepasarTutorial();
        }
    }

    // ---------------- Logros ----------------
    get logrosVista() {
        const d = this.state.logros.datos;
        if (!d) {
            return null;
        }
        // Los ganados primero (los de hoy arriba de todo), luego por avance.
        const orden = [...d.logros].sort((a, b) => {
            if (a.completo !== b.completo) {
                return a.completo ? -1 : 1;
            }
            if (a.completo) {
                return (a.hoy ? 0 : 1) - (b.hoy ? 0 : 1) || (a.fecha < b.fecha ? 1 : -1);
            }
            return b.progreso / b.meta - a.progreso / a.meta;
        });
        return {...d, ordenados: orden};
    }

    porcentaje(logro) {
        return logro.meta ? Math.min(100, (logro.progreso / logro.meta) * 100) : 0;
    }

    /** Progreso como texto: "2/3"; el XP de "Nivel 2" es grande, mejor "450/600". */
    textoProgreso(logro) {
        return `${numero(logro.progreso)}/${numero(logro.meta)}`;
    }

    // ---------------- Equipo ----------------
    get equipoVista() {
        const e = this.state.equipo.datos;
        if (!e) {
            return null;
        }
        const tope = Math.max(e.meta || 0, e.piso || 0, e.ventas || 0, 1);
        const pctBarra = Math.min(100, (e.ventas / tope) * 100);
        const pctPiso = Math.min(100, ((e.piso || 0) / tope) * 100);
        let estado;
        if (e.meta_alcanzada) {
            estado = "¡Jefe final derrotado! El equipo llegó a la meta del mes.";
        } else if (e.piso_alcanzado) {
            estado = "¡Piso del mes asegurado! Ahora van por el jefe final.";
        } else if (e.en_ritmo) {
            estado = "Van en ritmo para el piso.";
        } else {
            estado = "Van un poco atrás del ritmo: cada pedido cuenta.";
        }
        return {
            ...e,
            pctBarra,
            pctPiso,
            estado,
            diasHabilesTexto:
                e.dias_habiles_restantes === 1 ? "1 día hábil" : `${e.dias_habiles_restantes} días hábiles`,
            camionPct: e.camion ? Math.min(100, e.camion.pct) : 0,
        };
    }

    // ---------------- Temporada ----------------
    get temporadaVista() {
        const t = this.state.temporada.datos;
        if (!t) {
            return null;
        }
        const diasTexto = t.dias_restantes_mes === 1 ? "1 día" : `${t.dias_restantes_mes} días`;
        return {...t, diasTexto};
    }
}
