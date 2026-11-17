/** @odoo-module **/

import {Component, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {
    borrarDatosDescargados,
    cargarMetaPreparacion,
    esErrorDeRed,
    prepararDia,
    prepararSoloNuevas,
    resumenDatosTelefono,
    textoMegas,
} from "./datos_offline";
import {
    comprobarRed,
    descartar,
    eliminarPendiente,
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
        this.local = useState({
            fotos: false,
            panelAbierto: false,
            abiertoUuid: null,
            verRutas: false, // lista de rutas desplegada
            confirmandoDescarga: false, // "Ya tienes todo descargado…"
        });
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

    // -- Checklist "Datos en este teléfono" --

    get datos() {
        return resumenDatosTelefono(this.offline);
    }

    get etiquetaFrescura() {
        return {al_dia: "Al día", actualizar: "Conviene actualizar", sin_descargar: "Sin descargar"}[this.datos.frescura];
    }

    get textoRutas() {
        const d = this.datos;
        if (!this.offline.preparadoEn) {
            return "Sin descargar";
        }
        if (this.offline.rutasDisponibles) {
            return d.rutasGuardadas + " de " + d.rutasTotal + (d.rutasTotal === 1 ? " ruta · " : " rutas · ") + d.cuando;
        }
        return d.rutasGuardadas + (d.rutasGuardadas === 1 ? " ruta · " : " rutas · ") + d.cuando;
    }

    get textoCatalogo() {
        const d = this.datos;
        if (!this.offline.preparadoEn) {
            return "Sin descargar";
        }
        return d.productos.toLocaleString("en-US") + " productos · " + d.cuando;
    }

    get textoFotos() {
        return this.offline.fotosEn
            ? "Guardadas desde " + this.datos.fotosCuando + " · solo bajan las que cambien"
            : "Sin descargar · opcional";
    }

    /** "ok" | "viejo" | "falta": ícono de cada fila del checklist. */
    get iconoDatos() {
        return {al_dia: "ok", actualizar: "viejo", sin_descargar: "falta"}[this.datos.frescura];
    }

    get textoBotonPreparar() {
        if (this.offline.preparando) {
            return "Descargando…";
        }
        if (this.datos.soloNuevas) {
            const n = this.datos.rutasNuevas;
            return "Bajar solo lo nuevo (" + n + (n === 1 ? " ruta)" : " rutas)");
        }
        return {
            al_dia: "Todo al día · actualizar igual",
            actualizar: "Actualizar datos del día",
            sin_descargar: "Descargar datos del día",
        }[this.datos.frescura];
    }

    get textoEstadoRed() {
        return {
            en_linea: this.datos.frescura === "al_dia"
                ? "Todo lo que hagas se envía al momento."
                : "Buen momento para actualizar los datos.",
            debil: "Lo que hagas se guarda y se envía apenas la señal mejore.",
            sin_senal: "Seguí vendiendo: todo queda guardado y se envía solo. No cierres la app.",
        }[this.offline.red];
    }

    get textoEspacio() {
        const megas = textoMegas(this.offline.espacioUsado);
        return megas
            ? megas + " en este teléfono · lo viejo se borra solo"
            : "Lo viejo se borra solo cada vez que descargás";
    }

    toggleRutas() {
        this.local.verRutas = !this.local.verRutas;
    }

    noDescargar() {
        this.local.confirmandoDescarga = false;
    }

    async descargarIgual() {
        this.local.confirmandoDescarga = false;
        await this._descargar(false);
    }

    async borrarDatos() {
        const pendientes = this.pendientes.length + this.conError.length;
        const extra = pendientes
            ? "\n\nLo que espera enviarse (" + pendientes + ") NO se borra: se sigue enviando solo."
            : "";
        // eslint-disable-next-line no-alert
        if (!window.confirm("¿Borrar todo lo descargado de este teléfono? Sin señal no vas a poder ver rutas ni catálogo hasta volver a descargar." + extra)) {
            return;
        }
        await borrarDatosDescargados();
        this.notification.add("Datos descargados borrados del teléfono.", {type: "success"});
    }

    // -- Tarjetas de lo que espera enviarse --

    esPedido(item) {
        return item.tipo === "confirmar_pedido" || item.tipo === "guardar_borrador";
    }

    clienteItem(item) {
        return (item.resumen && item.resumen.cliente) || item.etiqueta || "";
    }

    lineasItem(item) {
        return (item.resumen && item.resumen.lineas) || [];
    }

    totalItem(item) {
        const total = item.resumen && item.resumen.total;
        return typeof total === "number" ? "$" + total.toFixed(2) : "";
    }

    detalleItem(item) {
        const r = item.resumen || {};
        if (this.esPedido(item)) {
            const n = this.lineasItem(item).filter((l) => !l.recompensa).length;
            return n ? n + (n === 1 ? " producto" : " productos") : "";
        }
        return r.detalle || "";
    }

    toggleItem(item) {
        this.local.abiertoUuid = this.local.abiertoUuid === item.uuid ? null : item.uuid;
    }

    async eliminar(item) {
        const que = this.esPedido(item) ? "este pedido" : "esta acción";
        // eslint-disable-next-line no-alert
        if (!window.confirm("¿Eliminar " + que + " de " + (this.clienteItem(item) || "este cliente") + "? No se va a enviar al sistema.")) {
            return;
        }
        const resultado = await eliminarPendiente(item.uuid);
        const mensajes = {
            eliminado: ["Eliminado del teléfono: no se va a enviar.", "success"],
            ya_entro: ["Ya había entrado al sistema: no se puede eliminar desde acá, corregilo desde Ventas.", "warning"],
            sin_senal: ["Ya se intentó enviar y sin señal no se sabe si llegó. Volvé a intentarlo cuando haya señal.", "warning"],
            enviando: ["Se está enviando justo ahora. Probá de nuevo en un momento.", "warning"],
            no_existe: ["Ya se envió.", "info"],
        };
        const [texto, tipo] = mensajes[resultado] || ["", "info"];
        if (texto) {
            this.notification.add(texto, {type: tipo});
        }
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
        // Todo al día: preguntar antes (no hace falta volver a descargar).
        if (this.datos.frescura === "al_dia" && !this.local.fotos) {
            this.local.confirmandoDescarga = true;
            return;
        }
        await this._descargar(this.datos.soloNuevas && !this.local.fotos);
    }

    async _descargar(soloNuevas) {
        if (soloNuevas) {
            try {
                const r = await prepararSoloNuevas(ormDeLaCola() || this.orm);
                if (r) {
                    this.notification.add(
                        r.fallidas
                            ? "Se bajaron " + r.rutas + " de " + r.total + " rutas nuevas. Las demás: probá de nuevo con mejor señal."
                            : "Listo: " + r.rutas + (r.rutas === 1 ? " ruta nueva guardada." : " rutas nuevas guardadas."),
                        {type: r.fallidas ? "warning" : "success"}
                    );
                }
            } catch (error) {
                this.notification.add("Sin buena señal: no se pudieron bajar las rutas nuevas.", {type: "danger"});
            }
            return;
        }
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
