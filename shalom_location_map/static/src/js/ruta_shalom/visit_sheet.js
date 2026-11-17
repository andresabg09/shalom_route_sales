/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {ESTADO_ETIQUETA, estadoDesdeStageName, obtenerIdsEtapas} from "./stage_utils";
import {normalizarAccionActWindow} from "./action_utils";
import {cerrarConAnimacion} from "./animacion_utils";
import {abrirNivel, cerrarNivel, marcarRetorno} from "./back_stack";
import {capturarMejorPosicionGps} from "./gps_utils";
import {ClienteForm} from "./cliente_form";
import {OrderScreen} from "./order_screen";
import {conTimeout, iniciarSondeo, sinConexion} from "./red_utils";
import {traerFichaJuego, traerVisita} from "./datos_offline";
import {
    alTerminarEnvio,
    descartar,
    encolar,
    estadoLocalDeVisita,
    esperarResultado,
    estadoOffline,
    iniciarSincronizador,
    pendientesDeVisita,
} from "./sincronizador";

// Modo offline: cuánto se espera la respuesta del servidor antes de
// dejar la acción guardada en el teléfono ("se enviará con señal") y
// seguir. Con buena señal responde mucho antes.
const ESPERA_ACCION_MS = 12000;

// Umbral de arrastre (px) para que soltar la barrita de arriba de la
// hoja cuente como "cerrar" en vez de volver a su posición.
const UMBRAL_ARRASTRE_CIERRE = 90;

// Cada cuánto se pregunta si el carrito de esta visita tiene actividad
// reciente (otro dispositivo con el catálogo abierto), para decidir si
// el botón dice "Tomar pedido" o "Ver en vivo" -- ver
// SHALOM_SEGUNDOS_CARRITO_ACTIVO en fsm_order.py (el umbral real de
// "reciente" lo define el servidor, acá solo se refresca la pregunta
// seguido para que el botón reaccione rápido cuando el otro
// dispositivo se cierra).
const SHALOM_INTERVALO_HEARTBEAT_MS = 2000;
// Modo offline, Fase 0: límite de espera de cada pregunta y tope de la
// espera entre reintentos cuando no hay señal (ver iniciarSondeo()).
const SHALOM_HEARTBEAT_TIMEOUT_MS = 8000;
const SHALOM_HEARTBEAT_TOPE_MS = 30000;

/**
 * Hoja de visita (Fase 2): se abre al tocar una parada en la Lista del
 * detalle de ruta. Muestra los datos del cliente, permite cambiar el
 * estado de la visita, cargar observaciones, acciones rápidas (llamar,
 * Ir con Waze, capturar GPS, ver historial de cotizaciones) y editar
 * los datos del cliente.
 *
 * "Tomar pedido" abre OrderScreen (catálogo + carrito, Fase 3) de
 * pantalla completa por encima de esta hoja. Cuando el pedido se
 * confirma, la visita queda cerrada del lado del servidor
 * (shalom_confirmar_pedido mueve la etapa a Completada) -- por eso
 * pedidoConfirmado() recarga esta tarjeta además de avisar al padre.
 * Si ya hay una cotización vinculada (borrador guardado desde el
 * carrito o confirmada), el botón cambia a "Examinar cotización" y
 * abre directo esa sale.order en vez del catálogo (ver sale_id).
 *
 * Su propio nivel en la pila de navegación (back_stack.js) lo maneja
 * RutaDetalle (quien la abre/cierra, ver abrirVisita()/cerrarVisita()
 * ahí) -- acá adentro, tomarPedido()/cerrarPedido() y abrirEdicion()/
 * cerrarEdicion() manejan los niveles de SUS propios hijos (catálogo,
 * ficha de cliente). Ver el comentario grande de back_stack.js para
 * el mecanismo completo (segundo rediseño de esta sesión: ya no se
 * intercepta el Atrás, se reconstruye la pantalla en cada recargado a
 * partir de lo que el historial del navegador y sessionStorage digan
 * que corresponde).
 *
 * Carga sus propios datos a partir de orderId (no depende de que el
 * padre le pase el objeto completo) para poder abrirse también, más
 * adelante, desde otros lugares de la app (ej. la pestaña Clientes de
 * Fase 4) sin duplicar la lógica de carga.
 */
export class VisitSheet extends Component {
    static template = "shalom_location_map.VisitSheet";
    static components = {OrderScreen, ClienteForm};
    static props = {
        orderId: Number,
        // Lo que sigue en la pila de navegación guardada después de
        // esta visita (ver el comentario grande de back_stack.js) --
        // vacío en la apertura normal (tocar una fila de la Lista);
        // trae algo cuando se está reconstruyendo tras un Atrás/
        // recargado con el catálogo (y opcionalmente el carrito)
        // abierto.
        pilaRestante: {type: Array, optional: true},
        onCerrar: Function,
        onCambio: {type: Function, optional: true},
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        this.sheetRef = useRef("sheet");
        // Modo offline: re-dibuja la hoja cuando cambia la cola (aviso
        // "Pendiente de enviar" / "Necesita atención").
        this.offline = useState(estadoOffline);
        iniciarSincronizador((this.env.services && this.env.services.orm) || this.orm, this.notification);
        const nivelInicial =
            this.props.pilaRestante && this.props.pilaRestante.length
                ? this.props.pilaRestante[0]
                : null;
        this.state = useState({
            cargando: true,
            visita: null,
            panelEstadoAbierto: false,
            editando: false,
            // Auto-abre el catálogo si props.pilaRestante lo indica
            // (ver el comentario grande de back_stack.js) -- OrderScreen
            // recibe a su vez lo que siga después (carrito), ver el
            // template.
            tomandoPedido: !!(nivelInicial && nivelInicial.tipo === "catalogo"),
            pilaRestanteCatalogo:
                nivelInicial && nivelInicial.tipo === "catalogo"
                    ? this.props.pilaRestante.slice(1)
                    : [],
            arrastreY: 0,
            arrastrando: false,
            cerrando: false,
            // "Ver en vivo" (punto C): true si el carrito de esta
            // visita se guardó hace poco -- ver
            // SHALOM_INTERVALO_HEARTBEAT_MS más arriba.
            carritoActivo: false,
            // Selector de "¿Teléfono o celular?" -- solo se muestra si
            // el cliente tiene los dos cargados, ver llamar().
            eligiendoTelefono: false,
        });
        this._onMoverArrastre = (ev) => this.moverArrastre(ev);
        this._onSoltarArrastre = (ev) => this.soltarArrastre(ev);
        this._heartbeatSondeo = null;

        // El nivel de navegación de ESTA hoja (la visita en sí) lo
        // empuja/cierra quien la abre -- RutaDetalle.abrirVisita()/
        // cerrarVisita() -- no acá (ver el comentario grande de
        // back_stack.js: si esta hoja se auto-abre al reconstruir tras
        // un Atrás/recargado, ese nivel ya está representado en lo
        // guardado, empujarlo de nuevo acá duplicaría la entrada). El
        // catálogo y la ficha de cliente, en cambio, son niveles que
        // SÍ maneja esta misma hoja directo -- ver tomarPedido()/
        // cerrarPedido()/abrirEdicion()/cerrarEdicion() más abajo.
        onWillStart(async () => {
            await this.cargar();
            // Reconstrucción tras un Atrás: si el pedido de esta visita ya
            // se confirmó (Atrás desde la pantalla de resultado), no se
            // reabre el catálogo encima de una visita Completada.
            const v = this.state.visita;
            if (this.state.tomandoPedido && v && v.saleId && v.estado === "completado") {
                this.state.tomandoPedido = false;
                cerrarNivel();
            }
        });
        onWillStart(() => this._chequearCarritoActivo());
        this._heartbeatSondeo = iniciarSondeo(() => this._chequearCarritoActivo(), {
            intervaloMs: SHALOM_INTERVALO_HEARTBEAT_MS,
            topeMs: SHALOM_HEARTBEAT_TOPE_MS,
        });

        // Una acción de esta visita que se envió sola (con la hoja
        // abierta): se recarga en silencio para mostrar lo del servidor.
        this._dejarDeOir = alTerminarEnvio((item, respuesta) => {
            // "eliminado": el vendedor lo sacó de la cola desde el panel, la
            // hoja vuelve a mostrar el estado que tenía.
            if (
                item.datos && item.datos.order_id === this.props.orderId &&
                (respuesta.estado === "ok" || respuesta.estado === "eliminado") && !this.state.tomandoPedido
            ) {
                this.cargar({silencioso: true});
            }
        });

        onWillUnmount(() => {
            this.detenerArrastre();
            if (this._heartbeatSondeo) {
                this._heartbeatSondeo.detener();
            }
            this._dejarDeOir();
        });
    }

    /** Pregunta liviana (mismo método que usa la sincronización del
     * catálogo) para saber si otro dispositivo tiene el carrito de
     * esta visita abierto ahora mismo -- solo cambia el texto del
     * botón, no trae ni toca el carrito en sí. Se ignora cualquier
     * error en silencio (sin señal, etc.): el botón se queda como
     * estaba hasta el próximo chequeo. */
    async _chequearCarritoActivo() {
        if (this.state.tomandoPedido) {
            // Mientras el catálogo está abierto ACÁ MISMO, no tiene
            // sentido este chequeo -- se retoma solo al volver a esta
            // hoja (cerrarPedido()).
            return;
        }
        try {
            const resultado = await conTimeout(
                this.orm.call("fsm.order", "shalom_leer_carrito", [
                    [this.props.orderId],
                ]),
                SHALOM_HEARTBEAT_TIMEOUT_MS
            );
            this.state.carritoActivo = resultado.activo;
        } catch (error) {
            // ver docstring de _chequearCarritoActivo. false: que el
            // sondeo espacie el próximo intento (sin señal).
            return false;
        }
        return true;
    }

    async cargar({silencioso = false} = {}) {
        if (!silencioso) {
            this.state.cargando = true;
        }
        try {
            // Modo offline: con señal, del servidor (y queda copia en el
            // teléfono); sin señal, la copia guardada (ver datos_offline.js).
            const {orden, locacion, datosFaltantes} = await traerVisita(this.orm, this.props.orderId);
            this.state.visita = {
                id: orden.id,
                locationId: orden.location_id ? orden.location_id[0] : false,
                nombre: locacion ? locacion.name : orden.location_id ? orden.location_id[1] : "Sin cliente",
                direccion: locacion ? locacion.street : "",
                direccion2: locacion ? locacion.street2 : "",
                telefono: locacion ? locacion.phone : "",
                celular: locacion ? locacion.mobile : "",
                orden: orden.x_cliente_orden_ruta,
                estado: estadoDesdeStageName(orden.stage_name),
                observaciones: orden.x_observaciones_visita || "",
                lat: orden.x_cliente_lat,
                lng: orden.x_cliente_lng,
                saleId: orden.sale_id ? orden.sale_id[0] : false,
                datosFaltantes: [],
                errorObservacion: false,
                juego: null,
            };
            // Para marcar de entrada, en el selector de estado, cuáles
            // opciones van a rechazarse si se eligen -- ver
            // shalom_campos_cliente_faltantes() en fsm_order.py.
            this.state.visita.datosFaltantes = datosFaltantes || [];
            this._aplicarPendientesLocales();
            // Sin await: la ficha de estrellas llega cuando llegue, la hoja no espera.
            this._cargarFichaJuego();
            // Ids de las etapas guardados ya (con copia en el teléfono): así
            // cambiar el estado funciona aunque después se pierda la señal.
            obtenerIdsEtapas(this.orm).catch(() => {});
        } catch (error) {
            this.notification.add(
                sinConexion()
                    ? "Sin señal, y esta visita no está guardada en el teléfono. Usá \"Preparar mi día\" con señal."
                    : "No se pudo cargar la visita.",
                {type: "danger"}
            );
        } finally {
            this.state.cargando = false;
        }
    }

    /** Lo que el vendedor hizo sin señal y todavía no llegó al servidor
     * se muestra igual (estado, nota, GPS), no lo viejo del servidor. */
    _aplicarPendientesLocales() {
        const visita = this.state.visita;
        if (!visita) {
            return;
        }
        for (const item of pendientesDeVisita(this.props.orderId)) {
            if (item.estado !== "pendiente") {
                continue;
            }
            if (item.tipo === "observacion") {
                visita.observaciones = item.datos.texto || "";
            } else if (item.tipo === "gps") {
                visita.lat = item.datos.lat;
                visita.lng = item.datos.lng;
            }
        }
        const local = estadoLocalDeVisita(this.props.orderId);
        if (local && local.estado) {
            visita.estado = local.estado;
        }
    }

    /** Aviso fuerte de la hoja: null, o {error, titulo, texto}. */
    get avisoOffline() {
        const local = estadoLocalDeVisita(this.props.orderId);
        if (!local) {
            return null;
        }
        if (local.conError) {
            return {
                error: true,
                titulo: "Necesita atención: no entró al sistema",
                texto: `${local.error} Tocá la pastilla de conexión (arriba) para reintentar o descartar.`,
            };
        }
        if (local.porEnviar) {
            return {
                error: false,
                titulo: local.pedidoPendiente ? "Pedido pendiente de enviar" : "Pendiente de enviar",
                texto: "Está guardado en este teléfono y se envía solo apenas haya señal. No cierres la app ni borres los datos del navegador.",
            };
        }
        return null;
    }

    /** Con un pedido esperando a enviarse no se puede tomar otro. */
    get pedidoEnCola() {
        const local = estadoLocalDeVisita(this.props.orderId);
        return !!(local && local.pedidoPendiente);
    }

    /**
     * Manda una acción por la cola del teléfono y espera la respuesta un
     * rato. Devuelve "ok" | "pendiente" (guardada, se envía sola con
     * señal) | "error" (el servidor la rechazó: se muestra el motivo y se
     * saca de la cola -- el vendedor lo ve en el momento, igual que antes).
     */
    async _accionPorCola(tipo, datos, {mensajeError, detalle = "", texto = ""}) {
        const cliente = this.state.visita ? this.state.visita.nombre : "";
        const uuid = await encolar(tipo, {order_id: this.props.orderId, ...datos}, {
            etiqueta: cliente,
            // Vista previa en el panel de conexión (no viaja al servidor).
            resumen: {cliente, detalle, texto},
        });
        const respuesta = await esperarResultado(uuid, ESPERA_ACCION_MS);
        if (respuesta.estado === "error") {
            await descartar(uuid);
            this.notification.add(respuesta.error || mensajeError, {type: "danger"});
        }
        return respuesta.estado;
    }

    /** Escalera de estrellas del cliente (ticket típico, 75%, récord)
     * para la ficha. Se pide aparte: si falla, la ficha sale sin ella. */
    async _cargarFichaJuego() {
        if (!this.state.visita || !this.state.visita.locationId) {
            return;
        }
        try {
            this.state.visita.juego = await traerFichaJuego(this.orm, this.state.visita.locationId);
        } catch (error) {
            console.error("shalom: error al leer la ficha del juego", error);
        }
    }

    etiquetaEstado(estado) {
        return ESTADO_ETIQUETA[estado] || estado;
    }

    toggleEstado() {
        this.state.panelEstadoAbierto = !this.state.panelEstadoAbierto;
    }

    async elegirEstado(estado) {
        this.state.panelEstadoAbierto = false;
        if (!this.state.visita || estado === this.state.visita.estado) {
            return;
        }
        // Mismo criterio que _validar_cierre_visita() en fsm_order.py,
        // repetido acá para avisar al toque (sin ida y vuelta al
        // servidor) -- el backend sigue siendo quien realmente lo
        // impide, esto es solo para que no haga falta intentarlo para
        // enterarse.
        if ((estado === "completado" || estado === "no_quiso") && this.state.visita.datosFaltantes.length) {
            this.notification.add(
                `A "${this.state.visita.nombre}" le falta: ` +
                    `${this.state.visita.datosFaltantes.join(", ")}. Completalo desde ` +
                    `"Editar cliente" antes de poder cerrar la visita así.`,
                {type: "warning"}
            );
            return;
        }
        if (estado === "cancelado" && !this.state.visita.observaciones.trim()) {
            // Antes solo se avisaba con un notification -- se reportó
            // que se desvanece muy rápido y el vendedor se queda sin
            // saber por qué no lo dejó. Ahora además queda un mensaje
            // fijo debajo del cuadro de Observaciones (con el cuadro
            // parpadeando en rojo, ver marcarErrorObservacion() /
            // .obs-input.obs-error en el SCSS) hasta que escriba algo.
            this._marcarErrorObservacion();
            return;
        }
        let ids;
        try {
            ids = await obtenerIdsEtapas(this.orm);
        } catch (error) {
            this.notification.add(
                "Sin señal y sin los estados guardados en el teléfono: usá \"Preparar mi día\" con señal.",
                {type: "danger"}
            );
            return;
        }
        const stageId = ids[estado];
        if (!stageId) {
            this.notification.add(
                `No se encontró la etapa "${this.etiquetaEstado(estado)}" configurada en el sistema.`,
                {type: "danger"}
            );
            return;
        }
        // Modo offline: va por la cola del teléfono (cambiar_etapa en
        // shalom_sync_evento.py), que en el servidor hace el MISMO write
        // con el mismo contexto: bypass_order_completed_stage (salida
        // oficial de fieldservice para escribir Completado por código)
        // y shalom_validar_cierre_visita (datos del cliente completos
        // para Completado/No quiso, observación para Cancelado -- ver
        // _validar_cierre_visita en fsm_order.py). Con señal responde
        // al momento como siempre; sin señal queda guardado y se envía
        // solo, y la visita se ve ya con su estado nuevo.
        const resultado = await this._accionPorCola(
            "cambiar_etapa",
            {stage_id: stageId, estado_app: estado},
            {mensajeError: "No se pudo actualizar el estado.", detalle: this.etiquetaEstado(estado)}
        );
        if (resultado === "error") {
            if (estado === "cancelado") {
                this._marcarErrorObservacion();
            }
            return;
        }
        this.state.visita.estado = estado;
        this.notification.add(
            resultado === "ok"
                ? `${this.state.visita.nombre}: ${this.etiquetaEstado(estado)}`
                : `${this.state.visita.nombre}: ${this.etiquetaEstado(estado)} (guardado en el teléfono, se envía con señal)`,
            {type: resultado === "ok" ? "success" : "warning"}
        );
        if (this.props.onCambio) {
            this.props.onCambio();
        }
    }

    /** Marca el aviso fijo (mensaje + cuadro parpadeando en rojo) de
     * "hace falta una nota para Cancelado" -- ver elegirEstado(). */
    _marcarErrorObservacion() {
        // Togglear a false y de nuevo a true (en el siguiente frame)
        // fuerza que la animación CSS del parpadeo se reinicie aunque
        // ya estuviera marcado (ej: el vendedor vuelve a tocar
        // "Cancelado" sin haber escrito nada todavía) -- dejarlo
        // siempre en true no la repite sola.
        this.state.visita.errorObservacion = false;
        requestAnimationFrame(() => {
            if (this.state.visita) {
                this.state.visita.errorObservacion = true;
            }
        });
    }

    async guardarObservaciones(ev) {
        const texto = ev.target.value;
        // Se marca al toque (sin esperar la red): si enseguida se elige
        // "Cancelado", el chequeo de nota ya la ve.
        this.state.visita.observaciones = texto;
        if (texto.trim()) {
            this.state.visita.errorObservacion = false;
        }
        const resultado = await this._accionPorCola("observacion", {texto}, {
            mensajeError: "No se pudo guardar la nota.",
            detalle: "Nota",
            texto: texto ? "«" + texto + "»" : "Nota vacía",
        });
        if (resultado === "ok") {
            this.notification.add("Nota guardada.", {type: "success"});
        } else if (resultado === "pendiente") {
            this.notification.add("Nota guardada en el teléfono: se envía con señal.", {type: "warning"});
        }
    }

    /** Antes solo miraba "teléfono" -- bug real reportado: si el
     * cliente solo tenía celular cargado (o al revés), el botón
     * "Llamar" quedaba inutilizable aunque hubiera un número válido.
     * Ahora: si hay uno solo de los dos, llama directo con ese; si hay
     * los dos, deja elegir con un mini popup (elegirTelefono/
     * elegirCelular) en vez de asumir cuál usar. */
    llamar() {
        const {telefono, celular} = this.state.visita;
        if (telefono && celular) {
            this.state.eligiendoTelefono = true;
            return;
        }
        const numero = telefono || celular;
        if (!numero) {
            this.notification.add("Este cliente no tiene teléfono ni celular guardado.", {type: "warning"});
            return;
        }
        window.open(`tel:${numero}`, "_self");
    }

    elegirTelefono() {
        this.state.eligiendoTelefono = false;
        window.open(`tel:${this.state.visita.telefono}`, "_self");
    }

    elegirCelular() {
        this.state.eligiendoTelefono = false;
        window.open(`tel:${this.state.visita.celular}`, "_self");
    }

    cerrarSelectorTelefono() {
        this.state.eligiendoTelefono = false;
    }

    irConMaps() {
        // Antes abría Google Maps -- cambiado a Waze por decisión
        // explícita del usuario. El nombre del método se deja igual
        // (irConMaps) para no tocar el t-on-click del template por un
        // simple cambio de proveedor de navegación.
        const {lat, lng} = this.state.visita;
        if (!lat && !lng) {
            this.notification.add(
                "Este cliente todavía no tiene coordenadas GPS guardadas.",
                {type: "warning"}
            );
            return;
        }
        window.open(`https://waze.com/ul?ll=${lat},${lng}&navigate=yes`, "_blank");
    }

    async capturarGps() {
        const mensaje =
            `Vas a actualizar la ubicación GPS de "${this.state.visita.nombre}" ` +
            "con tu posición actual.\n\nEsto reemplaza la ubicación guardada del " +
            "cliente. Solo hacé esto si estás físicamente en el local ahora mismo." +
            "\n\n¿Confirmás que querés continuar?";
        // eslint-disable-next-line no-alert
        if (!window.confirm(mensaje)) {
            return;
        }
        if (!navigator.geolocation) {
            this.notification.add("Este navegador no soporta geolocalización.", {
                type: "danger",
            });
            return;
        }

        this.notification.add(
            "Obteniendo tu ubicación GPS... puede tardar unos segundos, no cierres " +
            "esta pantalla.",
            {type: "info"}
        );

        let position;
        try {
            position = await capturarMejorPosicionGps();
        } catch (error) {
            this.notification.add(
                "No se pudo obtener tu ubicación GPS. Verificá el permiso de " +
                "ubicación y que tengas señal.",
                {type: "danger"}
            );
            return;
        }

        const {latitude, longitude} = position.coords;
        // El GPS del teléfono funciona sin datos: la posición se guarda en
        // la cola y llega al servidor (action_capturar_gps) con señal.
        const resultado = await this._accionPorCola(
            "gps",
            {lat: latitude, lng: longitude},
            {mensajeError: "No se pudo guardar la ubicación GPS.", detalle: "Ubicación del cliente"}
        );
        if (resultado === "error") {
            return;
        }
        this.state.visita.lat = latitude;
        this.state.visita.lng = longitude;
        this.notification.add(
            resultado === "ok"
                ? `Ubicación GPS capturada correctamente (precisión: ${Math.round(position.coords.accuracy)}m).`
                : `Ubicación GPS guardada en el teléfono (precisión: ${Math.round(position.coords.accuracy)}m): se envía con señal.`,
            {type: resultado === "ok" ? "success" : "warning"}
        );
        if (this.props.onCambio) {
            this.props.onCambio();
        }
    }

    async verHistorial() {
        if (sinConexion()) {
            this.notification.add("El historial necesita señal.", {type: "warning"});
            return;
        }
        try {
            const resultado = await this.orm.call(
                "fsm.order",
                "action_ver_historial_cotizaciones",
                [[this.props.orderId]]
            );
            // Ver el bloque "CASO APARTE" del comentario grande de
            // back_stack.js -- sin esto, el Atrás real al volver de
            // Ventas cae en el hub en vez de en esta misma visita.
            marcarRetorno();
            this.action.doAction(normalizarAccionActWindow(resultado));
        } catch (error) {
            console.error("shalom: error al abrir historial de cotizaciones", error);
            this.notification.add("No se pudo abrir el historial.", {type: "danger"});
        }
    }

    tomarPedido() {
        abrirNivel({tipo: "catalogo"});
        this.state.tomandoPedido = true;
    }

    cerrarPedido() {
        cerrarNivel();
        this.state.tomandoPedido = false;
    }

    /**
     * CTA cuando la visita YA tiene una cotización vinculada (sale_id):
     * abre esa sale.order directo en vez del catálogo -- reusa
     * action_crear_cotizacion, que ya sabe abrir la existente en vez
     * de crear una nueva si sale_id ya está seteado.
     */
    async examinarCotizacion() {
        if (sinConexion()) {
            this.notification.add("Abrir la cotización en Ventas necesita señal.", {type: "warning"});
            return;
        }
        try {
            const resultado = await this.orm.call("fsm.order", "action_crear_cotizacion", [
                [this.props.orderId],
            ]);
            // Ver el bloque "CASO APARTE" del comentario grande de
            // back_stack.js -- sin esto, el Atrás real al volver de
            // Ventas cae en el hub en vez de en esta misma visita.
            marcarRetorno();
            this.action.doAction(normalizarAccionActWindow(resultado));
        } catch (error) {
            console.error("shalom: error al abrir la cotización", error);
            this.notification.add("No se pudo abrir la cotización.", {type: "danger"});
        }
    }

    /**
     * OrderScreen avisa con esto cuando guardó el carrito como
     * cotización en borrador (botón "Revisar cotización") -- no cierra
     * nada acá (OrderScreen ya se cerró solo antes de navegar a la
     * cotización): solo actualiza el botón de esta tarjeta de "Tomar
     * pedido" a "Examinar cotización" para la próxima vez que se abra.
     */
    async pedidoRevisado() {
        await this.cargar();
        if (this.props.onCambio) {
            this.props.onCambio();
        }
    }

    async pedidoConfirmado() {
        // shalom_confirmar_pedido() ya movió la visita a Completada del
        // lado del servidor -- recargamos para reflejar el estado
        // nuevo en esta misma tarjeta, y avisamos al padre para que
        // refresque la lista/mapa de la ruta por debajo. OrderScreen ya
        // se cerró solo antes de llamar a esto.
        await this.cargar();
        if (this.props.onCambio) {
            this.props.onCambio();
        }
    }

    abrirEdicion() {
        this.state.editando = true;
    }

    cerrarEdicion() {
        this.state.editando = false;
    }

    /**
     * ClienteForm (mismo componente que usa la pestaña Clientes) avisa
     * con esto cuando guardó -- recargamos la visita para reflejar
     * nombre/teléfono/dirección actualizados en esta misma tarjeta.
     */
    async edicionGuardada() {
        this.state.editando = false;
        await this.cargar();
        if (this.props.onCambio) {
            this.props.onCambio();
        }
    }

    // -- Arrastrar la hoja para cerrarla --
    // Al principio (bug ya corregido) el gesto solo arrancaba tocando
    // la barrita de 4px de arriba -- muy poco margen para hacerlo con
    // una sola mano/en movimiento. Después se amplió solo al nombre del
    // cliente (.name-btn). Ahora arranca desde CUALQUIER parte de la
    // hoja, botones incluidos -- pedido explícito: no tiene que haber
    // ningún área bloqueada, así es más simple de usar manejando/en la
    // calle. Esto no rompe el tocar-para-usar cada botón: un toque
    // corto sin desplazamiento nunca llega al umbral de cierre (ver
    // soltarArrastre), así que el click de cada control se sigue
    // disparando normal -- solo un arrastre real cierra la hoja.

    iniciarArrastre(ev) {
        const objetivo = ev.target;
        if (!objetivo.closest) {
            return;
        }
        // Únicos elementos donde SÍ se necesita precisión al tocar sin
        // que un mini-arrastre se interprete como cierre: campos de
        // texto reales y links. Los botones ya no están excluidos (ver
        // comentario arriba).
        const enControlExclusivo = objetivo.closest("input, textarea, a, select");
        if (enControlExclusivo) {
            return;
        }
        // Si la hoja tiene scroll interno y no está en el tope, dejar
        // que el gesto sea scroll normal (no competir con el scroll
        // cuando hay mucho contenido) -- solo cierra arrastrando desde
        // arriba del todo.
        if (this.sheetRef.el && this.sheetRef.el.scrollTop > 0) {
            return;
        }
        this._arrastreInicioY = ev.touches ? ev.touches[0].clientY : ev.clientY;
        this.state.arrastrando = true;
        window.addEventListener("touchmove", this._onMoverArrastre, {passive: true});
        window.addEventListener("touchend", this._onSoltarArrastre);
    }

    moverArrastre(ev) {
        if (!this.state.arrastrando) {
            return;
        }
        const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
        const delta = y - this._arrastreInicioY;
        this.state.arrastreY = Math.max(0, delta);
    }

    soltarArrastre(ev) {
        if (!this.state.arrastrando) {
            return;
        }
        this.state.arrastrando = false;
        const cerrar = this.state.arrastreY > UMBRAL_ARRASTRE_CIERRE;
        this.detenerArrastre();
        if (cerrar) {
            // Evita que el navegador dispare, además del touchend, un
            // click "fantasma" sintético sobre lo que haya debajo del
            // dedo (el backdrop, que también tiene t-on-click.self
            // ="cerrar") -- sin esto, un solo gesto de arrastre podía
            // terminar llamando a cerrar() dos veces y consumiendo dos
            // niveles de historial de un solo toque (bug reportado: la
            // hoja se cerraba Y además saltaba hasta el listado de
            // rutas). El guard de idempotencia en cerrar() es el
            // respaldo por si el navegador ignora este preventDefault.
            if (ev && ev.cancelable) {
                ev.preventDefault();
            }
            // OJO: NO resetear arrastreY a 0 acá -- cerrar() ya pone el
            // valor final (bien afuera de la pantalla). Resetear a 0
            // primero y de inmediato a otro valor en el mismo gesto no
            // se nota mal, pero es innecesario y confunde a quien lea
            // el código.
            this.cerrar();
        } else {
            this.state.arrastreY = 0;
        }
    }

    detenerArrastre() {
        window.removeEventListener("touchmove", this._onMoverArrastre);
        window.removeEventListener("touchend", this._onSoltarArrastre);
    }

    cerrar() {
        // Reusa el MISMO mecanismo que ya existía para el arrastre
        // (transition: transform 0.2s ease en .sheet, ver
        // ruta_shalom.scss) en vez de una animación nueva -- se pidió
        // explícitamente dejar "el recorrido que tenía antes" tal cual
        // estaba, que ya se sentía bien. Empujar arrastreY bien afuera
        // de la pantalla (window.innerHeight, NO el alto propio de la
        // hoja -- con hojas de contenido corto, offsetHeight quedaba
        // chico y el recorrido casi no se notaba) hace que la hoja se
        // deslice sola, aunque el cierre no haya venido de un arrastre
        // (ej. tocar el fondo).
        // cerrarConAnimacion() ya es idempotente sola (revisa
        // state.cerrando) -- reemplaza el guard _cerrando que había acá
        // antes para el mismo propósito (evitar el doble cierre del
        // click fantasma después de un arrastre, ver soltarArrastre).
        this.state.arrastreY = window.innerHeight + 200;
        cerrarConAnimacion(this.state, () => this.props.onCerrar());
    }
}
