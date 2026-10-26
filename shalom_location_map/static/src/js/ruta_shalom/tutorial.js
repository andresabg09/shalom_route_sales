/** @odoo-module **/

import {Component, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";

/**
 * Tutorial de bienvenida del juego (Fase 6A): bienvenida -> 3 pasos con
 * una tarjeta clara de entrenador sobre ejemplos de PRÁCTICA (nada se
 * guarda ni se vende) -> "Tutorial terminado" con las 3 misiones de
 * bienvenida.
 *
 * - Se muestra una sola vez por usuario (RutasHub consulta
 *   shalom_tutorial_estado) y se puede repasar desde el panel de juego
 *   (prop `repaso`: no vuelve a marcar nada en el servidor).
 * - "Saltar" está siempre visible y marca el tutorial como visto.
 * - Si la RPC falla, el tutorial se cierra igual: nunca atrapa al
 *   vendedor ni bloquea la pestaña Rutas.
 * - NO se registra en back_stack.js a propósito: si lo hiciera, el Atrás
 *   de Android recargaría la app, el tutorial seguiría "sin ver" y
 *   reaparecería en bucle. Atrás sale del módulo como en cualquier otra
 *   pantalla de primer nivel; "Saltar" es la salida normal.
 */

// Cliente de práctica (el del diseño aprobado): su "pedido de siempre"
// es la vara; el récord es lo más que ha comprado.
export const CLIENTE_PRACTICA = {
    nombre: "Carnes Primium",
    fecha: "24 de Diciembre",
    tipico: 4064,
    bronce: 3048,
    record: 4396,
};
const TOTAL_INICIAL = 3900;
const PASO_MONTO = 500;

// Respaldo si no se pueden leer los logros del servidor: las mismas 3
// misiones de bienvenida (100 + 200 + 300 = 600 XP = nivel 2).
const MISIONES_RESPALDO = [
    {codigo: "primer_pedido", nombre: "Primer pedido", descripcion: "Toma tu primer pedido", xp: 100, completo: false},
    {codigo: "quimico", nombre: "El Químico", descripcion: "Pon oxigenta en 3 pedidos que lleven tinte", xp: 200, completo: false},
    {codigo: "ruta_sin_saltos", nombre: "Ruta sin saltos", descripcion: "Cierra 5 clientes seguidos de la misma ruta", xp: 300, completo: false},
];

function dinero(valor) {
    return "$" + Math.round(valor || 0).toLocaleString("en-US");
}

/** Estrellas (0-3) y mensaje del pedido de práctica contra el cliente
 * de práctica -- mismas reglas que el juego real (75% / 100% / récord). */
export function evaluarPractica(total, c = CLIENTE_PRACTICA) {
    if (total > c.record) {
        return {estrellas: 3, mensaje: "¡Oro! Superaste su récord."};
    }
    if (total >= c.tipico) {
        return {estrellas: 2, mensaje: `Plata lista. Te faltan ${dinero(c.record + 1 - total)} para el oro`};
    }
    if (total >= c.bronce) {
        return {estrellas: 1, mensaje: `Bronce listo. Te faltan ${dinero(c.tipico - total)} para la plata`};
    }
    return {estrellas: 0, mensaje: `Te faltan ${dinero(c.bronce - total)} para el bronce`};
}

const PASOS = {
    1: {
        titulo: "Este es tu primer cliente",
        siguiente: "Siguiente",
    },
    2: {
        titulo: "Así se ganan las estrellas",
        siguiente: "Siguiente",
    },
    3: {
        titulo: "Así empieza cada pedido",
        siguiente: "Entendido",
    },
};

export class Tutorial extends Component {
    static template = "shalom_location_map.Tutorial";
    static props = {
        // true: ya lo vio, es un repaso (no se vuelve a marcar en el servidor)
        repaso: {type: Boolean, optional: true},
        // Nombre del vendedor para el saludo ("Entraste como …")
        nombre: {type: String, optional: true},
        // Cierra el tutorial (Saltar / cerrar)
        onCerrar: Function,
        // "Ir al mapa de rutas" del final
        onIrAlMapa: {type: Function, optional: true},
    };

    setup() {
        this.orm = useService("orm");
        this.state = useState({
            // "bienvenida" | 1 | 2 | 3 | "fin"
            paso: "bienvenida",
            total: TOTAL_INICIAL,
            misiones: MISIONES_RESPALDO,
            xpPremio: 600,
            guardando: false,
        });
        this.cliente = CLIENTE_PRACTICA;
        this.dinero = dinero;
    }

    get nombreCorto() {
        return ((this.props.nombre || "").trim().split(/\s+/)[0]) || "";
    }

    get inicial() {
        return (this.nombreCorto[0] || "?").toUpperCase();
    }

    get pasoActual() {
        return typeof this.state.paso === "number" ? PASOS[this.state.paso] : null;
    }

    get practica() {
        return evaluarPractica(this.state.total);
    }

    get misionesHechas() {
        return this.state.misiones.filter((m) => m.completo).length;
    }

    /** Marca el tutorial como visto en el servidor (salvo en un repaso). Si
     * falla, se ignora: el vendedor sigue y, como mucho, se lo vuelve a
     * mostrar la próxima vez. */
    async marcarVisto() {
        if (this.props.repaso) {
            return;
        }
        try {
            await this.orm.call("shalom.juego.evento", "shalom_tutorial_terminar", []);
        } catch (error) {
            console.error("shalom: no se pudo marcar el tutorial como visto", error);
        }
    }

    empezar() {
        this.state.paso = 1;
    }

    siguiente() {
        if (this.state.paso === 1) {
            this.state.paso = 2;
        } else if (this.state.paso === 2) {
            this.state.paso = 3;
        } else if (this.state.paso === 3) {
            this.terminar();
        }
    }

    sumarPractica() {
        this.state.total += PASO_MONTO;
    }

    reiniciarPractica() {
        this.state.total = TOTAL_INICIAL;
    }

    /** Último paso: marca visto y muestra "Tutorial terminado" con las misiones. */
    async terminar() {
        if (this.state.guardando) {
            return;
        }
        this.state.guardando = true;
        await this.marcarVisto();
        this.state.paso = "fin";
        this.state.guardando = false;
        this.cargarMisiones();
    }

    async cargarMisiones() {
        try {
            const res = await this.orm.call("shalom.juego.evento", "shalom_mis_logros", []);
            const misiones = ((res && res.logros) || []).filter((l) => l.bienvenida);
            if (misiones.length) {
                this.state.misiones = misiones;
                this.state.xpPremio = misiones.reduce((t, m) => t + m.xp, 0);
            }
        } catch (error) {
            console.error("shalom: no se pudieron leer las misiones de bienvenida", error);
        }
    }

    /** "Saltar" / "Ya sé jugar": marca visto y cierra sin pasar por el final. */
    async saltar() {
        if (this.state.guardando) {
            return;
        }
        this.state.guardando = true;
        await this.marcarVisto();
        this.state.guardando = false;
        this.props.onCerrar();
    }

    irAlMapa() {
        if (this.props.onIrAlMapa) {
            this.props.onIrAlMapa();
        } else {
            this.props.onCerrar();
        }
    }
}
