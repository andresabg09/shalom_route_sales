/** @odoo-module **/

import {Component, onWillStart, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {cerrarConAnimacion} from "./animacion_utils";
import {capturarMejorPosicionGps} from "./gps_utils";

/**
 * Formulario ampliado de cliente (Fase 4, ronda de feedback): un solo
 * componente reutilizado tanto por "Editar cliente" (hoja de visita)
 * como por "Alta rápida" (pestaña Clientes, botón "+") -- antes cada
 * uno tenía su propio formulario mínimo (nombre/teléfono/dirección)
 * duplicado; ahora los dos usan este, con:
 *
 * - Nombre, dirección, teléfono (ya existían, en fsm.location).
 * - RUC, celular, correo (nuevos -- van al contacto, res.partner, con
 *   sus campos nativos vat/mobile/email; no se agregó ninguna columna
 *   nueva al modelo).
 * - Foto de la entrada del local (nueva -- campo de imagen nativo de
 *   res.partner, image_1920; tampoco requiere modificar el modelo).
 * - Ruta + "va después de" (nuevos, OPCIONALES): un vendedor puede
 *   tener varias rutas y ve TODOS sus clientes juntos en la pestaña
 *   Clientes, no solo los de la ruta que está atendiendo -- por eso
 *   hace falta poder elegir a cuál pertenece. Si no se toca ninguno de
 *   los dos, el cliente queda sin ruta (alta rápida sigue siendo "lo
 *   carga oficina después" por defecto). Si se elige "va después de
 *   X", el backend (shalom_asignar_ruta_y_orden) corre +1 el orden de
 *   los que quedaban en esa posición o después, para que el nuevo
 *   entre sin pisar a nadie.
 * - "Registrar coordenadas" (nuevo): captura el GPS del dispositivo y
 *   lo guarda en el cliente -- en modo editar, se escribe al toque
 *   (shalom_actualizar_gps); en modo crear, se manda junto con el
 *   resto al confirmar (todavía no existe el registro).
 */

const RUTA_SIN_ASIGNAR = "sin_asignar";
const CLIENTE_ANTERIOR_NINGUNO = "ninguno";

export class ClienteForm extends Component {
    static template = "shalom_location_map.ClienteForm";
    static props = {
        modo: String, // 'crear' | 'editar'
        // Sin "type": en modo 'crear' se pasa null/false (todavía no
        // existe el registro); Owl valida el tipo si se declara, y acá
        // el valor legítimamente cambia de forma según el modo.
        locationId: {optional: true},
        onGuardado: Function,
        onCancelar: Function,
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            cargando: this.props.modo === "editar",
            guardando: false,
            partnerId: false,
            campos: {name: "", phone: "", mobile: "", email: "", vat: "", street: ""},
            rutas: [],
            rutaId: RUTA_SIN_ASIGNAR,
            rutaMenuAbierto: false,
            busquedaRuta: "",
            clientesDeRuta: [],
            cargandoClientesDeRuta: false,
            clienteAnteriorId: CLIENTE_ANTERIOR_NINGUNO,
            clienteAnteriorMenuAbierto: false,
            busquedaClienteAnterior: "",
            posicionEditada: false,
            fotoPreviewUrl: false,
            fotoBase64: false,
            lat: false,
            lng: false,
            formModificado: false,
            confirmandoSalida: false,
            cerrando: false,
        });

        onWillStart(async () => {
            await this.cargarRutas();
            if (this.props.modo === "editar") {
                await this.cargarCliente();
            }
        });
    }

    /** Cualquier cambio en un campo pasa por acá -- controla si hace
     * falta preguntar antes de salir sin guardar. */
    marcarModificado() {
        this.state.formModificado = true;
    }

    async cargarRutas() {
        this.state.rutas = await this.orm.call("fsm.person", "shalom_mis_rutas", []);
    }

    async cargarCliente() {
        this.state.cargando = true;
        try {
            const [loc] = await this.orm.read(
                "fsm.location",
                [this.props.locationId],
                [
                    "name",
                    "phone",
                    "street",
                    "partner_id",
                    "fsm_route_id",
                    "partner_latitude",
                    "partner_longitude",
                ]
            );
            this.state.campos.name = loc.name || "";
            this.state.campos.phone = loc.phone || "";
            this.state.campos.street = loc.street || "";
            this.state.rutaId = loc.fsm_route_id ? loc.fsm_route_id[0] : RUTA_SIN_ASIGNAR;
            // Se cargan las coordenadas YA guardadas del cliente -- son
            // las que este mismo formulario va a reenviar en guardar()
            // junto con el resto de los datos (ver el comentario grande
            // ahí) para que un geo_localize() automático por dirección
            // no las pise en silencio. Si no se cargaran acá, cualquier
            // cliente al que no se le toque el GPS en esta sesión
            // quedaría con partner_latitude/longitude en 0 al guardar.
            this.state.lat = loc.partner_latitude || false;
            this.state.lng = loc.partner_longitude || false;

            if (loc.partner_id) {
                this.state.partnerId = loc.partner_id[0];
                const [partner] = await this.orm.read(
                    "res.partner",
                    [loc.partner_id[0]],
                    ["vat", "mobile", "email", "image_1920"]
                );
                this.state.campos.vat = partner.vat || "";
                this.state.campos.mobile = partner.mobile || "";
                this.state.campos.email = partner.email || "";
                if (partner.image_1920) {
                    this.state.fotoPreviewUrl = `/web/image/res.partner/${loc.partner_id[0]}/image_256`;
                }
            }

            if (this.state.rutaId !== RUTA_SIN_ASIGNAR) {
                await this.cargarClientesDeRuta(this.state.rutaId);
            }
        } catch (error) {
            this.notification.add("No se pudo cargar la ficha del cliente.", {
                type: "danger",
            });
        } finally {
            this.state.cargando = false;
        }
    }

    async cargarClientesDeRuta(rutaId) {
        this.state.cargandoClientesDeRuta = true;
        try {
            const clientes = await this.orm.searchRead(
                "fsm.location",
                [["fsm_route_id", "=", rutaId]],
                ["name", "x_orden_ruta"],
                {order: "x_orden_ruta asc"}
            );
            // El cliente que se está editando no puede ir "después de
            // sí mismo".
            this.state.clientesDeRuta = clientes.filter(
                (c) => c.id !== this.props.locationId
            );
        } finally {
            this.state.cargandoClientesDeRuta = false;
        }
    }

    get rutasFiltradas() {
        const texto = this.state.busquedaRuta.trim().toLowerCase();
        if (!texto) {
            return this.state.rutas;
        }
        return this.state.rutas.filter((r) => r.name.toLowerCase().includes(texto));
    }

    get etiquetaRutaActual() {
        if (this.state.rutaId === RUTA_SIN_ASIGNAR) {
            return "Sin asignar";
        }
        const ruta = this.state.rutas.find((r) => r.id === this.state.rutaId);
        return ruta ? ruta.name : "Sin asignar";
    }

    toggleMenuRuta() {
        this.state.rutaMenuAbierto = !this.state.rutaMenuAbierto;
        this.state.busquedaRuta = "";
    }

    async elegirRuta(rutaId) {
        this.state.rutaId = rutaId;
        this.state.rutaMenuAbierto = false;
        this.state.busquedaRuta = "";
        this.state.clienteAnteriorId = CLIENTE_ANTERIOR_NINGUNO;
        this.state.posicionEditada = true;
        this.marcarModificado();
        if (rutaId === RUTA_SIN_ASIGNAR) {
            this.state.clientesDeRuta = [];
        } else {
            await this.cargarClientesDeRuta(rutaId);
        }
    }

    get clientesDeRutaFiltrados() {
        const texto = this.state.busquedaClienteAnterior.trim().toLowerCase();
        if (!texto) {
            return this.state.clientesDeRuta;
        }
        return this.state.clientesDeRuta.filter((c) =>
            c.name.toLowerCase().includes(texto)
        );
    }

    get etiquetaClienteAnteriorActual() {
        if (this.state.clienteAnteriorId === CLIENTE_ANTERIOR_NINGUNO) {
            return "Primero de la ruta";
        }
        const cliente = this.state.clientesDeRuta.find(
            (c) => c.id === this.state.clienteAnteriorId
        );
        return cliente ? cliente.name : "Primero de la ruta";
    }

    toggleMenuClienteAnterior() {
        if (this.state.rutaId === RUTA_SIN_ASIGNAR) {
            return;
        }
        this.state.clienteAnteriorMenuAbierto = !this.state.clienteAnteriorMenuAbierto;
        this.state.busquedaClienteAnterior = "";
    }

    elegirClienteAnterior(clienteId) {
        this.state.clienteAnteriorId = clienteId;
        this.state.clienteAnteriorMenuAbierto = false;
        this.state.busquedaClienteAnterior = "";
        this.state.posicionEditada = true;
        this.marcarModificado();
    }

    async onFotoSeleccionada(ev) {
        const archivo = ev.target.files && ev.target.files[0];
        if (!archivo) {
            return;
        }
        const dataUrl = await new Promise((resolve, reject) => {
            const lector = new FileReader();
            lector.onload = () => resolve(lector.result);
            lector.onerror = reject;
            lector.readAsDataURL(archivo);
        });
        this.state.fotoPreviewUrl = dataUrl;
        // res.partner.image_1920 espera el base64 sin el prefijo
        // "data:image/...;base64,".
        this.state.fotoBase64 = dataUrl.split(",")[1] || false;
        this.marcarModificado();
    }

    async capturarGps() {
        const mensaje =
            `Vas a guardar tu posición actual como la ubicación de "${
                this.state.campos.name || "este cliente"
            }".\n\n¿Confirmás que estás físicamente en el local ahora mismo?`;
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
        this.state.lat = latitude;
        this.state.lng = longitude;
        if (this.props.modo === "editar" && this.props.locationId) {
            try {
                await this.orm.call("fsm.location", "shalom_actualizar_gps", [
                    [this.props.locationId],
                    latitude,
                    longitude,
                ]);
                this.notification.add(
                    `Coordenadas guardadas (precisión: ` +
                    `${Math.round(position.coords.accuracy)}m).`,
                    {type: "success"}
                );
            } catch (error) {
                this.notification.add("No se pudieron guardar las coordenadas.", {
                    type: "danger",
                });
            }
        } else {
            this.marcarModificado();
            this.notification.add(
                "Coordenadas capturadas -- se guardan al crear el cliente.",
                {type: "success"}
            );
        }
    }

    async guardar() {
        const nombre = this.state.campos.name.trim();
        if (!nombre) {
            this.notification.add("El nombre comercial es obligatorio.", {type: "warning"});
            return;
        }
        this.state.guardando = true;
        try {
            const rutaId = this.state.rutaId === RUTA_SIN_ASIGNAR ? false : this.state.rutaId;
            const clienteAnteriorId =
                this.state.clienteAnteriorId === CLIENTE_ANTERIOR_NINGUNO
                    ? false
                    : this.state.clienteAnteriorId;

            if (this.props.modo === "crear") {
                await this.orm.call("fsm.location", "shalom_crear_cliente_rapido", [
                    nombre,
                    this.state.campos.phone.trim() || false,
                    this.state.campos.street.trim() || false,
                    this.state.campos.vat.trim() || false,
                    this.state.campos.mobile.trim() || false,
                    this.state.campos.email.trim() || false,
                    this.state.fotoBase64 || false,
                    this.state.lat || false,
                    this.state.lng || false,
                    rutaId,
                    clienteAnteriorId,
                ]);
                this.notification.add(`Cliente "${nombre}" creado.`, {type: "success"});
            } else {
                // OJO -- causa real del bug de "coordenadas que se
                // borran/cambian solas al guardar", reportado en
                // producción: este write() manda `street`, y
                // fieldservice_geoengine dispara un geo_localize()
                // automático (por dirección) apenas detecta un campo de
                // dirección en un write -- sin importar que ya hubiera
                // coordenadas buenas guardadas (ej. recién capturadas a
                // mano con el botón de arriba). El geocoder externo
                // puede pisarlas con un resultado peor, o vaciarlas si
                // no encuentra nada -- y como el resultado no siempre
                // queda en 0 (a veces es simplemente una coordenada mala
                // pero no vacía), el fix de geo_localize() en
                // fsm_location.py (que solo restaura si quedó en 0) no
                // alcanza a cubrir este caso. La solución acá: mandar
                // SIEMPRE partner_latitude/partner_longitude en esta
                // misma escritura, con el valor que ya tenemos en
                // memoria (this.state.lat/lng -- cargado al abrir el
                // formulario, o actualizado por capturarGps() más
                // arriba). Al venir explícitas en el mismo write(), no
                // quedan "vacías" para que el geocoder automático las
                // toque.
                await this.orm.write("fsm.location", [this.props.locationId], {
                    name: nombre,
                    phone: this.state.campos.phone.trim() || false,
                    street: this.state.campos.street.trim() || false,
                    partner_latitude: this.state.lat || 0,
                    partner_longitude: this.state.lng || 0,
                });
                if (this.state.partnerId) {
                    const valoresPartner = {
                        vat: this.state.campos.vat.trim() || false,
                        mobile: this.state.campos.mobile.trim() || false,
                        email: this.state.campos.email.trim() || false,
                    };
                    if (this.state.fotoBase64) {
                        valoresPartner.image_1920 = this.state.fotoBase64;
                    }
                    await this.orm.write("res.partner", [this.state.partnerId], valoresPartner);
                }
                if (this.state.posicionEditada) {
                    await this.orm.call("fsm.location", "shalom_asignar_ruta_y_orden", [
                        [this.props.locationId],
                        rutaId,
                        clienteAnteriorId,
                    ]);
                }
                this.notification.add("Datos del cliente actualizados.", {type: "success"});
            }
            cerrarConAnimacion(this.state, () => this.props.onGuardado());
        } catch (error) {
            console.error("shalom: error al guardar cliente", error);
            const mensajeServidor = error && error.data && error.data.message;
            this.notification.add(
                mensajeServidor || "No se pudo guardar el cliente.",
                {type: "danger"}
            );
        } finally {
            this.state.guardando = false;
        }
    }

    // -- Salir del formulario (flecha "←" de arriba y botón Cancelar
    // de abajo van los dos por acá) --

    /**
     * Si se tocó algo sin guardar, no cierra directo: muestra un
     * aviso propio primero (mismo patrón que "Revisar cotización" en
     * el carrito) -- para no perder cambios por un toque accidental.
     */
    intentarCancelar() {
        if (!this.state.formModificado) {
            this.cancelar();
            return;
        }
        this.state.confirmandoSalida = true;
    }

    seguirEditando() {
        this.state.confirmandoSalida = false;
    }

    confirmarSalirSinGuardar() {
        this.state.confirmandoSalida = false;
        this.cancelar();
    }

    cancelar() {
        cerrarConAnimacion(this.state, () => this.props.onCancelar());
    }
}
