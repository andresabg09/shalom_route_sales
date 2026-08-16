/** @odoo-module **/

import {Component, onWillStart, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {ESTADO_ETIQUETA, estadoDesdeStageName, obtenerIdsEtapas} from "./stage_utils";

/**
 * Hoja de visita (Fase 2): se abre al tocar una parada en la Lista del
 * detalle de ruta. Muestra los datos del cliente, permite cambiar el
 * estado de la visita, cargar observaciones, acciones rápidas (llamar,
 * Ir con Maps, capturar GPS, ver historial de cotizaciones) y editar
 * los datos del cliente.
 *
 * "Tomar pedido" (catálogo + carrito) es Fase 3: el botón ya está acá
 * porque es donde va a vivir, pero todavía solo muestra un aviso.
 *
 * Carga sus propios datos a partir de orderId (no depende de que el
 * padre le pase el objeto completo) para poder abrirse también, más
 * adelante, desde otros lugares de la app (ej. la pestaña Clientes de
 * Fase 4) sin duplicar la lógica de carga.
 */
export class VisitSheet extends Component {
    static template = "shalom_location_map.VisitSheet";
    static props = {
        orderId: Number,
        onCerrar: Function,
        onCambio: {type: Function, optional: true},
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        this.state = useState({
            cargando: true,
            visita: null,
            panelEstadoAbierto: false,
            editando: false,
            edicion: {name: "", phone: "", street: ""},
        });
        onWillStart(() => this.cargar());
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
            // action_ver_historial_cotizaciones() devuelve view_mode como
            // string ("list,form") -- eso alcanza cuando la acción la
            // dispara un botón nativo (Odoo la completa solo), pero
            // action.doAction() llamado directo desde JS necesita el
            // campo "views" ya armado como lista de [id, tipo], si no
            // revienta con "Cannot read properties of undefined
            // (reading 'map')".
            const accion = {
                ...resultado,
                views: (resultado.view_mode || "list,form")
                    .split(",")
                    .map((modo) => [false, modo.trim()]),
            };
            this.action.doAction(accion);
        } catch (error) {
            console.error("shalom: error al abrir historial de cotizaciones", error);
            this.notification.add("No se pudo abrir el historial.", {type: "danger"});
        }
    }

    tomarPedido() {
        this.notification.add("El carrito de pedidos está en construcción (Fase 3).", {
            type: "info",
        });
    }

    abrirEdicion() {
        this.state.edicion = {
            name: this.state.visita.nombre,
            phone: this.state.visita.telefono,
            street: this.state.visita.direccion,
        };
        this.state.editando = true;
    }

    cerrarEdicion() {
        this.state.editando = false;
    }

    async guardarEdicion() {
        const nombre = this.state.edicion.name.trim();
        if (!nombre) {
            this.notification.add("El nombre no puede estar vacío.", {type: "warning"});
            return;
        }
        try {
            await this.orm.write("fsm.location", [this.state.visita.locationId], {
                name: nombre,
                phone: this.state.edicion.phone.trim(),
                street: this.state.edicion.street.trim(),
            });
            this.state.visita.nombre = nombre;
            this.state.visita.telefono = this.state.edicion.phone.trim();
            this.state.visita.direccion = this.state.edicion.street.trim();
            this.state.editando = false;
            this.notification.add("Datos del cliente actualizados.", {type: "success"});
            if (this.props.onCambio) {
                this.props.onCambio();
            }
        } catch (error) {
            this.notification.add("No se pudieron guardar los datos.", {type: "danger"});
        }
    }

    cerrar() {
        this.props.onCerrar();
    }
}
