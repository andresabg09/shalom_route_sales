/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {ClienteForm} from "./cliente_form";
import {TemaSelector} from "./tema_selector";
import {normalizarBusqueda} from "./busqueda_utils";
import {traerMisClientes} from "./datos_offline";
import {alTerminarEnvio, estadoOffline, iniciarSincronizador} from "./sincronizador";

/**
 * Pestaña "Clientes" (Fase 4): directorio de fsm.location asignadas al
 * vendedor logueado (vía sus rutas -- puede tener más de una, por eso
 * cada tarjeta muestra a cuál pertenece cada cliente), con búsqueda y
 * acciones rápidas (llamar / Maps). Tocar un cliente abre el mismo
 * ClienteForm (modo "editar") que usa "Editar cliente" en la hoja de
 * visita; el botón flotante "+" lo abre en modo "crear" (alta rápida,
 * caso ocasional -- ver docs/plan_fase_1_a_4.md).
 */
export class Clientes extends Component {
    static template = "shalom_location_map.Clientes";
    static components = {ClienteForm, TemaSelector};
    // onTomarPedido(schedule, orderId): "Tomar pedido ahora" del cliente recién creado.
    static props = {onTomarPedido: {type: Function, optional: true}};

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.state = useState({
            cargando: true,
            clientes: [],
            busqueda: "",
            formularioAbierto: false,
            modoFormulario: "crear",
            locationIdEditando: null,
            nombreInicialAlta: "",
            // Hoja "Cliente creado" (mockup aprobado): {nombre, rutaNombre,
            // parada, anteriorNombre, estado, orderId, schedule} | null.
            creado: null,
        });
        // La cola arranca también si la app se abre directo en esta pestaña.
        iniciarSincronizador((this.env.services && this.env.services.orm) || this.orm, this.notification);
        // Se vuelve a dibujar cuando cambia la cola (cliente nuevo enviado).
        this.offline = useState(estadoOffline);
        const dejarDeOir = alTerminarEnvio((item, respuesta) => {
            if (["crear_cliente", "editar_cliente"].includes(item.tipo) && ["ok", "eliminado"].includes(respuesta.estado)) {
                this.cargar();
            }
        });
        onWillUnmount(dejarDeOir);
        // Viene de la búsqueda de Rutas ("Buscar en todos los clientes" o
        // "Crear cliente 'xxx'"): texto ya escrito y, si pidió crear, el
        // formulario de alta abierto con ese nombre.
        let traspaso = null;
        try {
            traspaso = JSON.parse(window.sessionStorage.getItem("shalom_clientes_traspaso") || "null");
            window.sessionStorage.removeItem("shalom_clientes_traspaso");
        } catch (error) {
            traspaso = null;
        }
        if (traspaso && traspaso.texto) {
            this.state.busqueda = traspaso.texto;
            if (traspaso.accion === "alta") {
                this.state.nombreInicialAlta = traspaso.texto;
                this.state.modoFormulario = "crear";
                this.state.formularioAbierto = true;
            }
        }
        onWillStart(() => this.cargar());
    }

    async cargar() {
        this.state.cargando = true;
        try {
            // Con copia en el teléfono + los creados/editados sin señal.
            this.state.clientes = await traerMisClientes(this.orm);
        } catch (error) {
            this.notification.add("No se pudieron cargar tus clientes (sin señal y sin copia en el teléfono).", {type: "danger"});
        } finally {
            this.state.cargando = false;
        }
    }

    /** Dos letras para el avatar del directorio ("Abarrotes Don Pepe" -> "AD"). */
    iniciales(cliente) {
        const partes = (cliente.name || "?").trim().split(/\s+/);
        return ((partes[0] || "?")[0] + (partes[1] ? partes[1][0] : "")).toUpperCase();
    }

    get clientesFiltrados() {
        const texto = normalizarBusqueda(this.state.busqueda).trim();
        if (!texto) {
            return this.state.clientes;
        }
        return this.state.clientes.filter(
            (c) =>
                normalizarBusqueda(c.name || "").includes(texto) ||
                normalizarBusqueda(c.street || "").includes(texto) ||
                normalizarBusqueda(c.street2 || "").includes(texto)
        );
    }

    llamar(cliente) {
        if (!cliente.phone) {
            this.notification.add("Este cliente no tiene teléfono guardado.", {type: "warning"});
            return;
        }
        window.open(`tel:${cliente.phone}`, "_self");
    }

    abrirMaps(cliente) {
        // No tenemos lat/lng en esta lista liviana -- se abre una
        // búsqueda por dirección/nombre en vez de coordenadas exactas.
        // Antes abría Google Maps -- cambiado a Waze por decisión
        // explícita del usuario (query de texto, Waze también la
        // soporta con el parámetro "q").
        const direccion = `${cliente.street || ""} ${cliente.street2 || ""}`.trim();
        const consulta = encodeURIComponent(`${cliente.name} ${direccion}`.trim());
        window.open(`https://waze.com/ul?q=${consulta}&navigate=yes`, "_blank");
    }

    abrirAlta() {
        this.state.nombreInicialAlta = "";
        this.state.modoFormulario = "crear";
        this.state.locationIdEditando = null;
        this.state.formularioAbierto = true;
    }

    abrirEdicion(cliente) {
        this.state.modoFormulario = "editar";
        this.state.locationIdEditando = cliente.id;
        this.state.formularioAbierto = true;
    }

    cerrarFormulario() {
        this.state.formularioAbierto = false;
    }

    async formularioGuardado(resultado) {
        const eraAlta = this.state.modoFormulario === "crear";
        this.state.formularioAbierto = false;
        if (eraAlta && resultado && resultado.estado !== "error") {
            this.state.creado = resultado;
        }
        await this.cargar();
    }

    get textoParadaCreado() {
        const c = this.state.creado;
        if (!c) {
            return "";
        }
        if (!c.anteriorNombre) {
            return "Primera de la ruta";
        }
        return c.parada ? `${c.parada}, después de ${c.anteriorNombre}` : `Después de ${c.anteriorNombre}`;
    }

    /** "Tomar pedido ahora": solo si el cliente tiene visita en un ciclo en
     * curso de su ruta (si no, no hay dónde cargar el pedido). */
    get puedeTomarPedido() {
        const c = this.state.creado;
        return !!(c && c.orderId && c.schedule && this.props.onTomarPedido);
    }

    tomarPedidoCreado() {
        const c = this.state.creado;
        this.state.creado = null;
        if (c && c.orderId && c.schedule && this.props.onTomarPedido) {
            this.props.onTomarPedido(c.schedule, c.orderId);
        }
    }

    cerrarCreado() {
        this.state.creado = null;
    }

    esSinEnviar(cliente) {
        return !!cliente.sinEnviar;
    }
}
