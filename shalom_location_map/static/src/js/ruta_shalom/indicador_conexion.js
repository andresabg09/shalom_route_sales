/** @odoo-module **/

import {Component, onRendered, onWillRender, onWillUnmount, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {
    borrarDatosDescargados,
    cargarMetaPreparacion,
    completarFotosGuardadas,
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

// Igual que la hoja de visita (UMBRAL_ARRASTRE_CIERRE en visit_sheet.js):
// soltar el panel más abajo que esto lo cierra.
const UMBRAL_ARRASTRE_CIERRE = 90;

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
            panelAbierto: false,
            abiertoUuid: null,
            verRutas: false, // lista de rutas desplegada
            confirmandoDescarga: false, // "Ya tienes todo descargado…"
        });
        this.panelRef = useRef("panel");
        // Arrastre del panel: NO es estado reactivo (ver iniciarArrastre).
        this._arrastre = null;
        this._onMoverArrastre = (ev) => this.moverArrastre(ev);
        this._onSoltarArrastre = (ev) => this.soltarArrastre(ev);
        onWillUnmount(() => {
            this.detenerArrastre();
            clearTimeout(this._cierreTimer);
            cancelAnimationFrame(this._cuadroArrastre);
        });
        // Ojo: la plantilla lee los getters sobre un objeto que HEREDA del
        // componente (Object.create), así que asignar this._algo desde un
        // getter lo guardaría en ese objeto y no acá. Por eso la memoria
        // del dibujo es un objeto compartido que solo se modifica por dentro.
        this._memo = {enDibujo: false, datos: null};
        onWillRender(() => {
            this._memo.enDibujo = true;
            this._memo.datos = null;
        });
        onRendered(() => {
            this._memo.enDibujo = false;
        });
        const ormCrudo = (this.env.services && this.env.services.orm) || this.orm;
        iniciarSincronizador(ormCrudo, this.notification);
        // Al abrir la app: completar por detrás las fotos que falten.
        cargarMetaPreparacion()
            .then(() => completarFotosGuardadas(ormCrudo))
            .catch((error) => console.error("shalom: fotos", error));
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
        // Una sola cuenta por dibujo (la plantilla lo lee una decena de
        // veces); fuera del dibujo, siempre fresco.
        const memo = this._memo;
        if (!memo.enDibujo) {
            return resumenDatosTelefono(this.offline);
        }
        if (!memo.datos) {
            memo.datos = resumenDatosTelefono(this.offline);
        }
        return memo.datos;
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

    get fotosCompletas() {
        return this.offline.fotosTotal > 0 && this.offline.fotosGuardadas >= this.offline.fotosTotal;
    }

    get avisoSegundoPlano() {
        if (!this.offline.preparando && this.fotosCompletas) {
            return "";
        }
        return "La pantalla se mantiene encendida mientras se descarga. Si sales de la app, en Android las fotos siguen en segundo plano; si no, se retoma al volver.";
    }

    get textoFotos() {
        const {fotosGuardadas, fotosTotal} = this.offline;
        if (!fotosTotal) {
            return this.offline.fotosEn ? "Guardadas en el teléfono" : "Se bajan solas con señal";
        }
        const n = (x) => x.toLocaleString("en-US");
        return this.fotosCompletas
            ? n(fotosTotal) + " guardadas · solo bajan las que cambien"
            : n(fotosGuardadas) + " de " + n(fotosTotal) + " guardadas · se siguen bajando solas";
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
        clearTimeout(this._cierreTimer);
        this.local.panelAbierto = true;
        comprobarRed();
    }

    cerrar() {
        this.detenerArrastre();
        this._arrastre = null;
        this.local.panelAbierto = false;
    }

    // -- Arrastrar el panel hacia abajo para cerrarlo --
    // Misma regla que la hoja de visita (visit_sheet.js): se agarra desde
    // cualquier parte salvo campos y links, y solo cuando el panel está
    // arriba del todo (si no, el gesto es scroll normal del contenido).
    //
    // Bug real reportado ("se mueve trabado, como a 5 fps"): el panel tiene
    // scroll propio, así que el navegador tomaba el gesto como SCROLL y, a
    // partir de ahí, entregaba los movimientos del dedo de a ratos
    // (en Android, uno cada ~200 ms) y sin poder frenarlos. Ahora, en el
    // PRIMER movimiento hacia abajo con el panel arriba del todo, el gesto
    // se toma como arrastre (preventDefault en un listener no pasivo): el
    // navegador no arranca el scroll y manda cada movimiento al momento.
    // Además, el panel se mueve escribiendo el transform directo en el
    // elemento (una vez por cuadro), sin estado reactivo: cero redibujos de
    // Owl durante el gesto.

    iniciarArrastre(ev) {
        const objetivo = ev.target;
        const panel = this.panelRef.el;
        if (!panel || !objetivo || !objetivo.closest || objetivo.closest("input, textarea, a, select")) {
            return;
        }
        if (panel.scrollTop > 0 || !ev.touches || ev.touches.length !== 1) {
            return;
        }
        this.detenerArrastre();
        this._arrastre = {inicioY: ev.touches[0].clientY, y: 0, activo: false};
        panel.addEventListener("touchmove", this._onMoverArrastre, {passive: false});
        window.addEventListener("touchend", this._onSoltarArrastre);
        window.addEventListener("touchcancel", this._onSoltarArrastre);
    }

    moverArrastre(ev) {
        const a = this._arrastre;
        const panel = this.panelRef.el;
        if (!a || !panel || !ev.touches || !ev.touches.length) {
            return;
        }
        const delta = ev.touches[0].clientY - a.inicioY;
        if (!a.activo) {
            // Primer movimiento: hacia arriba (o con el contenido ya
            // scrolleado) es scroll normal y se suelta el gesto.
            if (delta <= 0 || panel.scrollTop > 0) {
                if (delta < 0 || panel.scrollTop > 0) {
                    this.detenerArrastre();
                    this._arrastre = null;
                }
                return;
            }
            a.activo = true;
            panel.style.transition = "none";
            panel.style.willChange = "transform";
        }
        if (ev.cancelable) {
            ev.preventDefault();
        }
        a.y = Math.max(0, delta);
        if (!this._cuadroArrastre) {
            this._cuadroArrastre = requestAnimationFrame(() => {
                this._cuadroArrastre = null;
                if (this._arrastre && this.panelRef.el) {
                    this.panelRef.el.style.transform = `translateY(${this._arrastre.y}px)`;
                }
            });
        }
    }

    soltarArrastre(ev) {
        const a = this._arrastre;
        this.detenerArrastre();
        this._arrastre = null;
        const panel = this.panelRef.el;
        if (!a || !a.activo || !panel) {
            return;
        }
        cancelAnimationFrame(this._cuadroArrastre);
        this._cuadroArrastre = null;
        panel.style.transition = "";
        panel.style.willChange = "";
        if (a.y > UMBRAL_ARRASTRE_CIERRE) {
            // Evita el click "fantasma" sobre el fondo (ver visit_sheet.js).
            if (ev && ev.cancelable) {
                ev.preventDefault();
            }
            // Termina de bajar con la transición del CSS y recién ahí se cierra.
            panel.style.transform = `translateY(${window.innerHeight}px)`;
            this._cierreTimer = setTimeout(() => this.cerrar(), 200);
        } else {
            panel.style.transform = "";
        }
    }

    detenerArrastre() {
        const panel = this.panelRef && this.panelRef.el;
        if (panel) {
            panel.removeEventListener("touchmove", this._onMoverArrastre);
        }
        window.removeEventListener("touchend", this._onSoltarArrastre);
        window.removeEventListener("touchcancel", this._onSoltarArrastre);
    }

    async preparar() {
        // Todo al día: preguntar antes (no hace falta volver a descargar).
        if (this.datos.frescura === "al_dia") {
            this.local.confirmandoDescarga = true;
            return;
        }
        await this._descargar(this.datos.soloNuevas);
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
            const r = await prepararDia(ormDeLaCola() || this.orm);
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
