/** @odoo-module **/

import {Component, onWillStart, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {normalizarAccionActWindow} from "./action_utils";

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

export class OrderScreen extends Component {
    static template = "shalom_location_map.OrderScreen";
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
        });

        onWillStart(() => this.cargarProductos());
        onWillUnmount(() => this.detenerEscaneo());

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

    get categoriasFiltradas() {
        const texto = this.state.busquedaCategoria.trim().toLowerCase();
        if (!texto) {
            return this.categorias;
        }
        return this.categorias.filter((c) => c.nombre.toLowerCase().includes(texto));
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
    }

    quitarDelCarrito(productoId) {
        delete this.state.carrito[productoId];
        this.actualizarPromos();
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
    // ya completa) -- misma lógica que el módulo de Ventas: se canjea
    // una promo a la vez; si hay más de una disponible, el vendedor
    // elige cuál primero. El botón deja de mostrarse cuando ya no
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
        this.state.carrito[key] = {
            producto: {
                id: recompensa.reward_product_id,
                name: recompensa.reward_product_name,
                list_price: 0,
                qty_available: 0,
                categ_id: false,
            },
            cantidad: (actual ? actual.cantidad : 0) + recompensa.reward_qty,
            esRecompensa: true,
            reglaId: recompensa.regla_id,
        };
        this.state.recompensaMenuAbierto = false;
        this.notification.add(`🎁 Recompensa agregada: ${recompensa.reward_product_name}`, {
            type: "success",
        });
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
     * (_crear_lineas_pedido) -- las de recompensa van con
     * price_unit: 0 explícito (si no, Odoo les calcularía el precio de
     * lista normal al crear la línea).
     */
    lineasParaBackend(items) {
        return items.map((item) => ({
            product_id: item.producto.id,
            qty: item.cantidad,
            price_unit: item.esRecompensa ? 0 : false,
        }));
    }

    // -- Confirmar pedido (venta real) --

    async confirmarPedido() {
        const items = this.itemsCarrito;
        if (!items.length) {
            this.notification.add("El carrito está vacío.", {type: "warning"});
            return;
        }
        const mensaje =
            `Vas a confirmar un pedido de ${this.cantidadItems} producto(s) por ` +
            `$${this.total.toFixed(2)} para "${this.props.clienteNombre}".\n\n` +
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
     */
    intentarSalir() {
        if (!this.cantidadItems) {
            this.cerrarDeVerdad();
            return;
        }
        this.state.confirmandoSalida = true;
    }

    cancelarSalir() {
        this.state.confirmandoSalida = false;
    }

    confirmarSalirSinGuardar() {
        this.state.confirmandoSalida = false;
        this.cerrarDeVerdad();
    }

    /**
     * Cierre real -- con guarda de idempotencia por si algo dispara el
     * cierre dos veces (ej. un click fantasma después de un touch en
     * otra parte de la pantalla).
     */
    cerrarDeVerdad() {
        if (this._cerrado) {
            return;
        }
        this._cerrado = true;
        this.detenerEscaneo();
        this.props.onCerrar();
    }
}
