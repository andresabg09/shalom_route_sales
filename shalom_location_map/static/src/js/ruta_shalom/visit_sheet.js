/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {ESTADO_ETIQUETA, estadoDesdeStageName, obtenerIdsEtapas} from "./stage_utils";
import {normalizarAccionActWindow} from "./action_utils";
import {cerrarConAnimacion} from "./animacion_utils";
import {ClienteForm} from "./cliente_form";
import {OrderScreen} from "./order_screen";

// Umbral de arrastre (px) para que soltar la barrita de arriba de la
// hoja cuente como "cerrar" en vez de volver a su posición.
const UMBRAL_ARRASTRE_CIERRE = 90;

/**
 * Hoja de visita (Fase 2): se abre al tocar una parada en la Lista del
 * detalle de ruta. Muestra los datos del cliente, permite cambiar el
 * estado de la visita, cargar observaciones, acciones rápidas (llamar,
 * Ir con Maps, capturar GPS, ver historial de cotizaciones) y editar
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
        });
        this._onMoverArrastre = (ev) => this.moverArrastre(ev);
        this._onSoltarArrastre = (ev) => this.soltarArrastre(ev);

        onWillStart(() => this.cargar());
        onWillUnmount(() => this.detenerArrastre());
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
                    "street",
                    "partner_id",
                ]);
                locacion = loc;
            }
            this.state.visita = {
                id: orden.id,
                locationId: orden.location_id ? orden.location_id[0] : false,
                nombre: locacion ? locacion.name : orden.location_id ? orden.location_id[1] : "Sin cliente",
                direccion: locacion ? locacion.street : "",
                telefono: locacion ? locacion.phone : "",
                orden: orden.x_cliente_orden_ruta,
                estado: estadoDesdeStageName(orden.stage_name),
                observaciones: orden.x_observaciones_visita || "",
                lat: orden.x_cliente_lat,
                lng: orden.x_cliente_lng,
                saleId: orden.sale_id ? orden.sale_id[0] : false,
            };
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
            await this.orm.write("fsm.order", [this.props.orderId], {stage_id: stageId}, {
                context: {bypass_order_completed_stage: true},
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
            this.notification.add("No se pudo actualizar el estado.", {type: "danger"});
        }
    }

    async guardarObservaciones(ev) {
        const texto = ev.target.value;
        try {
            await this.orm.write("fsm.order", [this.props.orderId], {
                x_observaciones_visita: texto,
            });
            this.state.visita.observaciones = texto;
            this.notification.add("Nota guardada.", {type: "success"});
        } catch (error) {
            this.notification.add("No se pudo guardar la nota.", {type: "danger"});
        }
    }

    llamar() {
        if (!this.state.visita.telefono) {
            this.notification.add("Este cliente no tiene teléfono guardado.", {type: "warning"});
            return;
        }
        window.open(`tel:${this.state.visita.telefono}`, "_self");
    }

    irConMaps() {
        const {lat, lng} = this.state.visita;
        if (!lat && !lng) {
            this.notification.add(
                "Este cliente todavía no tiene coordenadas GPS guardadas.",
                {type: "warning"}
            );
            return;
        }
        window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, "_blank");
    }

    capturarGps() {
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
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const {latitude, longitude} = position.coords;
                try {
                    await this.orm.call("fsm.order", "action_capturar_gps", [
                        [this.props.orderId],
                        latitude,
                        longitude,
                    ]);
                    this.state.visita.lat = latitude;
                    this.state.visita.lng = longitude;
                    this.notification.add("Ubicación GPS capturada correctamente.", {
                        type: "success",
                    });
                    if (this.props.onCambio) {
                        this.props.onCambio();
                    }
                } catch (error) {
                    this.notification.add("No se pudo guardar la ubicación GPS.", {
                        type: "danger",
                    });
                }
            },
            () => {
                this.notification.add(
                    "No se pudo obtener tu ubicación GPS. Verificá el permiso de ubicación.",
                    {type: "danger"}
                );
            },
            {enableHighAccuracy: true, timeout: 15000, maximumAge: 0}
        );
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
