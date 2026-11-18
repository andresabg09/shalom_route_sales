/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {cerrarConAnimacion} from "./animacion_utils";
import {abrirNivel, cerrarNivel} from "./back_stack";
import {capturarMejorPosicionGps} from "./gps_utils";
import {normalizarBusqueda} from "./busqueda_utils";
import {achicarFoto, crearCliente, editarCliente, esProvisorio, gpsCliente} from "./clientes_offline";
import {leerConRespaldo, traerClientesDeRuta, traerFichaClienteForm, traerMisRutas} from "./datos_offline";
import {sinConexion} from "./red_utils";
import {iniciarSincronizador} from "./sincronizador";

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
 *
 * Un solo componente reusado desde cuatro lugares (hoja de visita,
 * pestaña Clientes, popup del pin en el mapa de RutaDetalle, banner de
 * OrderScreen) -- por eso se registra SOLO acá en la pila de
 * navegación (ver setup()/cancelar()/guardar() más abajo, y
 * back_stack.js para el mecanismo completo): el Atrás de Android
 * cierra el formulario en cualquiera de los cuatro casos sin que cada
 * pantalla que lo abre tenga que saber nada de esto. A diferencia de
 * otros niveles (visita, catálogo), este SÍ puede auto-registrarse en
 * su propio setup()/cierre sin riesgo de duplicar una entrada -- nunca
 * hace falta "reabrirlo solo" tras un recargado: si Odoo recarga la
 * app mientras este formulario está abierto, es porque el Atrás que
 * disparó ese recargado es justamente el que lo está cerrando (no
 * tiene hijos propios, siempre es el nivel más profundo).
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
        // Para "Crear cliente 'xxx'" desde la búsqueda: nombre ya escrito.
        nombreInicial: {optional: true, type: String},
        onGuardado: Function,
        onCancelar: Function,
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        // Guardar va por la cola: que esté andando aunque el formulario se
        // abra desde Administración o directo en la pestaña Clientes.
        iniciarSincronizador((this.env.services && this.env.services.orm) || this.orm, this.notification);
        this.state = useState({
            cargando: this.props.modo === "editar",
            guardando: false,
            partnerId: false,
            campos: {
                name: this.props.nombreInicial || "",
                nombreContacto: "",
                phone: "",
                mobile: "",
                email: "",
                vat: "",
                street: "",
                street2: "",
            },
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
            // Distribuidora (Fase 6B): solo el dueño ve la casilla (el
            // servidor decide, ver fsm.location.shalom_puede_marcar_
            // distribuidora) y solo en "Editar cliente".
            puedeMarcarDistribuidora: false,
            esDistribuidora: false,
            esDistribuidoraOriginal: false,
            formModificado: false,
            // Crear: la ruta es obligatoria (es la que le crea la visita
            // para hacerle el pedido). true = "Guardar" sin ruta.
            faltaRuta: false,
            confirmandoSalida: false,
            cerrando: false,
        });

        onWillStart(async () => {
            await this.cargarRutas();
            if (this.props.modo === "editar") {
                await Promise.all([this.cargarPermisoDistribuidora(), this.cargarCliente()]);
            }
        });

        // Se registra como un nivel de la pila de navegación apenas se
        // monta -- ver cancelar()/guardar() más abajo, los dos únicos
        // caminos de cierre intencional, y el comentario grande de
        // back_stack.js. OJO -- ya NO es posible interceptar el Atrás
        // real para mostrar el aviso de "salir sin guardar" (no hay
        // forma de "cancelar" una navegación real del navegador, ver
        // ese mismo comentario grande): si hay cambios sin guardar y
        // se sale por Atrás en vez del botón "←"/Cancelar propio, se
        // pierden sin aviso -- mismo criterio ya aceptado para el
        // carrito de OrderScreen.
        abrirNivel({tipo: "cliente_form"});
        this._nivelCerrado = false;
        onWillUnmount(() => this._cerrarMiNivel());
    }

    /** Saca este nivel de la pila de navegación -- una sola vez, sin
     * importar cuántos caminos de cierre disparen esto (cancelar(),
     * guardar(), el respaldo de onWillUnmount). */
    _cerrarMiNivel() {
        if (this._nivelCerrado) {
            return;
        }
        this._nivelCerrado = true;
        cerrarNivel();
    }

    /** Cualquier cambio en un campo pasa por acá -- controla si hace
     * falta preguntar antes de salir sin guardar. */
    marcarModificado() {
        this.state.formModificado = true;
    }

    /** Sin señal también: todo lo que lee el formulario tiene copia en el
     * teléfono ("Preparar mi día", ver datos_offline.js). */
    async cargarRutas() {
        try {
            this.state.rutas = (await traerMisRutas(this.orm)) || [];
        } catch (error) {
            this.state.rutas = [];
            this.notification.add("Sin señal y sin tus rutas guardadas en el teléfono. Usá \"Preparar mi día\" con señal.", {type: "warning"});
        }
    }

    get sinSenal() {
        return sinConexion();
    }

    /** ¿Este usuario puede marcar distribuidoras? Si la pregunta falla,
     * simplemente no se ofrece la casilla. */
    async cargarPermisoDistribuidora() {
        try {
            this.state.puedeMarcarDistribuidora = !!(await leerConRespaldo("puede_distribuidora", () =>
                this.orm.call("fsm.location", "shalom_puede_marcar_distribuidora", [])
            ));
        } catch (error) {
            this.state.puedeMarcarDistribuidora = false;
        }
    }

    async cargarCliente() {
        this.state.cargando = true;
        try {
            const loc = await traerFichaClienteForm(this.orm, this.props.locationId);
            this.state.esDistribuidora = !!loc.x_es_distribuidora;
            this.state.esDistribuidoraOriginal = !!loc.x_es_distribuidora;
            this.state.campos.name = loc.name || "";
            this.state.campos.phone = loc.phone || "";
            this.state.campos.street = loc.street || "";
            this.state.campos.street2 = loc.street2 || "";
            this.state.campos.vat = loc.vat || "";
            this.state.campos.mobile = loc.mobile || "";
            this.state.campos.email = loc.email || "";
            this.state.campos.nombreContacto = loc.x_nombre_contacto || "";
            this.state.rutaId = loc.fsm_route_id ? loc.fsm_route_id[0] : RUTA_SIN_ASIGNAR;
            this.state.lat = loc.partner_latitude || false;
            this.state.lng = loc.partner_longitude || false;
            if (loc.partner_id) {
                this.state.partnerId = loc.partner_id[0];
                if (loc.tiene_foto) {
                    this.state.fotoPreviewUrl = `/web/image/res.partner/${loc.partner_id[0]}/image_256`;
                }
            }
            if (this.state.rutaId !== RUTA_SIN_ASIGNAR) {
                await this.cargarClientesDeRuta(this.state.rutaId);
            }
        } catch (error) {
            this.notification.add(
                sinConexion()
                    ? "Sin señal, y este cliente no está guardado en el teléfono. Usá \"Preparar mi día\" con señal."
                    : "No se pudo cargar la ficha del cliente.",
                {type: "danger"}
            );
        } finally {
            this.state.cargando = false;
        }
    }

    async cargarClientesDeRuta(rutaId) {
        this.state.cargandoClientesDeRuta = true;
        try {
            const clientes = await traerClientesDeRuta(this.orm, rutaId);
            // El cliente que se está editando no puede ir "después de
            // sí mismo".
            this.state.clientesDeRuta = clientes.filter(
                (c) => c.id !== this.props.locationId
            );
        } catch (error) {
            this.state.clientesDeRuta = [];
        } finally {
            this.state.cargandoClientesDeRuta = false;
        }
    }

    get rutasFiltradas() {
        const texto = normalizarBusqueda(this.state.busquedaRuta).trim();
        if (!texto) {
            return this.state.rutas;
        }
        return this.state.rutas.filter((r) => normalizarBusqueda(r.name).includes(texto));
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
        this.state.faltaRuta = false;
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
        const texto = normalizarBusqueda(this.state.busquedaClienteAnterior).trim();
        if (!texto) {
            return this.state.clientesDeRuta;
        }
        return this.state.clientesDeRuta.filter((c) =>
            normalizarBusqueda(c.name).includes(texto)
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
        // Achicada (1280 px, JPEG 80 %): pesa mucho menos en datos móviles
        // y en la cola sin señal. res.partner.image_1920 espera el base64
        // sin el prefijo "data:image/...;base64,".
        const chica = await achicarFoto(dataUrl);
        this.state.fotoPreviewUrl = chica.dataUrl;
        this.state.fotoBase64 = chica.base64;
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
            // Por la cola: con señal se guarda al momento; sin señal queda
            // en el teléfono y se envía sola.
            const r = await gpsCliente(this.props.locationId, latitude, longitude, this.state.campos.name);
            if (r.estado === "error") {
                this.notification.add(r.error || "No se pudieron guardar las coordenadas.", {type: "danger"});
            } else {
                this.notification.add(
                    r.estado === "ok"
                        ? `Coordenadas guardadas (precisión: ${Math.round(position.coords.accuracy)}m).`
                        : "Coordenadas guardadas en el teléfono: se envían solas cuando vuelva la señal.",
                    {type: "success"}
                );
            }
        } else {
            this.marcarModificado();
            this.notification.add(
                "Coordenadas capturadas -- se guardan al crear el cliente.",
                {type: "success"}
            );
        }
    }

    /** Guardar: crear y editar van por la cola del teléfono (con señal se
     * guarda al momento, como antes; sin señal queda guardado en el
     * teléfono y se envía solo, ver clientes_offline.js). */
    async guardar() {
        const nombre = this.state.campos.name.trim();
        if (!nombre) {
            this.notification.add("El nombre comercial es obligatorio.", {type: "warning"});
            return;
        }
        const rutaId = this.state.rutaId === RUTA_SIN_ASIGNAR ? false : this.state.rutaId;
        if (this.props.modo === "crear" && !rutaId) {
            this.state.faltaRuta = true;
            this.notification.add("Elegí la ruta: es la que le crea la visita para hacerle el pedido.", {type: "warning"});
            return;
        }
        const clienteAnteriorId =
            this.state.clienteAnteriorId === CLIENTE_ANTERIOR_NINGUNO ? false : this.state.clienteAnteriorId;
        const ruta = this.state.rutas.find((r) => r.id === rutaId);
        const anterior = this.state.clientesDeRuta.find((c) => c.id === clienteAnteriorId);
        const texto = (valor) => (valor || "").trim() || false;
        this.state.guardando = true;
        try {
            if (this.props.modo === "crear") {
                const resultado = await crearCliente({
                    name: nombre,
                    phone: texto(this.state.campos.phone),
                    street: texto(this.state.campos.street),
                    street2: texto(this.state.campos.street2),
                    vat: texto(this.state.campos.vat),
                    mobile: texto(this.state.campos.mobile),
                    email: texto(this.state.campos.email),
                    nombre_contacto: texto(this.state.campos.nombreContacto),
                    image_1920: this.state.fotoBase64 || false,
                    lat: this.state.lat || false,
                    lng: this.state.lng || false,
                    route_id: rutaId,
                    route_name: ruta ? ruta.name : "",
                    cliente_anterior_id: clienteAnteriorId,
                    parada_local: anterior ? (anterior.x_orden_ruta || 0) + 1 : 1,
                });
                if (resultado.estado === "error") {
                    this.notification.add(resultado.error || "No se pudo crear el cliente.", {type: "danger"});
                    return;
                }
                const creado = {
                    ...resultado,
                    nombre,
                    rutaNombre: ruta ? ruta.name : "",
                    anteriorNombre: anterior ? anterior.name : "",
                };
                this._cerrarMiNivel();
                cerrarConAnimacion(this.state, () => this.props.onGuardado(creado));
                return;
            }
            const valores = {
                name: nombre,
                phone: texto(this.state.campos.phone),
                street: texto(this.state.campos.street),
                street2: texto(this.state.campos.street2),
                lat: this.state.lat || 0,
                lng: this.state.lng || 0,
            };
            if (this.state.partnerId || esProvisorio(this.props.locationId)) {
                Object.assign(valores, {
                    vat: texto(this.state.campos.vat),
                    mobile: texto(this.state.campos.mobile),
                    email: texto(this.state.campos.email),
                    nombre_contacto: texto(this.state.campos.nombreContacto),
                });
                if (this.state.fotoBase64) {
                    valores.image_1920 = this.state.fotoBase64;
                }
            }
            if (this.state.puedeMarcarDistribuidora && this.state.esDistribuidora !== this.state.esDistribuidoraOriginal) {
                valores.es_distribuidora = this.state.esDistribuidora;
            }
            if (this.state.posicionEditada) {
                valores.posicion = {route_id: rutaId, route_name: ruta ? ruta.name : "", cliente_anterior_id: clienteAnteriorId};
            }
            const r = await editarCliente(this.props.locationId, valores, nombre);
            if (r.estado === "error") {
                this.notification.add(r.error || "No se pudo guardar el cliente.", {type: "danger"});
                return;
            }
            this.notification.add(
                r.estado === "ok"
                    ? "Datos del cliente actualizados."
                    : "Guardado en el teléfono: se envía solo cuando vuelva la señal.",
                {type: "success"}
            );
            this._cerrarMiNivel();
            cerrarConAnimacion(this.state, () =>
                this.props.onGuardado({estado: r.estado, locationId: this.props.locationId, nombre})
            );
        } catch (error) {
            console.error("shalom: error al guardar cliente", error);
            const mensajeServidor = error && error.data && error.data.message;
            this.notification.add(mensajeServidor || "No se pudo guardar el cliente.", {type: "danger"});
        } finally {
            this.state.guardando = false;
        }
    }

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
        this._cerrarMiNivel();
        cerrarConAnimacion(this.state, () => this.props.onCancelar());
    }
}
