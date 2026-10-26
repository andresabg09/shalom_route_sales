/** @odoo-module **/

import {Component, onMounted, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {ClienteForm} from "./cliente_form";

const MESES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** "$41,900" */
export function dinero(valor) {
    const n = Math.round(Number(valor) || 0);
    return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US")}`;
}

/** "$25.3k" para tarjetas chicas; menos de mil se escribe completo. */
export function dineroCorto(valor) {
    const n = Number(valor) || 0;
    return Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`;
}

/** "octubre 2026" desde "2026-10-01". */
export function nombreMes(fechaIso) {
    const m = /^(\d{4})-(\d{2})/.exec(fechaIso || "");
    return m ? `${MESES[Number(m[2]) - 1]} ${m[1]}` : "";
}

function mensajeDeError(error, defecto) {
    return (error && error.data && error.data.message) || defecto;
}

/** Texto de un campo para un CSV: entre comillas, con comillas dobles
 * escapadas. */
export function celdaCsv(valor) {
    return `"${String(valor === null || valor === undefined ? "" : valor).replace(/"/g, '""')}"`;
}

/**
 * Administración → pestaña "Gerente" (Fase 7 del juego de ventas): la
 * vista del dueño. Cuatro secciones que cargan POR SEPARADO (si una
 * llamada al servidor falla, las demás siguen y la que falló muestra
 * "Reintentar"):
 *
 * - Mes en curso: ventas contra piso y meta, margen, oxigenta por cada
 *   100 tintes, estrellas y XP del equipo (shalom_admin_gerente_mes).
 * - Reparto de rutas (propuesta): valor esperado mensual por vendedor y
 *   botón "Pasar a…" por ruta (shalom_admin_reparto_rutas /
 *   shalom_admin_reasignar_ruta, que primero se llama con simular=true
 *   para mostrar qué va a cambiar y recién al confirmar escribe).
 * - Salud de los datos (shalom_admin_salud_datos).
 * - GPS prioritario: clientes buenos sin GPS por valor. Cada fila tiene
 *   dos salidas que SÍ funcionan desde la app: "Ubicar" abre el
 *   asistente nativo "Buscar GPS por nombre" (Google Places) cargado
 *   con ese cliente -- la vía correcta desde la oficina --, y "Ficha"
 *   abre ClienteForm (editar cliente), donde "Registrar coordenadas"
 *   toma el GPS del dispositivo (solo sirve estando físicamente en el
 *   local) y se puede asignar ruta. Ver models/shalom_gerente.py.
 *
 * Solo para el rol Administrador de Servicio de Campo: el servidor
 * rechaza a cualquier otro (AccessError).
 */
export class AdminGerente extends Component {
    static template = "shalom_location_map.AdminGerente";
    static components = {ClienteForm};
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        this.state = useState({
            mes: null,
            cargandoMes: true,
            errorMes: false,
            reparto: null,
            cargandoReparto: true,
            errorReparto: false,
            salud: null,
            cargandoSalud: true,
            errorSalud: false,
            // primeros | todos | sin_ruta
            gpsVista: "primeros",
            // Modal "Pasar a…": {ruta, personaId, resumen, simulando, aplicando, error}
            pasar: null,
            locationIdEditando: null,
        });
        onMounted(() => this.cargarTodo());
    }

    // -- formato (los usa la plantilla) --
    dinero(v) {
        return dinero(v);
    }

    dineroCorto(v) {
        return dineroCorto(v);
    }

    get mesNombre() {
        return this.state.mes ? nombreMes(this.state.mes.mes) : "";
    }

    pct(v) {
        return v === null || v === undefined ? "-" : `${Number(v).toFixed(1).replace(/\.0$/, "")}%`;
    }

    // ==================================================================
    // Carga: cada sección por su cuenta
    // ==================================================================

    cargarTodo() {
        return Promise.all([this.cargarMes(), this.cargarReparto(), this.cargarSalud()]);
    }

    async cargarMes() {
        this.state.cargandoMes = true;
        this.state.errorMes = false;
        try {
            this.state.mes = await this.orm.call("fsm.route", "shalom_admin_gerente_mes", []);
        } catch (error) {
            this.state.errorMes = mensajeDeError(error, "No se pudo cargar el mes.");
        } finally {
            this.state.cargandoMes = false;
        }
    }

    async cargarReparto() {
        this.state.cargandoReparto = true;
        this.state.errorReparto = false;
        try {
            this.state.reparto = await this.orm.call("fsm.route", "shalom_admin_reparto_rutas", []);
        } catch (error) {
            this.state.errorReparto = mensajeDeError(error, "No se pudo cargar el reparto de rutas.");
        } finally {
            this.state.cargandoReparto = false;
        }
    }

    async cargarSalud() {
        this.state.cargandoSalud = true;
        this.state.errorSalud = false;
        try {
            this.state.salud = await this.orm.call("fsm.route", "shalom_admin_salud_datos", []);
        } catch (error) {
            this.state.errorSalud = mensajeDeError(error, "No se pudo cargar la salud de los datos.");
        } finally {
            this.state.cargandoSalud = false;
        }
    }

    // ==================================================================
    // Mes en curso
    // ==================================================================

    /** Ancho (0-100) de la barra de ventas: se llena hasta la meta. */
    get barraVentasPct() {
        const m = this.state.mes;
        if (!m || !m.meta) {
            return 0;
        }
        return Math.max(0, Math.min(100, (m.ventas * 100) / m.meta));
    }

    /** Posición (0-100) de la marca del piso sobre la barra. */
    get marcaPisoPct() {
        const m = this.state.mes;
        if (!m || !m.meta) {
            return 0;
        }
        return Math.max(0, Math.min(100, (m.piso * 100) / m.meta));
    }

    // ==================================================================
    // Reparto de rutas: "Pasar a…"
    // ==================================================================

    /** Vendedores a los que se puede pasar la ruta (todos menos su dueño). */
    personasPara(ruta) {
        const reparto = this.state.reparto;
        if (!reparto) {
            return [];
        }
        return reparto.personas.filter((p) => p.id !== ruta.persona_id);
    }

    abrirPasar(ruta) {
        this.state.pasar = {
            ruta,
            personaId: 0,
            resumen: null,
            simulando: false,
            aplicando: false,
            error: "",
        };
    }

    cerrarPasar() {
        this.state.pasar = null;
    }

    /** Al elegir el vendedor se pide el resumen (simular=true): no escribe
     * nada, solo cuenta lo que cambiaría. */
    async elegirPersona(ev) {
        const pasar = this.state.pasar;
        if (!pasar) {
            return;
        }
        const personaId = Number(ev.target.value) || 0;
        pasar.personaId = personaId;
        pasar.resumen = null;
        pasar.error = "";
        if (!personaId) {
            return;
        }
        pasar.simulando = true;
        try {
            const resumen = await this.orm.call(
                "fsm.route", "shalom_admin_reasignar_ruta", [pasar.ruta.id, personaId, true]
            );
            // Si mientras tanto eligió a otro (o cerró), esta respuesta ya no vale.
            if (this.state.pasar === pasar && pasar.personaId === personaId) {
                pasar.resumen = resumen;
            }
        } catch (error) {
            if (this.state.pasar === pasar && pasar.personaId === personaId) {
                pasar.error = mensajeDeError(error, "No se pudo calcular el cambio.");
            }
        } finally {
            if (this.state.pasar === pasar) {
                pasar.simulando = false;
            }
        }
    }

    async confirmarPasar() {
        const pasar = this.state.pasar;
        if (!pasar || !pasar.resumen || pasar.aplicando) {
            return;
        }
        pasar.aplicando = true;
        pasar.error = "";
        try {
            const res = await this.orm.call(
                "fsm.route", "shalom_admin_reasignar_ruta", [pasar.ruta.id, pasar.personaId]
            );
            this.notification.add(
                `«${res.ruta}» ahora es de ${res.nuevo.nombre}. ` +
                `${res.visitas_pasadas} visita(s) abierta(s) pasaron a su nombre` +
                (res.cartera_limpiada ? `; se limpió la cartera de ${res.cartera_limpiada}.` : "."),
                {type: "success"}
            );
            this.state.pasar = null;
            await this.cargarReparto();
        } catch (error) {
            pasar.error = mensajeDeError(error, "No se pudo pasar la ruta.");
            pasar.aplicando = false;
        }
    }

    // ==================================================================
    // GPS prioritario
    // ==================================================================

    get gpsFilas() {
        const salud = this.state.salud;
        if (!salud) {
            return [];
        }
        const todos = salud.gps_prioritario || [];
        if (this.state.gpsVista === "primeros") {
            return todos.slice(0, salud.gps_n);
        }
        if (this.state.gpsVista === "sin_ruta") {
            return todos.filter((f) => f.sin_ruta);
        }
        return todos;
    }

    get gpsSinRuta() {
        const salud = this.state.salud;
        return salud ? (salud.gps_prioritario || []).filter((f) => f.sin_ruta).length : 0;
    }

    get gpsAvancePct() {
        const salud = this.state.salud;
        if (!salud || !salud.buenos.total) {
            return 0;
        }
        return Math.round((salud.buenos.con_gps * 100) / salud.buenos.total);
    }

    cambiarGpsVista(vista) {
        this.state.gpsVista = vista;
    }

    /** "Ubicar": abre el asistente nativo "Buscar GPS por nombre" con ESTE
     * cliente (la oficina no está parada en el local: Google Places
     * encuentra el comercio por nombre). Es la misma acción que usa el
     * botón de la mira en Seguimiento y Rutas. */
    ubicar(fila) {
        this.action.doAction("shalom_location_map.shalom_buscar_gps_wizard_action", {
            additionalContext: {active_model: "fsm.location", active_ids: [fila.id]},
        });
    }

    /** "Ficha": editar cliente (ClienteForm). */
    abrirFicha(fila) {
        this.state.locationIdEditando = fila.id;
    }

    cerrarFicha() {
        this.state.locationIdEditando = null;
    }

    async fichaGuardada() {
        this.state.locationIdEditando = null;
        // Pudo cambiar el GPS (sale de la lista) o la ruta (cambia el reparto).
        await Promise.all([this.cargarSalud(), this.cargarReparto()]);
    }

    /** Descarga la lista completa del GPS prioritario (todas las filas,
     * no solo la pestaña activa). */
    descargarCsv() {
        const salud = this.state.salud;
        if (!salud || !salud.gps_prioritario.length) {
            return;
        }
        const filas = [["Prioridad", "Cliente", "Clase", "Ruta", "Valor esperado"]];
        salud.gps_prioritario.forEach((f, i) => {
            filas.push([i + 1, f.name, f.clase, f.ruta || "sin ruta", Number(f.valor).toFixed(2)]);
        });
        const csv = "﻿" + filas.map((fila) => fila.map(celdaCsv).join(",")).join("\r\n");
        try {
            const url = URL.createObjectURL(new Blob([csv], {type: "text/csv;charset=utf-8"}));
            const enlace = document.createElement("a");
            enlace.href = url;
            enlace.download = "gps_prioritario.csv";
            document.body.appendChild(enlace);
            enlace.click();
            enlace.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (error) {
            this.notification.add("No se pudo generar el archivo.", {type: "danger"});
        }
    }
}
