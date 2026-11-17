/** @odoo-module **/

import {Component, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {cargarMetaPreparacion, esErrorDeRed, prepararDia} from "./datos_offline";
import {
    comprobarRed,
    descartar,
    enviarPendientes,
    estadoOffline,
    iniciarSincronizador,
    ormDeLaCola,
    reintentar,
} from "./sincronizador";

const ETIQUETA_TIPO = {
    confirmar_pedido: "Pedido",
    guardar_borrador: "Cotización",
    cambiar_etapa: "Estado de visita",
    observacion: "Nota",
    gps: "GPS",
    descartar_carrito: "Carrito descartado",
};

/** Cuánto hace, en palabras cortas ("hace 5 min", "hace 2 h"). */
export function haceCuanto(ts) {
    if (!ts) {
        return "";
    }
    const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (min < 1) {
        return "recién";
    }
    if (min < 60) {
        return `hace ${min} min`;
    }
    const horas = Math.round(min / 60);
    if (horas < 48) {
        return `hace ${horas} h`;
    }
    return `hace ${Math.round(horas / 24)} días`;
}

/**
 * Pastilla de conexión (modo offline): "En línea" / "Señal débil" /
 * "Sin señal", con cuántas acciones esperan a enviarse. Al tocarla abre
 * un panel con "Preparar mi día" (descargar todo para trabajar sin
 * señal) y la lista de lo pendiente, con Reintentar/Descartar para lo
 * que el servidor rechazó ("Necesita atención").
 */
export class IndicadorConexion extends Component {
    static template = "shalom_location_map.IndicadorConexion";
    // compacta: solo el punto de color (y el número de pendientes), para
    // cabeceras con poco lugar como la del catálogo.
    static props = {compacta: {type: Boolean, optional: true}};

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.offline = useState(estadoOffline);
        // panelAbierto es de CADA pastilla (no del estado compartido): con
        // el catálogo abierto encima de la ruta hay dos pastillas montadas,
        // y con el estado compartido el panel se dibujaba dos veces.
        this.local = useState({fotos: false, panelAbierto: false});
        const ormCrudo = (this.env.services && this.env.services.orm) || this.orm;
        iniciarSincronizador(ormCrudo, this.notification);
        cargarMetaPreparacion();
    }

    get pendientes() {
        return this.offline.cola.filter((i) => i.estado === "pendiente");
    }

    get conError() {
        return this.offline.cola.filter((i) => i.estado === "error");
    }

    get clasePastilla() {
        const red = {en_linea: "", debil: "off-pill-debil", sin_senal: "off-pill-sin"}[this.offline.red] || "";
        return `off-pill ${red} ${this.conError.length ? "off-pill-error" : ""} ${this.props.compacta ? "off-pill-compacta" : ""}`;
    }

    get textoPastilla() {
        if (this.offline.preparando) {
            return `Descargando… ${this.offline.progreso}%`;
        }
        const base = {en_linea: "En línea", debil: "Señal débil", sin_senal: "Sin señal"}[this.offline.red] || "En línea";
        if (this.conError.length) {
            return `${base} · ${this.conError.length} con problema`;
        }
        if (this.pendientes.length) {
            return `${base} · ${this.pendientes.length} por enviar`;
        }
        return base;
    }

    /** Pastilla compacta: solo el número de lo pendiente (o nada). */
    get textoCompacto() {
        if (this.offline.preparando) {
            return `${this.offline.progreso}%`;
        }
        const n = this.conError.length || this.pendientes.length;
        return n ? String(n) : "";
    }

    get tituloPastilla() {
        return `${this.textoPastilla}. Tocá para ver la conexión y lo pendiente.`;
    }

    get textoPreparado() {
        return this.offline.preparadoEn
            ? `Datos del día descargados ${haceCuanto(this.offline.preparadoEn)}.`
            : "Todavía no descargaste los datos de hoy en este teléfono.";
    }

    etiquetaItem(item) {
        const tipo = ETIQUETA_TIPO[item.tipo] || item.tipo;
        return item.etiqueta ? `${tipo}: ${item.etiqueta}` : tipo;
    }

    horaItem(item) {
        try {
            return new Date(item.creado_en).toLocaleTimeString("es-PA", {hour: "2-digit", minute: "2-digit"});
        } catch {
            return "";
        }
    }

    abrir() {
        this.local.panelAbierto = true;
        comprobarRed();
    }

    cerrar() {
        this.local.panelAbierto = false;
    }

    toggleFotos(ev) {
        this.local.fotos = ev.target.checked;
    }

    async preparar() {
        try {
            const r = await prepararDia(ormDeLaCola() || this.orm, {fotos: this.local.fotos});
            if (r) {
                this.notification.add(
                    r.fallidas
                        ? `Se guardaron ${r.rutas} de ${r.total} rutas y ${r.productos} productos. Las demás: probá de nuevo con mejor señal.`
                        : `Listo para trabajar sin señal: ${r.rutas} ruta(s) y ${r.productos} productos guardados.`,
                    {type: r.fallidas ? "warning" : "success"}
                );
            }
        } catch (error) {
            const mensaje = esErrorDeRed(error)
                ? "Sin buena señal: no se pudo descargar todo. Probá de nuevo con Wi-Fi o mejor señal."
                : (error && error.data && error.data.message) || "No se pudo preparar el día.";
            this.notification.add(mensaje, {type: "danger"});
        }
    }

    enviarAhora() {
        enviarPendientes();
    }

    async reintentar(item) {
        await reintentar(item.uuid);
    }

    async descartar(item) {
        // eslint-disable-next-line no-alert
        if (!window.confirm(`¿Descartar "${this.etiquetaItem(item)}"? No se va a enviar al sistema.`)) {
            return;
        }
        await descartar(item.uuid);
    }
}
