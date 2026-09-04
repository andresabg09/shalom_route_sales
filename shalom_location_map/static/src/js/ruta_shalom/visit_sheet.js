/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {ESTADO_ETIQUETA, estadoDesdeStageName, obtenerIdsEtapas} from "./stage_utils";
import {normalizarAccionActWindow} from "./action_utils";
import {cerrarConAnimacion} from "./animacion_utils";
import {capturarMejorPosicionGps} from "./gps_utils";
import {ClienteForm} from "./cliente_form";
import {OrderScreen} from "./order_screen";

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
 * El cierre (backdrop, arrastrar la barrita) es 100% estado interno,
 * sin tocar el historial del navegador -- se probó con
 * history.pushState/popstate (nav_historial) para que el botón Atrás
 * de Android cerrara un nivel a la vez, pero eso chocaba con el
 * router propio de Odoo 18 (ver el comentario grande en
 * order_screen.js) y se sacó por completo.
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
        onCerrar: Function,
        onCambio: {type: Function, optional: true},
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        this.sheetRef = useRef("sheet");
        this.state = useState({
            cargando: true,
            visita: null,
            panelEstadoAbierto: false,
            editando: false,
            tomandoPedido: false,
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
        this._heartbeatTimer = null;

        onWillStart(() => this.cargar());
        onWillStart(() => this._chequearCarritoActivo());
        this._heartbeatTimer = setInterval(
            () => this._chequearCarritoActivo(), SHALOM_INTERVALO_HEARTBEAT_MS
        );
        onWillUnmount(() => {
            this.detenerArrastre();
            if (this._heartbeatTimer) {
                clearInterval(this._heartbeatTimer);
            }
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
            const resultado = await this.orm.call("fsm.order", "shalom_leer_carrito", [
                [this.props.orderId],
            ]);
            this.state.carritoActivo = resultado.activo;
        } catch (error) {
            // ver docstring de _chequearCarritoActivo
        }
    }

    async cargar() {
        this.state.cargando = true;
        try {
            const [orden] = await this.orm.read(
                "fsm.order",
                [this.props.orderId],
                [
                    "location_id",
                    "x_cliente_orden_ruta",
                    "stage_name",
                    "x_observaciones_visita",
                    "x_cliente_lat",
                    "x_cliente_lng",
                    "sale_id",
                ]
            );
            let locacion = null;
            if (orden.location_id) {
                const [loc] = await this.orm.read("fsm.location", [orden.location_id[0]], [
                    "name",
                    "phone",
                    "mobile",
                    "street",
                    "street2",
                    "partner_id",
                ]);
                locacion = loc;
            }
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
            };
            // Se pide aparte (no bloquea el resto de la carga si falla)
            // para poder marcar de entrada, en el selector de estado,
            // cuáles opciones van a rechazarse si se eligen -- ver
            // shalom_campos_cliente_faltantes() en fsm_order.py.
            this.state.visita.datosFaltantes = await this.orm.call(
                "fsm.order",
                "shalom_campos_cliente_faltantes",
                [[this.props.orderId]]
            );
        } catch (error) {
            this.notification.add("No se pudo cargar la visita.", {type: "danger"});
        } finally {
            this.state.cargando = false;
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
        const ids = await obtenerIdsEtapas(this.orm);
        const stageId = ids[estado];
        if (!stageId) {
            this.notification.add(
                `No se encontró la etapa "${this.etiquetaEstado(estado)}" configurada en el sistema.`,
                {type: "danger"}
            );
            return;
        }
        try {
            // fieldservice bloquea por defecto escribir stage_id directo a
            // la etapa Completado (pensado para que no se llegue ahí
            // arrastrando una tarjeta en el Kanban nativo, sin pasar por
            // un flujo controlado) -- bypass_order_completed_stage es la
            // salida oficial para escrituras programáticas legítimas
            // como esta. No afecta al resto de las etapas.
            // shalom_validar_cierre_visita activa, SOLO para esta
            // escritura, la validación de fsm_order.py._validar_cierre_visita
            // (datos del cliente completos para Completado/No quiso,
            // observación obligatoria para Cancelado) -- ver el
            // docstring de ese método para el porqué va acotado a un
            // contexto y no aplica también al Kanban nativo de oficina.
            await this.orm.write("fsm.order", [this.props.orderId], {stage_id: stageId}, {
                context: {bypass_order_completed_stage: true, shalom_validar_cierre_visita: true},
            });
            this.state.visita.estado = estado;
            this.notification.add(`${this.state.visita.nombre}: ${this.etiquetaEstado(estado)}`, {
                type: "success",
            });
            if (this.props.onCambio) {
                this.props.onCambio();
            }
        } catch (error) {
            console.error("shalom: error al actualizar estado de fsm.order", error);
            const mensajeServidor = error && error.data && error.data.message;
            this.notification.add(mensajeServidor || "No se pudo actualizar el estado.", {
                type: "danger",
            });
            if (estado === "cancelado") {
                this._marcarErrorObservacion();
            }
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
        try {
            await this.orm.write("fsm.order", [this.props.orderId], {
                x_observaciones_visita: texto,
            });
            this.state.visita.observaciones = texto;
            if (texto.trim()) {
                this.state.visita.errorObservacion = false;
            }
            this.notification.add("Nota guardada.", {type: "success"});
        } catch (error) {
            this.notification.add("No se pudo guardar la nota.", {type: "danger"});
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
        try {
            await this.orm.call("fsm.order", "action_capturar_gps", [
                [this.props.orderId],
                latitude,
                longitude,
            ]);
            this.state.visita.lat = latitude;
            this.state.visita.lng = longitude;
            this.notification.add(
                `Ubicación GPS capturada correctamente (precisión: ` +
                `${Math.round(position.coords.accuracy)}m).`,
                {type: "success"}
            );
            if (this.props.onCambio) {
                this.props.onCambio();
            }
        } catch (error) {
            this.notification.add("No se pudo guardar la ubicación GPS.", {
                type: "danger",
            });
        }
    }

    async verHistorial() {
        try {
            const resultado = await this.orm.call(
                "fsm.order",
                "action_ver_historial_cotizaciones",
                [[this.props.orderId]]
            );
            this.action.doAction(normalizarAccionActWindow(resultado));
        } catch (error) {
            console.error("shalom: error al abrir historial de cotizaciones", error);
            this.notification.add("No se pudo abrir el historial.", {type: "danger"});
        }
    }

    tomarPedido() {
        this.state.tomandoPedido = true;
    }

    cerrarPedido() {
        this.state.tomandoPedido = false;
    }

    /**
     * CTA cuando la visita YA tiene una cotización vinculada (sale_id):
     * abre esa sale.order directo en vez del catálogo -- reusa
     * action_crear_cotizacion, que ya sabe abrir la existente en vez
     * de crear una nueva si sale_id ya está seteado.
     */
    async examinarCotizacion() {
        try {
            const resultado = await this.orm.call("fsm.order", "action_crear_cotizacion", [
                [this.props.orderId],
            ]);
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
