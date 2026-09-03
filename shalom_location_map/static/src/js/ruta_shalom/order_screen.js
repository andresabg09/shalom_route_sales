/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {normalizarAccionActWindow} from "./action_utils";
import {cerrarConAnimacion} from "./animacion_utils";
import {ClienteForm} from "./cliente_form";

/**
 * Catálogo + carrito (Fase 3): se abre de pantalla completa desde el
 * botón "Tomar pedido" de la hoja de visita. Dos sub-pantallas propias
 * ("catalogo" / "carrito"), sin ítem propio en la nav inferior -- igual
 * que ruta-detalle en Fase 1.
 *
 * El catálogo se pide directo con orm.searchRead sobre product.product
 * (no hace falta método de backend nuevo, ver docs/plan_fase_1_a_4.md).
 * El escaneo usa el BarcodeDetector nativo del navegador (Android/Chrome
 * es el dispositivo real de los vendedores, decisión de producto ya
 * confirmada -- sin librería JS externa).
 *
 * Del carrito hay dos salidas:
 * - "Confirmar pedido" -> shalom_confirmar_pedido(): crea/reusa la
 *   cotización, la CONFIRMA (venta real, reserva stock) y cierra la
 *   visita. Es la parte más riesgosa de la app: pide confirmación
 *   explícita antes de mandarla.
 * - "Revisar cotización" -> shalom_guardar_borrador_pedido(): guarda
 *   las líneas como BORRADOR (sin confirmar) y abre la sale.order
 *   nativa, para que el vendedor ajuste precios/promociones ahí --
 *   esa funcionalidad ya existe en Ventas, no se duplica acá.
 *
 * Cierre: se probó primero con history.pushState/popstate (nav_historial)
 * para que el botón Atrás de Android cerrara un nivel a la vez, pero
 * eso choca con el router propio del web client de Odoo 18 -- cualquier
 * history.back() disparado por esta app terminaba interfiriendo con
 * la navegación de Odoo (el síntoma más claro: "Revisar cotización"
 * guardaba el borrador bien, pero nunca redirigía al formulario de la
 * cotización, porque el history.back() de antes de eso se comía la
 * navegación). Por eso ahora el cierre es 100% estado interno (sin
 * tocar el historial del navegador en absoluto) -- el botón "←" del
 * header y el resto de los controles propios de la app son
 * confiables; el botón/gesto Atrás de Android queda con el
 * comportamiento por defecto del web client (no se intenta
 * interceptar, es justamente lo que rompía todo lo demás). Si el
 * carrito tiene productos sin guardar, cualquier intento de salir
 * por el botón "←" del header muestra un aviso propio antes de
 * perderlo -- ver intentarSalir().
 */

// Debajo de esta cantidad se muestra el aviso de stock bajo; en cero o
// menos se muestra "Sin stock" (no bloquea agregar -- solo avisa, la
// decisión de vender igual queda del lado del vendedor/oficina).
const STOCK_BAJO_UMBRAL = 5;

// Formatos de código de barras típicos de productos de consumo
// (retail). BarcodeDetector acepta la lista vacía/omitida para
// detectar todos los formatos soportados por el navegador, pero
// acotarla hace la detección más rápida y con menos falsos positivos.
const FORMATOS_BARCODE = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"];

// Cada cuánto se intenta detectar un código en el frame de video
// actual mientras el escáner está abierto.
const INTERVALO_ESCANEO_MS = 350;

// Reintentos automáticos cuando una foto de producto falla al cargar
// (conexión inestable en la calle) antes de darse por vencido.
const REINTENTOS_IMAGEN_MAX = 3;
const RETRASO_REINTENTO_IMAGEN_MS = 700;

// "Todas" como valor de categoría seleccionada (no es un id real).
const CATEGORIA_TODAS = "todas";

// Con +700 productos, renderizar el catálogo entero de una (con su
// <img> cada uno) disparaba cientos de pedidos de imagen simultáneos
// -- reportado como causa de una caída real de la base de datos.
// Paginado: solo se renderizan (y por lo tanto solo piden imagen) los
// productos de la página actual.
const PRODUCTOS_POR_PAGINA = 80;

// Recuperación de carrito sin guardar (memoria de 30 min, pedido
// explícito): la pantalla se puede perder por cualquier vía que no sea
// un cierre intencional (confirmar pedido, revisar cotización, o
// "Salir sin guardar" del aviso propio) -- típicamente el botón/gesto
// "atrás" de Android, que a propósito NO se intercepta (ver el
// comentario grande al principio del archivo: ya se probó y rompía la
// navegación de Odoo). Sin nada más, eso perdía el carrito entero sin
// ningún aviso. Se guarda un snapshot en localStorage en cada cambio
// del carrito, y se restaura solo (sin preguntar) si se reabre esta
// misma visita dentro de los 30 minutos. Cualquier actividad
// (agregar/sacar un producto, o simplemente reabrir el catálogo con un
// borrador pendiente) reinicia el conteo -- se re-guarda con timestamp
// nuevo en cada una de esas acciones. Se limpia el snapshot en
// cerrarDeVerdad(), que es el único punto de cierre intencional
// compartido por las cuatro salidas legítimas (carrito vacío, "Salir
// sin guardar", pedido confirmado, cotización guardada) -- así nunca
// se limpia en un cierre accidental, que por definición no pasa por
// ningún código nuestro.
const INACTIVIDAD_MAXIMA_BORRADOR_MS = 30 * 60 * 1000;

// -- Carrito en el servidor (Fase 5, "auto-asignación de rutas +
// carrito respaldado + Ver en vivo") --
//
// Cada este intervalo, un solo timer hace UNA de dos cosas:
// - Si hay cambios locales sin mandar (this._cambiosPendientes /
//   this._eliminadosPendientes no vacíos): los manda con
//   shalom_actualizar_carrito (fusión por clave de producto en el
//   servidor, no reemplazo del carrito entero -- ver el docstring de
//   ese método en fsm_order.py) y adopta el carrito ya fusionado que
//   devuelve como verdad local.
// - Si no hay nada pendiente: pregunta shalom_leer_carrito (liviano,
//   solo trae la marca de tiempo + el carrito) y, SOLO si la marca de
//   tiempo cambió desde la última vez que se supo, adopta ese carrito
//   -- así la pantalla no se re-dibuja sin motivo si nadie más está
//   tocando nada.
//
// Con esto, dos dispositivos abiertos en la MISMA visita quedan con
// el carrito sincronizado en ~1 seg en cualquier sentido, sin
// necesidad de una pantalla "espejo" aparte: es literalmente esta
// misma pantalla, en los dos lados.
const SHALOM_SYNC_INTERVALO_MS = 1000;

function claveBorradorCarrito(orderId) {
    return `shalom_carrito_borrador_${orderId}`;
}

// "Sesión" de catálogo = esta pestaña del navegador, mientras siga
// abierta -- sessionStorage (no localStorage) para que cada pestaña/
// dispositivo tenga la suya, generada una sola vez y reusada mientras
// dure. No hay forma de identificar "el dispositivo físico" desde el
// navegador; pestaña es la aproximación más cercana. Usado para
// decidir cuál dispositivo es el "principal" (ver el docstring grande
// de x_catalogo_sesiones en fsm_order.py): el que abrió el catálogo
// primero es el único al que se le pregunta "¿guardar o descartar?"
// al salir -- riesgo real reportado, un vendedor/cliente mirando en
// paralelo podía descartar por error el pedido de otro.
const CLAVE_SESION_CATALOGO = "shalom_sesion_catalogo";

function shalomIdSesionCatalogo() {
    try {
        let id = sessionStorage.getItem(CLAVE_SESION_CATALOGO);
        if (!id) {
            id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            sessionStorage.setItem(CLAVE_SESION_CATALOGO, id);
        }
        return id;
    } catch (error) {
        // sessionStorage puede fallar (modo privado, etc.) -- un id
        // nuevo por render no es ideal (siempre "principal" al abrir),
        // pero no bloquea poder usar el catálogo.
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}

/** "2026-09-02 14:30:00" (hora del servidor, UTC, sin zona explícita
 * -- así devuelve fields.Datetime.to_string de Odoo) -> milisegundos
 * epoch, interpretándolo como UTC. */
function shalomFechaServidorAMs(fechaServidor) {
    if (!fechaServidor) {
        return 0;
    }
    return Date.parse(fechaServidor.replace(" ", "T") + "Z") || 0;
}

export class OrderScreen extends Component {
    static template = "shalom_location_map.OrderScreen";
    static components = {ClienteForm};
    static props = {
        orderId: Number,
        clienteNombre: String,
        onCerrar: Function,
        onConfirmado: {type: Function, optional: true},
        onRevisado: {type: Function, optional: true},
    };

    setup() {
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.action = useService("action");
        this.videoRef = useRef("video");
        this.stream = null;
        this.intervaloEscaneo = null;
        this.detectorEnCurso = false;
        this.detector = null;
        this._cerrado = false;

        // -- Carrito en el servidor / "Ver en vivo" (ver el comentario
        // grande de SHALOM_SYNC_INTERVALO_MS más arriba) --
        this._cambiosPendientes = {}; // {clave: linea para el servidor}
        this._eliminadosPendientes = new Set();
        this._sincronizando = false; // evita solapar dos ciclos si uno tarda
        this._ultimaActualizadaConocida = false; // string del servidor
        this._syncTimer = null;
        this._sesionId = shalomIdSesionCatalogo();
        this._sesionCerrada = false; // guarda para no llamar shalom_cerrar_sesion_catalogo dos veces

        this.state = useState({
            cargando: true,
            pantalla: "catalogo", // catalogo | carrito
            productos: [],
            busqueda: "",
            categoriaSeleccionada: CATEGORIA_TODAS,
            categMenuAbierto: false,
            busquedaCategoria: "",
            soloConStock: false,
            paginaActual: 1,
            carrito: {}, // {productId: {producto, cantidad}}
            promoPorProducto: {}, // {productId: "✅ Tienes..." | "⏳ Faltan..."}
            recompensasDisponibles: [], // [{regla_id, programa_nombre, reward_product_id, reward_product_name, reward_qty, disponibles}]
            recompensaMenuAbierto: false,
            escaneando: false,
            confirmando: false,
            guardandoBorrador: false,
            confirmandoSalida: false,
            cerrando: false,
            // Aviso "a este cliente le faltan datos" (punto 4, no
            // bloqueante) -- ver el docstring grande al principio del
            // archivo. locationId se resuelve junto con datosFaltantes
            // porque hace falta para abrir ClienteForm.
            locationId: false,
            datosFaltantes: [],
            avisoDatosFaltantesCerrado: false,
            editandoCliente: false,
            mostrandoAvisoConfirmar: false,
            omitirAvisoDatosFaltantes: false,
            // Qué acción retomar si en el interstitial de arriba se
            // elige seguir igual -- "confirmar" (Finalizar a orden de
            // venta) o "revisar" (Revisar cotización): las dos pasan
            // por el mismo aviso, ver confirmarPedido()/revisarCotizacion().
            accionPendienteAvisoDatos: null,
            // "Principal" (ver el docstring grande de
            // CLAVE_SESION_CATALOGO más arriba): true hasta el primer
            // heartbeat -- así, si esta pestaña está sola (caso normal,
            // sin nadie más mirando), el aviso de "salir sin guardar"
            // sigue funcionando desde el instante en que se abre,
            // sin esperar el primer tick de sincronización.
            esPrincipal: true,
        });

        this._restaurarBorradorCarritoSiCorresponde();

        onWillStart(async () => {
            // cargarProductos() primero (o junto, pero resuelto antes de
            // reconciliar): _reconciliarCarritoServidorInicial() necesita
            // this.state.productos ya cargado para poder buscarle el
            // qty_available a cada línea que traiga del servidor.
            await Promise.all([this.cargarProductos(), this._cargarDatosFaltantes()]);
            await this._reconciliarCarritoServidorInicial();
        });
        onWillUnmount(() => {
            this.detenerEscaneo();
            if (this._syncTimer) {
                clearInterval(this._syncTimer);
            }
            this._cerrarSesionCatalogo();
        });
        this._syncTimer = setInterval(() => this._tickSincronizacionCarrito(), SHALOM_SYNC_INTERVALO_MS);

        // Enganchar el stream de la cámara al <video> recién cuando el
        // elemento ya existe en el DOM (t-if renderiza el <video> junto
        // con el overlay) -- antes se esperaba un setTimeout(0) fijo, que
        // en algunos dispositivos no alcanzaba y requería tocar el botón
        // de escanear varias veces para que agarrara.
        useEffect(
            () => {
                if (this.state.escaneando && this.videoRef.el && this.stream) {
                    this.engancharVideo();
                }
            },
            () => [this.state.escaneando, this.videoRef.el]
        );
    }

    // -- Memoria de 30 min del carrito (ver comentario grande de
    // INACTIVIDAD_MAXIMA_BORRADOR_MS más arriba) --

    /** Guarda un snapshot del carrito actual en localStorage, con la
     * hora de este guardado -- cualquier llamada reinicia la ventana
     * de 30 minutos. Se guarda igual si el carrito quedó vacío (evita
     * quedar con un borrador viejo de un ítem que ya se sacó; un
     * snapshot vacío tampoco restaura nada, ver
     * _restaurarBorradorCarritoSiCorresponde). */
    _guardarBorradorCarrito() {
        try {
            localStorage.setItem(
                claveBorradorCarrito(this.props.orderId),
                JSON.stringify({ts: Date.now(), carrito: this.state.carrito})
            );
        } catch (error) {
            // localStorage puede fallar (modo privado del navegador,
            // cuota llena, etc.) -- no es crítico para seguir armando
            // el pedido en memoria, solo se pierde la posibilidad de
            // recuperarlo si la pantalla se cierra por accidente.
        }
    }

    _borrarBorradorCarrito() {
        try {
            localStorage.removeItem(claveBorradorCarrito(this.props.orderId));
        } catch (error) {
            // ver _guardarBorradorCarrito()
        }
    }

    /** Si hay un borrador guardado de esta misma visita, de menos de 30
     * minutos de inactividad, lo restaura sin preguntar (pedido
     * explícito) y reinicia el conteo re-guardándolo con timestamp
     * nuevo -- reabrir el catálogo con un borrador pendiente también
     * cuenta como actividad. Se llama una sola vez, en setup(), antes
     * de que el vendedor pueda tocar nada. */
    _restaurarBorradorCarritoSiCorresponde() {
        let crudo;
        try {
            crudo = localStorage.getItem(claveBorradorCarrito(this.props.orderId));
        } catch (error) {
            return;
        }
        if (!crudo) {
            return;
        }
        let borrador;
        try {
            borrador = JSON.parse(crudo);
        } catch (error) {
            this._borrarBorradorCarrito();
            return;
        }
        const cantidadItems = Object.keys(borrador.carrito || {}).length;
        if (!cantidadItems || Date.now() - borrador.ts > INACTIVIDAD_MAXIMA_BORRADOR_MS) {
            this._borrarBorradorCarrito();
            return;
        }
        Object.assign(this.state.carrito, borrador.carrito);
        this.notification.add(
            `Se recuperaron ${cantidadItems} producto(s) sin guardar de una ` +
            "sesión anterior con este cliente.",
            {type: "info"}
        );
        this._guardarBorradorCarrito(); // reinicia el conteo de 30 min
        this.actualizarPromos();
    }

    // -- Carrito en el servidor / "Ver en vivo" --

    /** Convierte una línea del carrito en memoria (state.carrito[clave])
     * al formato liviano que se manda/guarda en el servidor (sin el
     * objeto `producto` completo, solo lo necesario para reconstruirlo
     * del otro lado -- ver _carritoDesdeServidor). */
    _lineaParaServidor(item) {
        return {
            product_id: item.producto.id,
            name: item.producto.name,
            list_price: item.producto.list_price,
            cantidad: item.cantidad,
            es_recompensa: !!item.esRecompensa,
            regla_id: item.reglaId || false,
        };
    }

    /** Inverso de _lineaParaServidor: reconstruye el shape que usa
     * state.carrito a partir de lo guardado en el servidor. qty_available
     * se busca en el catálogo ya cargado (this.state.productos) si el
     * producto sigue existiendo ahí -- si no, 0 (solo afecta la
     * etiqueta de stock, no bloquea nada). */
    _carritoDesdeServidor(dictServidor) {
        const carrito = {};
        for (const [clave, linea] of Object.entries(dictServidor || {})) {
            const enCatalogo = this.state.productos.find((p) => p.id === linea.product_id);
            carrito[clave] = {
                producto: {
                    id: linea.product_id,
                    name: linea.name,
                    list_price: linea.list_price,
                    qty_available: enCatalogo ? enCatalogo.qty_available : 0,
                    categ_id: enCatalogo ? enCatalogo.categ_id : false,
                },
                cantidad: linea.cantidad,
                esRecompensa: !!linea.es_recompensa,
                reglaId: linea.regla_id || false,
            };
        }
        return carrito;
    }

    /** Llamado por cada acción que toca el carrito (agregar, cambiar
     * cantidad, quitar, canjear recompensa) -- ADEMÁS de actualizar
     * state.carrito y guardar en localStorage (comportamiento previo,
     * sin cambios), deja anotada la clave como "pendiente de mandar al
     * servidor" en el próximo tick de sincronización (hasta 1 seg de
     * colchón, no una llamada por toque). */
    _marcarCambioPendienteCarrito(clave) {
        // String(clave) SIEMPRE -- bug real reportado ("no deja borrar
        // ningún producto"): para productos normales `clave` llega acá
        // como NÚMERO (item.producto.id), y _eliminadosPendientes es un
        // Set (a diferencia de _cambiosPendientes, un objeto plano, que
        // JS ya convierte sus claves a texto solo). Un Set en cambio
        // guarda 42 (número) y "42" (texto) como dos valores DISTINTOS.
        // Ese número viajaba tal cual al servidor, donde el carrito
        // guardado es JSON con claves de texto -- carrito.pop(42, None)
        // nunca encontraba la clave "42" real, así que el borrado no
        // hacía nada, en silencio, siempre (no era una carrera).
        clave = String(clave);
        const item = this.state.carrito[clave];
        if (item) {
            this._cambiosPendientes[clave] = this._lineaParaServidor(item);
            this._eliminadosPendientes.delete(clave);
        } else {
            delete this._cambiosPendientes[clave];
            this._eliminadosPendientes.add(clave);
        }
    }

    /** Al abrir el catálogo: compara el snapshot de localStorage (ya
     * restaurado de forma síncrona en setup(), si correspondía) contra
     * el del servidor, y se queda con el que sea más nuevo -- así da
     * igual desde qué dispositivo se reabre esta visita (punto B). No
     * bloquea la apertura si falla (sin conexión): sigue con lo que ya
     * haya en memoria/localStorage. */
    async _reconciliarCarritoServidorInicial() {
        let tsLocal = 0;
        try {
            const crudo = localStorage.getItem(claveBorradorCarrito(this.props.orderId));
            if (crudo) {
                tsLocal = JSON.parse(crudo).ts || 0;
            }
        } catch (error) {
            // ver _guardarBorradorCarrito()
        }

        let resultado;
        try {
            resultado = await this.orm.call("fsm.order", "shalom_leer_carrito", [
                [this.props.orderId],
            ]);
        } catch (error) {
            console.error("shalom: no se pudo leer el carrito del servidor", error);
            return;
        }

        this._ultimaActualizadaConocida = resultado.actualizado;
        const tsServidor = shalomFechaServidorAMs(resultado.actualizado);
        if (tsServidor > tsLocal) {
            Object.assign(this.state.carrito, this._carritoDesdeServidor(resultado.carrito));
            this.actualizarPromos();
        } else if (Object.keys(this.state.carrito).length) {
            // El local es igual o más nuevo (o el servidor no tenía
            // nada todavía): lo mandamos nosotros para que el servidor
            // -- y cualquier otro dispositivo mirando esta visita --
            // quede al día, en vez de esperar al próximo cambio.
            for (const clave of Object.keys(this.state.carrito)) {
                this._marcarCambioPendienteCarrito(clave);
            }
        }
    }

    /** Aplica el carrito que devolvió el servidor a state.carrito SIN
     * pisar cambios locales hechos MIENTRAS se esperaba esa respuesta
     * -- bug real reportado ("no me deja borrar productos"): con
     * varios toques seguidos, la respuesta de un guardado anterior
     * (más vieja) podía llegar DESPUÉS de que el vendedor ya hubiera
     * borrado otro producto, y un reemplazo/merge ciego "resucitaba"
     * lo recién borrado. Acá nunca se resucita una clave que ahora
     * está en _eliminadosPendientes, y nunca se pisa una clave que
     * ahora está en _cambiosPendientes (ese valor local es más nuevo
     * que la respuesta que se está aplicando -- se termina de mandar
     * solo, en el próximo tick). */
    _aplicarCarritoServidor(dictServidor) {
        const nuevo = this._carritoDesdeServidor(dictServidor);
        for (const clave of this._eliminadosPendientes) {
            delete nuevo[clave];
        }
        for (const clave of Object.keys(this._cambiosPendientes)) {
            if (this.state.carrito[clave]) {
                nuevo[clave] = this.state.carrito[clave];
            }
        }
        this.state.carrito = nuevo;
    }

    /** Best-effort, llamado al cerrarse esta pantalla (cualquier vía,
     * intencional o no -- ver onWillUnmount): saca esta sesión de
     * x_catalogo_sesiones para que el rol de "principal" pase a la
     * siguiente sesión más antigua de una, sin esperar a que el
     * heartbeat de esta quede viejo. */
    _cerrarSesionCatalogo() {
        if (this._sesionCerrada) {
            return;
        }
        this._sesionCerrada = true;
        this.orm.call("fsm.order", "shalom_cerrar_sesion_catalogo", [
            [this.props.orderId], this._sesionId,
        ]).catch(() => {});
    }

    /** Timer de ~1 seg (ver SHALOM_SYNC_INTERVALO_MS): manda lo
     * pendiente si hay, si no pregunta si hay algo nuevo. Sin bloquear
     * la interacción del vendedor -- cualquier error (sin señal en la
     * calle) se ignora en silencio, se reintenta solo en el próximo
     * tick.
     *
     * También manda, en cada tick, el heartbeat de "el catálogo está
     * abierto acá" (con el id de esta sesión/pestaña) -- de ahí sale
     * si esta pestaña es la "principal" (ver el docstring grande de
     * CLAVE_SESION_CATALOGO), que es lo único que decide si
     * intentarSalir() pregunta "guardar o descartar" o cierra
     * directo. A diferencia del resto del tick, a este SÍ se le espera
     * la respuesta (es la misma llamada liviana de siempre, no una
     * extra). */
    async _tickSincronizacionCarrito() {
        if (this._sincronizando || this._cerrado) {
            return;
        }
        this._sincronizando = true;
        try {
            try {
                const heartbeat = await this.orm.call("fsm.order", "shalom_marcar_catalogo_abierto", [
                    [this.props.orderId], this._sesionId,
                ]);
                this.state.esPrincipal = heartbeat.es_principal;
            } catch (error) {
                // Sin señal: no se sabe si sigue siendo principal --
                // se deja el último valor conocido, no se asume nada.
            }

            const hayPendientes =
                Object.keys(this._cambiosPendientes).length || this._eliminadosPendientes.size;
            if (hayPendientes) {
                const cambios = this._cambiosPendientes;
                const eliminados = Array.from(this._eliminadosPendientes);
                this._cambiosPendientes = {};
                this._eliminadosPendientes = new Set();
                const resultado = await this.orm.call("fsm.order", "shalom_actualizar_carrito", [
                    [this.props.orderId],
                    cambios,
                    eliminados,
                ]);
                this._ultimaActualizadaConocida = resultado.actualizado;
                this._aplicarCarritoServidor(resultado.carrito);
                this.actualizarPromos();
            } else {
                const resultado = await this.orm.call("fsm.order", "shalom_leer_carrito", [
                    [this.props.orderId],
                ]);
                // Chequeo de nuevo DESPUÉS de esperar la respuesta: el
                // vendedor pudo haber tocado el carrito MIENTRAS se
                // esperaba -- si es así, no se aplica esta foto vieja
                // del servidor (se resuelve solo en el próximo tick,
                // que va a ver pendientes y hacer el push).
                const siguenSinPendientes =
                    !Object.keys(this._cambiosPendientes).length && !this._eliminadosPendientes.size;
                if (!siguenSinPendientes) {
                    return;
                }
                if (resultado.actualizado === this._ultimaActualizadaConocida) {
                    return; // nada nuevo -- no re-dibujar la pantalla porque sí
                }
                this._ultimaActualizadaConocida = resultado.actualizado;
                this._aplicarCarritoServidor(resultado.carrito);
                this.actualizarPromos();
            }
        } catch (error) {
            // Sin conexión u otro error transitorio -- se reintenta
            // solo en el próximo tick, no interrumpe al vendedor.
        } finally {
            this._sincronizando = false;
        }
    }

    /** Aviso "a este cliente le faltan datos" (punto 4, no bloqueante):
     * chequea qué le falta al cliente de esta visita, reusando el
     * mismo método de fsm_order.py que también usa el cierre de la
     * visita (validación real, esto es solo el aviso). Se llama al
     * abrir la pantalla y de nuevo después de editar el cliente, para
     * que el banner desaparezca solo en cuanto ya no falte nada. */
    async _cargarDatosFaltantes() {
        try {
            const [orden] = await this.orm.read("fsm.order", [this.props.orderId], ["location_id"]);
            this.state.locationId = orden.location_id ? orden.location_id[0] : false;
            this.state.datosFaltantes = await this.orm.call(
                "fsm.order",
                "shalom_campos_cliente_faltantes",
                [[this.props.orderId]]
            );
        } catch (error) {
            // No es crítico para poder seguir armando el pedido -- si
            // falla, simplemente no se muestra el aviso.
            console.error("shalom: error al chequear datos del cliente", error);
        }
    }

    cerrarAvisoDatosFaltantes() {
        this.state.avisoDatosFaltantesCerrado = true;
    }

    abrirEdicionCliente() {
        // Se llama tanto desde el banner de arriba como desde el botón
        // "Completar datos del cliente" del interstitial de confirmar
        // -- en ese segundo caso hace falta cerrar el interstitial
        // también, si no queda abierto detrás (bug real reportado:
        // ClienteForm se abría bien, pero el aviso se quedaba tapando
        // encima -- ver también el z-index de .edit-overlay).
        this.state.mostrandoAvisoConfirmar = false;
        this.state.editandoCliente = true;
    }

    cerrarEdicionCliente() {
        this.state.editandoCliente = false;
    }

    async clienteEditado() {
        this.state.editandoCliente = false;
        this.state.avisoDatosFaltantesCerrado = false;
        await this._cargarDatosFaltantes();
    }

    cerrarAvisoConfirmar() {
        this.state.mostrandoAvisoConfirmar = false;
        this.state.accionPendienteAvisoDatos = null;
    }

    /** "Confirmar/Revisar de todas formas" del interstitial -- retoma
     * la acción que lo disparó (ver confirmarPedido()/revisarCotizacion()),
     * sin volver a mostrarlo para el resto de esta sesión del carrito. */
    async continuarIgnorandoAvisoDatos() {
        this.state.mostrandoAvisoConfirmar = false;
        this.state.omitirAvisoDatosFaltantes = true;
        const accion = this.state.accionPendienteAvisoDatos;
        this.state.accionPendienteAvisoDatos = null;
        if (accion === "revisar") {
            await this._revisarCotizacionDeVerdad();
        } else {
            await this._confirmarPedidoDeVerdad();
        }
    }

    /** True si corresponde interrumpir con el interstitial de "a este
     * cliente le faltan datos" antes de confirmar/revisar. */
    get _debeAvisarDatosFaltantes() {
        return this.state.datosFaltantes.length > 0 && !this.state.omitirAvisoDatosFaltantes;
    }

    async cargarProductos() {
        this.state.cargando = true;
        try {
            const productos = await this.orm.searchRead(
                "product.product",
                [["sale_ok", "=", true]],
                ["name", "list_price", "barcode", "default_code", "qty_available", "categ_id"],
                {order: "name asc"}
            );
            this.state.productos = productos;
        } catch (error) {
            this.notification.add("No se pudo cargar el catálogo de productos.", {
                type: "danger",
            });
        } finally {
            this.state.cargando = false;
        }
    }

    // -- Categorías (menú desplegable con buscador) --

    /**
     * Productos que pasan los filtros de texto (buscador principal) y
     * stock -- sin aplicar el de categoría, porque es justo el que se
     * está por elegir acá. Se usa solo para calcular qué categorías
     * mostrar como opción (pedido explícito: si buscás "tinte" o
     * activás "Con stock", que el menú de categorías se reduzca a lo
     * que realmente hay disponible, en vez de listar siempre todo el
     * catálogo).
     */
    get productosParaCategorias() {
        const texto = this.state.busqueda.trim().toLowerCase();
        return this.state.productos.filter((producto) => {
            if (this.state.soloConStock && producto.qty_available <= 0) {
                return false;
            }
            if (!texto) {
                return true;
            }
            return (
                (producto.name || "").toLowerCase().includes(texto) ||
                (producto.default_code || "").toLowerCase().includes(texto) ||
                (producto.barcode || "").toLowerCase().includes(texto)
            );
        });
    }

    /** Todas las categorías del catálogo completo, sin filtrar -- se
     * usa solo para resolver el nombre de la categoría ya elegida (así
     * el título del selector no cambia si después se busca/filtra algo
     * que la deja afuera de las opciones disponibles). */
    get categorias() {
        const vistas = new Map();
        for (const producto of this.state.productos) {
            if (producto.categ_id) {
                vistas.set(producto.categ_id[0], producto.categ_id[1]);
            }
        }
        return Array.from(vistas.entries())
            .map(([id, nombre]) => ({id, nombre}))
            .sort((a, b) => a.nombre.localeCompare(b.nombre));
    }

    /** Categorías a ofrecer como opción en el menú -- reducidas a las
     * que de verdad tienen productos con el texto/stock actuales. */
    get categoriasDisponibles() {
        const vistas = new Map();
        for (const producto of this.productosParaCategorias) {
            if (producto.categ_id) {
                vistas.set(producto.categ_id[0], producto.categ_id[1]);
            }
        }
        return Array.from(vistas.entries())
            .map(([id, nombre]) => ({id, nombre}))
            .sort((a, b) => a.nombre.localeCompare(b.nombre));
    }

    get categoriasFiltradas() {
        const texto = this.state.busquedaCategoria.trim().toLowerCase();
        if (!texto) {
            return this.categoriasDisponibles;
        }
        return this.categoriasDisponibles.filter((c) => c.nombre.toLowerCase().includes(texto));
    }

    get etiquetaCategoriaActual() {
        if (this.state.categoriaSeleccionada === CATEGORIA_TODAS) {
            return "Todas las categorías";
        }
        const encontrada = this.categorias.find((c) => c.id === this.state.categoriaSeleccionada);
        return encontrada ? encontrada.nombre : "Todas las categorías";
    }

    toggleCategMenu() {
        this.state.categMenuAbierto = !this.state.categMenuAbierto;
        if (!this.state.categMenuAbierto) {
            this.state.busquedaCategoria = "";
        }
    }

    elegirCategoria(id) {
        this.state.categoriaSeleccionada = id;
        this.state.categMenuAbierto = false;
        this.state.busquedaCategoria = "";
        this.resetPagina();
    }

    toggleSoloConStock() {
        this.state.soloConStock = !this.state.soloConStock;
        this.resetPagina();
    }

    resetPagina() {
        this.state.paginaActual = 1;
    }

    get productosFiltrados() {
        const texto = this.state.busqueda.trim().toLowerCase();
        return this.state.productos.filter((producto) => {
            if (
                this.state.categoriaSeleccionada !== CATEGORIA_TODAS &&
                (!producto.categ_id || producto.categ_id[0] !== this.state.categoriaSeleccionada)
            ) {
                return false;
            }
            if (this.state.soloConStock && producto.qty_available <= 0) {
                return false;
            }
            if (!texto) {
                return true;
            }
            return (
                (producto.name || "").toLowerCase().includes(texto) ||
                (producto.default_code || "").toLowerCase().includes(texto) ||
                (producto.barcode || "").toLowerCase().includes(texto)
            );
        });
    }

    get totalPaginas() {
        return Math.max(1, Math.ceil(this.productosFiltrados.length / PRODUCTOS_POR_PAGINA));
    }

    get productosPaginados() {
        const inicio = (this.state.paginaActual - 1) * PRODUCTOS_POR_PAGINA;
        return this.productosFiltrados.slice(inicio, inicio + PRODUCTOS_POR_PAGINA);
    }

    paginaAnterior() {
        if (this.state.paginaActual > 1) {
            this.state.paginaActual -= 1;
        }
    }

    paginaSiguiente() {
        if (this.state.paginaActual < this.totalPaginas) {
            this.state.paginaActual += 1;
        }
    }

    onBusquedaInput() {
        this.resetPagina();
    }

    imagenUrl(producto) {
        // image_1024: un escalón por debajo del original (1920) --
        // buena resolución para agrandar un poco en el detalle, sin
        // pesar tanto como el original en una red de datos móviles/
        // satelital en la calle. El tamaño en pantalla (120x180px) se
        // controla por CSS (.product-thumb), no por este campo.
        return `/web/image/product.product/${producto.id}/image_1024`;
    }

    onImagenError(ev) {
        // La ruta /web/image/... ya devuelve el placeholder propio de
        // Odoo cuando el producto no tiene foto (mismo mecanismo que
        // usa el catálogo nativo de Ventas) -- esto es para cuando SÍ
        // tiene foto pero la carga falló de verdad (reportado: en una
        // red de datos móviles/satelital en la calle, algunas fotos
        // "a veces cargan, a veces no" y antes se rendían a la primera
        // falla, dejando el hueco vacío para el resto de la sesión).
        // Ahora reintenta un par de veces con una espera creciente
        // antes de darse por vencido -- forzando una petición nueva
        // (con un parámetro descartable en la URL) en vez de reusar la
        // misma que ya falló.
        const el = ev.target;
        const intentos = Number(el.dataset.shalomReintentos || 0);
        if (intentos < REINTENTOS_IMAGEN_MAX) {
            el.dataset.shalomReintentos = String(intentos + 1);
            const urlBase = el.src.split("?")[0];
            setTimeout(() => {
                el.src = `${urlBase}?_r=${Date.now()}`;
            }, RETRASO_REINTENTO_IMAGEN_MS * (intentos + 1));
            return;
        }
        el.style.display = "none";
    }

    get itemsCarrito() {
        return Object.values(this.state.carrito);
    }

    /** Solo los productos pagos (sin las líneas de recompensa) -- lo
     * que se manda a calcular promociones, para que un regalo ya
     * canjeado no cuente como unidad "válida" para ganar otro. */
    get itemsCarritoPagos() {
        return this.itemsCarrito.filter((item) => !item.esRecompensa);
    }

    get cantidadItems() {
        return this.itemsCarrito.reduce((total, item) => total + item.cantidad, 0);
    }

    get total() {
        return this.itemsCarritoPagos.reduce(
            (total, item) => total + item.cantidad * item.producto.list_price,
            0
        );
    }

    /**
     * Recompensas que el backend marcó como disponibles, descontando
     * las que ya se canjearon en esta sesión del carrito (se guardan
     * como una línea más de state.carrito, key "reward-<regla_id>").
     */
    get recompensasConDisponibilidad() {
        return this.state.recompensasDisponibles
            .map((r) => {
                const item = this.state.carrito[`reward-${r.regla_id}`];
                const vecesReclamadas = item ? Math.round(item.cantidad / r.reward_qty) : 0;
                return {...r, restantes: r.disponibles - vecesReclamadas};
            })
            .filter((r) => r.restantes > 0);
    }

    cantidadEnCarrito(productoId) {
        const item = this.state.carrito[productoId];
        return item ? item.cantidad : 0;
    }

    etiquetaStock(producto) {
        if (producto.qty_available <= 0) {
            return "Sin stock";
        }
        if (producto.qty_available <= STOCK_BAJO_UMBRAL) {
            return `Stock bajo: ${producto.qty_available}`;
        }
        return "";
    }

    etiquetaPromo(productoId) {
        return this.state.promoPorProducto[productoId] || "";
    }

    promoCompleta(productoId) {
        return this.etiquetaPromo(productoId).includes("✅");
    }

    agregarProducto(producto) {
        const actual = this.state.carrito[producto.id];
        this.state.carrito[producto.id] = {
            producto,
            cantidad: (actual ? actual.cantidad : 0) + 1,
        };
        this.actualizarPromos();
        this._guardarBorradorCarrito();
        this._marcarCambioPendienteCarrito(producto.id);
    }

    cambiarCantidad(productoId, delta) {
        const item = this.state.carrito[productoId];
        if (!item) {
            return;
        }
        const nueva = item.cantidad + delta;
        if (nueva <= 0) {
            delete this.state.carrito[productoId];
        } else {
            item.cantidad = nueva;
        }
        this.actualizarPromos();
        this._guardarBorradorCarrito();
        this._marcarCambioPendienteCarrito(productoId);
    }

    quitarDelCarrito(productoId) {
        delete this.state.carrito[productoId];
        this.actualizarPromos();
        this._guardarBorradorCarrito();
        this._marcarCambioPendienteCarrito(productoId);
    }

    /**
     * Al enfocar el input de cantidad, seleccionar todo el valor actual
     * -- así escribir la cantidad nueva la reemplaza directo (pedido
     * explícito: sin esto había que borrar dígito por dígito antes de
     * poder escribir, ej. para cambiar "5" por "100").
     */
    seleccionarTextoCantidad(ev) {
        ev.target.select();
    }

    /**
     * Cantidad escrita a mano con el teclado (en vez de tocar "+" una
     * por una) -- pedido explícito para pedidos grandes (ej. 100
     * unidades). Cualquier valor inválido o menor a 1 se trata como
     * "quitar del carrito", igual que bajar el stepper hasta 0.
     */
    cambiarCantidadManual(productoId, ev) {
        const item = this.state.carrito[productoId];
        if (!item) {
            return;
        }
        const nueva = parseInt(ev.target.value, 10);
        if (!nueva || nueva <= 0) {
            delete this.state.carrito[productoId];
        } else {
            item.cantidad = nueva;
        }
        this.actualizarPromos();
        this._guardarBorradorCarrito();
        this._marcarCambioPendienteCarrito(productoId);
    }

    /**
     * Estado de las promociones "comprar X llevar Y" (mismo criterio
     * que ya muestra el módulo de Ventas en custom_promo_status) para
     * lo que hay en el carrito -- se recalcula cada vez que cambia
     * algo, así el vendedor ve en vivo si le faltan unidades o ya
     * completó la promo, sin esperar a confirmar el pedido. Solo se
     * manda itemsCarritoPagos (sin los regalos ya canjeados).
     */
    async actualizarPromos() {
        const items = this.itemsCarritoPagos;
        if (!items.length) {
            this.state.promoPorProducto = {};
            this.state.recompensasDisponibles = [];
            return;
        }
        try {
            const lineas = items.map((item) => ({
                product_id: item.producto.id,
                qty: item.cantidad,
            }));
            const resultado = await this.orm.call(
                "fsm.order",
                "shalom_estado_promociones_carrito",
                [lineas]
            );
            this.state.promoPorProducto = resultado.mensajes;
            this.state.recompensasDisponibles = resultado.recompensas;
        } catch (error) {
            console.error("shalom: error al calcular promociones", error);
            // No es crítico para poder seguir armando el pedido -- se
            // deja sin avisar al vendedor, la próxima actualización del
            // carrito lo reintenta solo.
        }
    }

    // -- Recompensa (producto gratis de una promo "comprar X llevar Y"
    // ya completa) -- misma lógica que el módulo de Ventas para
    // detectar cuándo hay una promo completa, pero acá se canjean TODAS
    // las unidades disponibles de una misma referencia de un solo
    // click (pedido explícito: si el vendedor completó 10 promos del
    // mismo producto, un click carga las 10, no una por click). Si hay
    // promos completas de referencias distintas, el vendedor elige cuál
    // primero -- y esa elección también trae todas las unidades de esa
    // referencia de una vez. El botón deja de mostrarse cuando ya no
    // queda ninguna promo completa sin canjear. --

    abrirRecompensas() {
        const disponibles = this.recompensasConDisponibilidad;
        if (!disponibles.length) {
            return;
        }
        if (disponibles.length === 1) {
            this.elegirRecompensa(disponibles[0]);
            return;
        }
        this.state.recompensaMenuAbierto = true;
    }

    cerrarMenuRecompensas() {
        this.state.recompensaMenuAbierto = false;
    }

    elegirRecompensa(recompensa) {
        const key = `reward-${recompensa.regla_id}`;
        const actual = this.state.carrito[key];
        const unidadesACargar = recompensa.restantes * recompensa.reward_qty;
        this.state.carrito[key] = {
            producto: {
                id: recompensa.reward_product_id,
                name: recompensa.reward_product_name,
                list_price: 0,
                qty_available: 0,
                categ_id: false,
            },
            cantidad: (actual ? actual.cantidad : 0) + unidadesACargar,
            esRecompensa: true,
            reglaId: recompensa.regla_id,
        };
        this.state.recompensaMenuAbierto = false;
        this.notification.add(
            `Promoción agregada: ${unidadesACargar} x ${recompensa.reward_product_name}`,
            {type: "success"}
        );
        this._guardarBorradorCarrito();
        this._marcarCambioPendienteCarrito(key);
    }

    irACatalogo() {
        this.state.pantalla = "catalogo";
    }

    irACarrito() {
        if (!this.cantidadItems) {
            this.notification.add("El carrito está vacío.", {type: "warning"});
            return;
        }
        this.state.pantalla = "carrito";
    }

    // -- Escaneo de código de barras (BarcodeDetector nativo) --

    async iniciarEscaneo() {
        if (!("BarcodeDetector" in window)) {
            this.notification.add(
                "Este navegador no soporta escaneo de código de barras. Buscá el producto por nombre.",
                {type: "warning"}
            );
            return;
        }
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {facingMode: "environment"},
            });
        } catch (error) {
            this.notification.add(
                "No se pudo acceder a la cámara. Verificá el permiso de cámara del navegador.",
                {type: "danger"}
            );
            return;
        }
        // El useEffect de arriba se encarga de engancharlo apenas el
        // <video> exista en el DOM (puede que ya exista, si esta no es
        // la primera vez que se abre el escáner en esta pantalla).
        this.state.escaneando = true;
    }

    async engancharVideo() {
        if (this.videoRef.el.srcObject === this.stream) {
            return; // ya enganchado, useEffect se re-disparó por otra razón
        }
        this.videoRef.el.srcObject = this.stream;
        try {
            await this.videoRef.el.play();
        } catch (error) {
            // Algunos navegadores rechazan play() si no lo consideran
            // parte de un gesto del usuario -- no hay mucho más que
            // hacer que avisar, el <video> ya tiene autoplay/muted como
            // respaldo.
            console.warn("shalom: no se pudo iniciar el video del escáner", error);
        }

        try {
            this.detector = new window.BarcodeDetector({formats: FORMATOS_BARCODE});
        } catch (error) {
            // Lista de formatos no soportada por este navegador en
            // particular: reintentar sin acotarla en vez de fallar.
            this.detector = new window.BarcodeDetector();
        }
        if (this.intervaloEscaneo) {
            clearInterval(this.intervaloEscaneo);
        }
        this.intervaloEscaneo = setInterval(() => this.detectarFrame(), INTERVALO_ESCANEO_MS);
    }

    async detectarFrame() {
        if (!this.state.escaneando || this.detectorEnCurso || !this.videoRef.el) {
            return;
        }
        this.detectorEnCurso = true;
        try {
            const codigos = await this.detector.detect(this.videoRef.el);
            if (codigos.length) {
                this.onCodigoDetectado(codigos[0].rawValue);
            }
        } catch (error) {
            // Frame no válido todavía (cámara recién arrancando) -- se
            // reintenta solo en el próximo intervalo.
        } finally {
            this.detectorEnCurso = false;
        }
    }

    onCodigoDetectado(codigo) {
        const producto = this.state.productos.find((p) => p.barcode === codigo);
        this.detenerEscaneo();
        if (!producto) {
            this.notification.add(
                `No se encontró ningún producto con el código "${codigo}".`,
                {type: "warning"}
            );
            return;
        }
        this.agregarProducto(producto);
        this.notification.add(`Agregado: ${producto.name}`, {type: "success"});
    }

    detenerEscaneo() {
        this.state.escaneando = false;
        if (this.intervaloEscaneo) {
            clearInterval(this.intervaloEscaneo);
            this.intervaloEscaneo = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach((track) => track.stop());
            this.stream = null;
        }
        if (this.videoRef.el) {
            this.videoRef.el.srcObject = null;
        }
        this.detector = null;
    }

    /**
     * Arma las líneas en el formato que espera el backend
     * (_crear_lineas_pedido) -- las de recompensa van marcadas
     * es_recompensa/regla_id: el backend NO crea un sale.order.line a
     * mano para esas (por eso ya no manda price_unit/cantidad de
     * regalo), sino que reclama la promo contra el motor nativo de
     * lealtad de Odoo, que calcula solo cuántas unidades gratis
     * corresponden según los puntos reales del pedido (ver
     * _shalom_reclamar_recompensas_nativas en fsm_order.py).
     */
    lineasParaBackend(items) {
        return items.map((item) => ({
            product_id: item.producto.id,
            qty: item.cantidad,
            es_recompensa: !!item.esRecompensa,
            regla_id: item.reglaId || false,
        }));
    }

    // -- Confirmar pedido (venta real) --

    async confirmarPedido() {
        const items = this.itemsCarrito;
        if (!items.length) {
            this.notification.add("El carrito está vacío.", {type: "warning"});
            return;
        }
        // Último aviso, no bloqueante, de que al cliente le faltan
        // datos (punto 4) -- se muestra una sola vez por esta sesión
        // del carrito (omitirAvisoDatosFaltantes), no en cada click de
        // "Finalizar a orden de venta". Mismo aviso que revisarCotizacion().
        if (this._debeAvisarDatosFaltantes) {
            this.state.accionPendienteAvisoDatos = "confirmar";
            this.state.mostrandoAvisoConfirmar = true;
            return;
        }
        await this._confirmarPedidoDeVerdad();
    }

    async _confirmarPedidoDeVerdad() {
        const items = this.itemsCarrito;
        const mensaje =
            `Vas a finalizar una cotización a orden de venta de ` +
            `${this.cantidadItems} producto(s) por $${this.total.toFixed(2)} para ` +
            `"${this.props.clienteNombre}".\n\n` +
            "Esto genera una venta real y reserva el stock ahora mismo. La " +
            "factura se genera después, en oficina.\n\n¿Confirmás que querés continuar?";
        // eslint-disable-next-line no-alert
        if (!window.confirm(mensaje)) {
            return;
        }
        this.state.confirmando = true;
        try {
            const lineas = this.lineasParaBackend(items);
            const resultado = await this.orm.call("fsm.order", "shalom_confirmar_pedido", [
                [this.props.orderId],
                lineas,
            ]);
            this.notification.add(
                `Pedido confirmado: ${resultado.sale_order_name} ($${resultado.total.toFixed(2)}).`,
                {type: "success"}
            );
            if (this.props.onConfirmado) {
                this.props.onConfirmado();
            }
            this.cerrarDeVerdad();
        } catch (error) {
            console.error("shalom: error al confirmar pedido", error);
            const mensajeServidor = error && error.data && error.data.message;
            this.notification.add(
                mensajeServidor || "No se pudo confirmar el pedido.",
                {type: "danger"}
            );
        } finally {
            this.state.confirmando = false;
        }
    }

    // -- Revisar cotización (guarda borrador y abre Ventas) --

    async revisarCotizacion() {
        const items = this.itemsCarrito;
        if (!items.length) {
            this.notification.add("El carrito está vacío.", {type: "warning"});
            return;
        }
        // Mismo aviso que confirmarPedido() -- ver _debeAvisarDatosFaltantes.
        if (this._debeAvisarDatosFaltantes) {
            this.state.accionPendienteAvisoDatos = "revisar";
            this.state.mostrandoAvisoConfirmar = true;
            return;
        }
        await this._revisarCotizacionDeVerdad();
    }

    async _revisarCotizacionDeVerdad() {
        const items = this.itemsCarrito;
        this.state.guardandoBorrador = true;
        try {
            const lineas = this.lineasParaBackend(items);
            const resultado = await this.orm.call(
                "fsm.order",
                "shalom_guardar_borrador_pedido",
                [[this.props.orderId], lineas]
            );
            if (this.props.onRevisado) {
                this.props.onRevisado();
            }
            const accion = normalizarAccionActWindow(resultado);
            // Cerrar ANTES del doAction (no después, y sin ningún
            // history.back() de por medio -- eso era justo lo que
            // rompía la redirección): así OrderScreen ya no está
            // montado por encima cuando el formulario de Ventas se
            // abre.
            this.cerrarDeVerdad();
            this.action.doAction(accion);
        } catch (error) {
            console.error("shalom: error al guardar borrador de pedido", error);
            const mensajeServidor = error && error.data && error.data.message;
            this.notification.add(
                mensajeServidor || "No se pudo guardar la cotización.",
                {type: "danger"}
            );
        } finally {
            this.state.guardandoBorrador = false;
        }
    }

    // -- Cerrar la pantalla --

    /**
     * Botón "←" del header: si estamos en el carrito, un paso hacia
     * atrás es volver al catálogo (no perder nada, el carrito sigue
     * en memoria); si estamos en el catálogo, es intentar salir de
     * esta pantalla.
     */
    atras() {
        if (this.state.pantalla === "carrito") {
            this.irACatalogo();
        } else {
            this.intentarSalir();
        }
    }

    /**
     * Si el carrito tiene productos sin guardar como cotización, no
     * cierra directo: muestra un aviso propio primero. Si está vacío,
     * cierra sin preguntar.
     *
     * SOLO la sesión "principal" (la que abrió el catálogo primero,
     * ver state.esPrincipal) ve este aviso -- riesgo real reportado:
     * un vendedor/cliente mirando en paralelo ("Ver en vivo") podía
     * tocar "Salir sin guardar" y descartar el carrito de OTRO
     * dispositivo sin darse cuenta de que no era el suyo. Cualquier
     * sesión que no sea la principal sale directo, sin preguntar y
     * SIN tocar el carrito compartido para nada.
     */
    intentarSalir() {
        if (!this.cantidadItems || !this.state.esPrincipal) {
            cerrarConAnimacion(this.state, () => this.cerrarDeVerdad());
            return;
        }
        this.state.confirmandoSalida = true;
    }

    cancelarSalir() {
        this.state.confirmandoSalida = false;
    }

    confirmarSalirSinGuardar() {
        this.state.confirmandoSalida = false;
        // Además de limpiar localStorage (ver cerrarDeVerdad), avisarle
        // al servidor que también limpie x_carrito_borrador -- bug real
        // reportado: sin esto, el carrito "descartado a propósito" volvía
        // a aparecer solo al reabrir esta visita desde cualquier
        // dispositivo, porque el snapshot del servidor seguía ahí y
        // quedaba como el más nuevo frente a un localStorage ya vacío.
        // Best-effort: si falla (sin señal en ese instante), no bloquea
        // la salida -- la limpieza mensual automática es la red de
        // seguridad para ese caso (ver shalom_limpiar_carritos_viejos
        // en fsm_order.py).
        this.orm.call("fsm.order", "shalom_limpiar_carrito", [[this.props.orderId]]).catch(() => {});
        cerrarConAnimacion(this.state, () => this.cerrarDeVerdad());
    }

    /**
     * Cierre real -- con guarda de idempotencia por si algo dispara el
     * cierre dos veces (ej. un click fantasma después de un touch en
     * otra parte de la pantalla).
     *
     * OJO: a propósito NO pasa por cerrarConAnimacion() en
     * confirmarPedido()/revisarCotizacion() -- ahí se llama directo,
     * sin animación, porque el comentario de revisarCotizacion() ya
     * advertía que OrderScreen tiene que estar REALMENTE desmontado
     * antes del doAction() que le sigue (si no, se repite un bug ya
     * arreglado de la pantalla quedando montada por encima del
     * formulario de Ventas). El resto de las salidas (intentarSalir,
     * confirmarSalirSinGuardar) sí animan porque no hay ningún doAction
     * inmediatamente después.
     */
    cerrarDeVerdad() {
        if (this._cerrado) {
            return;
        }
        this._cerrado = true;
        this.detenerEscaneo();
        // Único punto de cierre intencional (carrito vacío, "Salir sin
        // guardar", pedido confirmado, cotización guardada) -- se
        // limpia acá el borrador de recuperación para que no quede
        // colgado. Un cierre accidental (botón/gesto atrás de Android)
        // no pasa por acá, así que ahí el borrador queda intacto.
        this._borrarBorradorCarrito();
        this.props.onCerrar();
    }
}
