/** @odoo-module **/

import {Component, onMounted, onWillStart, onWillUnmount, useEffect, useRef, useState} from "@odoo/owl";
import {useService} from "@web/core/utils/hooks";
import {DateTimeInput} from "@web/core/datetime/datetime_input";
import {normalizarAccionActWindow} from "./action_utils";
import {cerrarConAnimacion} from "./animacion_utils";
import {abrirNivel, cerrarNivel, marcarNivel, marcarRetorno} from "./back_stack";
import {ClienteForm} from "./cliente_form";
import {TemaSelector} from "./tema_selector";
import {PASOS_CATALOGO, RecorridoGuiado, marcarRecorrido, recorridoPendiente} from "./recorrido";
import {conTimeout, iniciarSondeo, sinConexion} from "./red_utils";
import {leerLocal} from "./almacen_local";
import {
    esErrorDeRed,
    traerCatalogo,
    traerFaltantes,
    traerFormasPago,
    traerPedidosAnteriores,
    traerUltimaFormaPago,
    urlFotoProducto,
} from "./datos_offline";
import {descartar, encolar, esperarResultado, iniciarSincronizador} from "./sincronizador";
import {IndicadorConexion} from "./indicador_conexion";
import {esProvisorio} from "./clientes_offline";
import {normalizarBusqueda} from "./busqueda_utils";

// Modo offline: cuánto se espera la confirmación del servidor antes de
// dejar el pedido guardado en el teléfono ("se envía con señal"). Un
// pedido grande puede tardar en confirmarse; con buena señal llega antes.
const ESPERA_PEDIDO_MS = 45000;

const {DateTime} = luxon;

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
 * Cierre: se probó primero con history.pushState/popstate propios y se
 * sacó por completo por chocar con el router de Odoo 18 (el síntoma
 * más claro: "Revisar cotización" guardaba el borrador bien, pero
 * nunca redirigía al formulario de Ventas, porque un history.back()
 * de antes se comía la navegación). Un segundo diseño (intra-sesión,
 * ya también reemplazado) intentaba interceptar el Atrás con una
 * "pila" en memoria -- funcionaba en su propia lógica, pero se
 * descubrió que Odoo recarga la acción del cliente (ShalomRutaApp)
 * entera en CUALQUIER Atrás real, sin esperar a que el código de la
 * app reaccione, así que no alcanzaba. El mecanismo actual (ver
 * back_stack.js) ya no intercepta nada: el catálogo y el carrito
 * empujan/cierran su propio nivel (abrirNivel/cerrarNivel) y, si Odoo
 * recarga todo, ShalomRutaApp reconstruye la pantalla exacta a partir
 * de lo guardado -- ver el comentario grande de back_stack.js para el
 * mecanismo completo. Como consecuencia de esto, el cierre por Atrás
 * de Android real YA NO PUEDE mostrar el aviso de "salir sin guardar"
 * (no hay forma de "cancelar" una navegación real del navegador) --
 * mismo criterio que ya se había decidido explícitamente para ese
 * caso: se sigue confiando en el snapshot de localStorage de 30 min
 * para recuperar el carrito si hace falta (ver más abajo).
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
// "atrás" de Android, que a propósito cierra directo sin el aviso (ver
// el comentario grande al principio del archivo). Sin nada más, eso
// perdía el carrito entero sin ningún aviso. Se guarda un snapshot en
// localStorage en cada cambio
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

// Límite de espera de cada llamada del ciclo de sincronización (modo
// offline, Fase 0): sin esto, una llamada colgada por señal fantasma
// congelaba el ciclo entero (tiene candado de "uno a la vez"). Si
// falla o se corta, el ciclo se espacia solo (2, 4, 8... hasta 30 seg)
// y vuelve a 1 seg en cuanto hay señal -- ver iniciarSondeo().
const SHALOM_SYNC_TIMEOUT_MS = 8000;
const SHALOM_SYNC_TOPE_MS = 30000;

// Fotos del catálogo (modo offline, Fase 0): image_512 en vez de
// image_1024 -- las tarjetas miden 120-200 px, así que 512 sigue
// nítida en pantallas de alta densidad pesando ~4 veces menos. Y con
// "unique" en la URL, Odoo la sirve como inmutable: el teléfono la
// guarda y no la vuelve a pedir en todo el día (sin "unique", cada
// foto se re-validaba contra el servidor en cada carga, 80 idas y
// vueltas por página en 3G). La marca es la fecha del día: una foto
// cambiada en Odoo se ve al día siguiente.
const TAMANO_FOTO_TARJETA = "image_512";

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

// Vista del catálogo (lista compacta o cuadrícula): cada aparato recuerda
// la última que eligió el vendedor; la primera vez, cuadrícula en tablet y
// lista en celular. localStorage puede fallar (modo privado): nunca rompe.
const CLAVE_VISTA_CATALOGO = "shalom_catalogo_vista";

// Catálogo ya descargado (productos + existencias + estrategias): al
// volver a abrir "Tomar pedido" se muestra al instante y se refresca por
// detrás. Más de 700 productos con existencias de dos bodegas tardaban
// varios segundos en cada apertura.
let CACHE_CATALOGO = null; // {ts, productos, estrategias}
const CACHE_CATALOGO_MS = 15 * 60 * 1000;

// Catálogo SIEMPRE en orden alfabético (pedido explícito), también al
// filtrar por categoría o buscar. El orden del servidor ("name asc") usa la
// colación de la base de datos: mayúsculas antes que minúsculas, tildes al
// final... por eso a veces se veía desordenado. Español, sin distinguir
// mayúsculas ni tildes, y números en orden natural ("Tinte 2" antes que
// "Tinte 10").
const COLADOR_NOMBRES = new Intl.Collator("es", {sensitivity: "base", numeric: true});

export function ordenarAlfabetico(productos) {
    return [...(productos || [])].sort((a, b) => COLADOR_NOMBRES.compare(a.name || "", b.name || "") || a.id - b.id);
}

function shalomVistaCatalogoInicial() {
    try {
        const guardada = window.localStorage.getItem(CLAVE_VISTA_CATALOGO);
        if (guardada === "lista" || guardada === "cuadricula") {
            return guardada;
        }
    } catch {
        // sin almacenamiento: se usa el valor según el ancho
    }
    return window.matchMedia && window.matchMedia("(min-width: 768px)").matches ? "cuadricula" : "lista";
}

// Dónde estaba el vendedor en el catálogo (página, búsqueda, categoría,
// "Con stock" y scroll), por visita. Bug real reportado: con el Atrás de
// Android (o del navegador) estando en la foto ampliada, Odoo recarga la
// app entera (ver back_stack.js) y el catálogo volvía a la página 1 sin
// filtros. Ahora se reconstruye exactamente donde estaba: el Atrás solo
// cierra la foto. sessionStorage (vive lo que la pestaña); se borra al
// cerrar el catálogo con sus propios controles o al confirmar.
const VIDA_VISTA_GUARDADA_MS = 2 * 3600 * 1000;

function claveVistaGuardada(orderId) {
    return `shalom_catalogo_donde_${orderId}`;
}

function leerVistaGuardada(orderId) {
    try {
        const v = JSON.parse(window.sessionStorage.getItem(claveVistaGuardada(orderId)) || "null");
        if (v && Date.now() - (v.en || 0) < VIDA_VISTA_GUARDADA_MS) {
            return v;
        }
    } catch {
        // sin almacenamiento o dato roto: se arranca de cero
    }
    return null;
}

// Cabecera que se esconde al bajar (histéresis): hay que bajar/subir un
// trecho SEGUIDO para que cambie, así un vistazo arriba y abajo no la
// hace aparecer y desaparecer.
const CABECERA_ESCONDER_PX = 48;
const CABECERA_MOSTRAR_PX = 72;

export class OrderScreen extends Component {
    static template = "shalom_location_map.OrderScreen";
    static components = {ClienteForm, DateTimeInput, TemaSelector, RecorridoGuiado, IndicadorConexion};
    static props = {
        orderId: Number,
        // Lo que sigue en la pila de navegación guardada después de
        // este catálogo (ver el comentario grande de back_stack.js) --
        // vacío en la apertura normal ("Tomar pedido"); trae
        // {tipo:"carrito"} cuando se está reconstruyendo tras un
        // Atrás/recargado con el carrito abierto.
        pilaRestante: {type: Array, optional: true},
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
        this.raizRef = useRef("raiz");
        this.pasosRecorrido = PASOS_CATALOGO;
        this.fotoLienzoRef = useRef("fotoLienzo");
        this.fotoImgRef = useRef("fotoAmpliadaImg");
        this.listaCatalogoRef = useRef("listaCatalogo");
        this.topbarRef = useRef("topbar");
        this.cabeceraRef = useRef("cabecera");
        // Cabecera flotante (se desliza sobre la lista sin cambiar su alto):
        // necesita medir su altura; sin ResizeObserver, como antes.
        this.cabeceraFlotante = typeof ResizeObserver !== "undefined";
        const donde = leerVistaGuardada(this.props.orderId);
        this._scrollPendiente = donde ? donde.scroll || 0 : 0;
        this._scrollActual = this._scrollPendiente;
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
        this._syncSondeo = null;
        // Cola offline (ver sincronizador.js): con el orm SIN protección
        // de componente, para que siga enviando aunque esta pantalla se cierre.
        iniciarSincronizador((this.env.services && this.env.services.orm) || this.orm, this.notification);
        this._sesionId = shalomIdSesionCatalogo();
        this._sesionCerrada = false; // guarda para no llamar shalom_cerrar_sesion_catalogo dos veces

        // Auto-abre el carrito si props.pilaRestante lo indica (ver el
        // comentario grande de back_stack.js) -- reconstrucción tras
        // un Atrás/recargado con el carrito abierto.
        const nivelInicial =
            this.props.pilaRestante && this.props.pilaRestante.length
                ? this.props.pilaRestante[0]
                : null;
        const carritoInicial = !!(nivelInicial && nivelInicial.tipo === "carrito");
        // La foto en grande y la hoja de "Pedidos anteriores" no se
        // reabren solas: si quedaron en la pila (Odoo recargó por otro
        // motivo que no fue el Atrás que las cierra), se sacan para no
        // dejar un Atrás "muerto" de más.
        const restante = this.props.pilaRestante || [];
        for (let i = restante.length - 1; i >= 0 && ["foto", "precarga"].includes(restante[i].tipo); i--) {
            cerrarNivel();
        }

        this.state = useState({
            cargando: true,
            pantalla: carritoInicial ? "carrito" : "catalogo",
            productos: [],
            busqueda: (donde && donde.busqueda) || "",
            categoriaSeleccionada: donde && donde.categoria !== undefined ? donde.categoria : CATEGORIA_TODAS,
            categMenuAbierto: false,
            busquedaCategoria: "",
            soloConStock: !!(donde && donde.soloConStock),
            paginaActual: (donde && donde.pagina) || 1,
            vistaCatalogo: shalomVistaCatalogoInicial(),
            // Cabecera compacta: el medidor se despliega al tocarlo, y toda
            // la cabecera se esconde al bajar por el catálogo (vuelve al subir).
            medidorAbierto: false,
            cabeceraOculta: false,
            // Foto en grande: {url, nombre} | null.
            fotoAmpliada: null,
            recorridoAbierto: false,
            carrito: {}, // {productId: {producto, cantidad}}
            // "Precargar de pedidos anteriores" (Fase 1 del juego de
            // ventas): hoja con los últimos pedidos del cliente, para
            // copiar uno completo o productos sueltos al carrito.
            // Pantalla de resultado tras confirmar (estrellas, XP, nivel);
            // null = no se muestra. Ver _confirmarPedidoDeVerdad.
            resultadoJuego: null,
            // {product_id: "empujar" | "no_ofrecer"} -- Estrategias
            // vigentes (solo marcan en el catálogo, nunca bloquean).
            estrategiaPorProducto: {},
            // Estrellas y margen en vivo contra la vara del cliente
            // (shalom_evaluar_pedido). Informativo: no bloquea nada.
            evaluacion: null,
            precargaAbierta: false,
            cargandoPrecarga: false,
            pedidosAnteriores: [], // [{id, nombre, fecha, total, lineas: [{product_id, nombre, cantidad}]}]
            pedidoPrecargaAbierto: null, // id del pedido con sus líneas desplegadas
            promoPorProducto: {}, // {productId: "✅ Tienes..." | "⏳ Faltan..."}
            promoDetallePorProducto: {}, // {productId: {completa, completas, faltan}}
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
            // Pop-up OBLIGATORIO de Forma de Pago + Fecha especial de
            // entrega + Incluye ITBMS, SOLO en el flujo de "Confirmar
            // pedido" (nunca en "Revisar cotización") -- ver
            // _abrirPopupFormaPago() más abajo y el punto 11 del
            // docstring grande de fsm_order.py. formasPagoDisponibles
            // se carga una sola vez (es catálogo fijo, no depende del
            // cliente) y se reusa en cada apertura.
            mostrandoFormaPago: false,
            cargandoFormaPago: false,
            formasPagoDisponibles: [], // [{value, label}]
            formaPagoSeleccionada: false,
            // null (sin fecha especial) o luxon DateTime -- mismo
            // widget nativo de calendario que ya usa admin_gestion.js
            // para Visita Exprés (DateTimeInput), no un <input
            // type="date"> a mano: pedido explícito, para que el
            // selector sea el mismo que el resto de Odoo (calendario
            // con hoy resaltado, sin escribir día/mes/año a mano) y
            // que el popover se reposicione solo en celular.
            fechaEntregaEspecial: null,
            // Puramente informativo (custom_itbms_required, ver
            // shalom_confirmar_pedido en fsm_order.py) -- no toca
            // ningún cálculo de impuestos acá, es para que Dianke (el
            // proveedor que entrega, no Shalom) sepa si cobrar ITBMS.
            // Default apagado (el 99% de los clientes no lo quiere,
            // mismo criterio que shalom_ultima_forma_pago_e_itbms en
            // fsm_order.py) -- _abrirPopupFormaPago() lo pisa con el
            // valor real apenas responde el backend.
            incluyeItbms: false,
            // "Principal" (ver el docstring grande de
            // CLAVE_SESION_CATALOGO más arriba): true hasta el primer
            // heartbeat -- así, si esta pestaña está sola (caso normal,
            // sin nadie más mirando), el aviso de "salir sin guardar"
            // sigue funcionando desde el instante en que se abre,
            // sin esperar el primer tick de sincronización.
            esPrincipal: true,
        });

        this._restaurarBorradorCarritoSiCorresponde();

        // Recordar dónde está el vendedor en el catálogo (ver
        // leerVistaGuardada) cada vez que cambia la página o un filtro.
        useEffect(
            () => this._guardarDonde(),
            () => [this.state.paginaActual, this.state.busqueda, this.state.categoriaSeleccionada, this.state.soloConStock]
        );
        // Cuando el catálogo ya está dibujado: página dentro del rango y
        // el scroll donde estaba.
        useEffect(
            () => {
                if (this.state.cargando || this.state.pantalla !== "catalogo") {
                    return;
                }
                if (this.state.paginaActual > this.totalPaginas) {
                    this.state.paginaActual = this.totalPaginas;
                }
                const lista = this.listaCatalogoRef.el;
                if (this._scrollPendiente && lista) {
                    const y = this._scrollPendiente;
                    this._scrollPendiente = 0;
                    lista.scrollTop = y;
                    requestAnimationFrame(() => {
                        if (this.listaCatalogoRef.el && this.listaCatalogoRef.el.scrollTop < y) {
                            this.listaCatalogoRef.el.scrollTop = y;
                        }
                    });
                }
            },
            () => [this.state.cargando, this.state.pantalla, this.listaCatalogoRef.el]
        );
        // Alturas de la barra superior y de la cabecera, para que la
        // cabecera flote sobre la lista y la lista le deje su lugar.
        onMounted(() => {
            if (!this.cabeceraFlotante || !this.raizRef.el) {
                return;
            }
            this._observadorAlturas = new ResizeObserver(() => this._medirCabecera());
            for (const ref of [this.topbarRef, this.cabeceraRef]) {
                if (ref.el) {
                    this._observadorAlturas.observe(ref.el);
                }
            }
            this._medirCabecera();
        });

        // La pantalla aparece YA (con "Cargando catálogo…") y la carga
        // corre por detrás: antes no se veía nada hasta tener todo.
        onWillStart(() => {
            this._cargarInicial();
        });

        // El nivel de navegación de ESTA pantalla (el catálogo en sí)
        // lo empuja/cierra quien la abre -- VisitSheet.tomarPedido()/
        // cerrarPedido() -- no acá (ver el comentario grande al
        // principio del archivo: si esta pantalla se auto-abre al
        // reconstruir tras un Atrás/recargado, ESE nivel ya está
        // representado en lo guardado, empujarlo de nuevo acá
        // duplicaría la entrada). El carrito, en cambio, es un
        // sub-nivel que SÍ maneja esta misma pantalla directo -- ver
        // irACarrito()/irACatalogo() más abajo.
        onWillUnmount(() => {
            this._destruido = true;
            if (this._observadorAlturas) {
                this._observadorAlturas.disconnect();
            }
            clearTimeout(this._guardarDondeTimer);
            this.detenerEscaneo();
            if (this._syncSondeo) {
                this._syncSondeo.detener();
            }
            if (this._evalTimer) {
                clearTimeout(this._evalTimer);
            }
            this._cerrarSesionCatalogo();
        });
        // Ritmo fijo de ~1 seg con buena señal (el servidor considera
        // "cerrado" un catálogo sin latido en 3 seg, ver
        // SHALOM_SEGUNDOS_CARRITO_ACTIVO); se espacia solo si falla.
        // No se pausa con la pestaña oculta: mismo comportamiento de
        // siempre para "Ver en vivo".
        this._syncSondeo = iniciarSondeo(() => this._tickSincronizacionCarrito(), {
            intervaloMs: SHALOM_SYNC_INTERVALO_MS,
            topeMs: SHALOM_SYNC_TOPE_MS,
            pausarSiOculto: false,
            ritmoFijo: true,
        });

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
            // Momento en que se agregó (para mostrar el carrito en ese
            // orden en todos los dispositivos). El servidor guarda la
            // línea tal cual.
            orden: item.orden || 0,
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
            const enCatalogo = this.productoDeLinea(linea);
            carrito[clave] = {
                // Productos normales: el MISMO objeto del catálogo (trae la
                // versión de la foto, foto_v: así la foto sale de lo
                // guardado en el teléfono y no se vuelve a bajar).
                producto:
                    enCatalogo && !linea.es_recompensa
                        ? enCatalogo
                        : {
                              id: linea.product_id,
                              name: linea.name,
                              list_price: linea.list_price,
                              qty_available: enCatalogo ? enCatalogo.qty_available : 0,
                              categ_id: enCatalogo ? enCatalogo.categ_id : false,
                          },
                cantidad: linea.cantidad,
                esRecompensa: !!linea.es_recompensa,
                reglaId: linea.regla_id || false,
                orden: linea.orden || 0,
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
        if (sinConexion() || this.esVisitaProvisoria) {
            // sin señal, o cliente creado sin señal (todavía no existe en
            // el servidor): manda el carrito del teléfono
            return;
        }
        try {
            resultado = await conTimeout(
                this.orm.call("fsm.order", "shalom_leer_carrito", [[this.props.orderId]]),
                SHALOM_SYNC_TIMEOUT_MS
            );
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
        if (this.esVisitaProvisoria) {
            return;
        }
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
        if (this._sincronizando || this._cerrado || this._confirmado || this.esVisitaProvisoria) {
            // Visita de un cliente creado sin señal: el carrito queda solo en
            // el teléfono hasta confirmar (no hay registro en el servidor).
            return;
        }
        // Bug real reportado: en pedidos grandes, "Confirmar pedido"/
        // "Revisar cotización" quedaba cargando y nunca creaba nada,
        // con "could not serialize access due to concurrent update" en
        // el servidor. Causa: este tick sigue corriendo cada ~1 seg de
        // fondo (heartbeat + guardado de carrito) mientras se espera
        // esa respuesta, y ambas llamadas escriben sobre la MISMA fila
        // de fsm.order que shalom_confirmar_pedido/
        // shalom_guardar_borrador_pedido están tocando en su propia
        // transacción -- en pedidos chicos esa transacción es tan
        // rápida que casi nunca se cruza con el tick, en pedidos
        // grandes tarda más y el choque se vuelve casi seguro,
        // abortando toda la confirmación. Se pausa el tick durante esa
        // ventana para no competir por la misma fila.
        if (this.state.confirmando || this.state.guardandoBorrador) {
            return;
        }
        this._sincronizando = true;
        // false = algo falló por red: iniciarSondeo() espacia el próximo
        // intento (2, 4, 8... seg) en vez de insistir cada segundo.
        let ok = true;
        try {
            try {
                const heartbeat = await conTimeout(
                    this.orm.call("fsm.order", "shalom_marcar_catalogo_abierto", [
                        [this.props.orderId], this._sesionId,
                    ]),
                    SHALOM_SYNC_TIMEOUT_MS
                );
                this.state.esPrincipal = heartbeat.es_principal;
            } catch (error) {
                // Sin señal: no se sabe si sigue siendo principal --
                // se deja el último valor conocido, no se asume nada.
                // Tampoco se insiste con el carrito en este mismo tick:
                // si el latido no pasó, lo demás tampoco va a pasar.
                ok = false;
                return ok;
            }

            const hayPendientes =
                Object.keys(this._cambiosPendientes).length || this._eliminadosPendientes.size;
            if (hayPendientes) {
                const cambios = this._cambiosPendientes;
                const eliminados = Array.from(this._eliminadosPendientes);
                this._cambiosPendientes = {};
                this._eliminadosPendientes = new Set();
                let resultado;
                try {
                    resultado = await conTimeout(
                        this.orm.call("fsm.order", "shalom_actualizar_carrito", [
                            [this.props.orderId],
                            cambios,
                            eliminados,
                        ]),
                        SHALOM_SYNC_TIMEOUT_MS
                    );
                } catch (error) {
                    // Antes, si este envío fallaba (sin señal), esos
                    // cambios quedaban fuera de la lista de pendientes y
                    // nunca llegaban al respaldo del servidor. Se
                    // devuelven a la lista -- salvo las claves que el
                    // vendedor volvió a tocar mientras tanto (esas ya
                    // tienen un valor local más nuevo anotado).
                    this._devolverPendientes(cambios, eliminados);
                    throw error;
                }
                this._ultimaActualizadaConocida = resultado.actualizado;
                this._aplicarCarritoServidor(resultado.carrito);
                this.actualizarPromos();
            } else {
                const resultado = await conTimeout(
                    this.orm.call("fsm.order", "shalom_leer_carrito", [
                        [this.props.orderId],
                    ]),
                    SHALOM_SYNC_TIMEOUT_MS
                );
                // Chequeo de nuevo DESPUÉS de esperar la respuesta: el
                // vendedor pudo haber tocado el carrito MIENTRAS se
                // esperaba -- si es así, no se aplica esta foto vieja
                // del servidor (se resuelve solo en el próximo tick,
                // que va a ver pendientes y hacer el push).
                const siguenSinPendientes =
                    !Object.keys(this._cambiosPendientes).length && !this._eliminadosPendientes.size;
                if (!siguenSinPendientes) {
                    return ok;
                }
                if (resultado.actualizado === this._ultimaActualizadaConocida) {
                    return ok; // nada nuevo -- no re-dibujar la pantalla porque sí
                }
                this._ultimaActualizadaConocida = resultado.actualizado;
                this._aplicarCarritoServidor(resultado.carrito);
                this.actualizarPromos();
            }
        } catch (error) {
            // Sin conexión u otro error transitorio -- se reintenta
            // solo en el próximo tick, no interrumpe al vendedor.
            ok = false;
        } finally {
            this._sincronizando = false;
        }
        return ok;
    }

    /** Devuelve a la lista de pendientes los cambios de un envío que
     * falló (ver _tickSincronizacionCarrito), sin pisar lo que el
     * vendedor haya tocado DESPUÉS de armar ese envío: si una clave ya
     * está otra vez en _cambiosPendientes o _eliminadosPendientes, ese
     * valor es más nuevo y gana. */
    _devolverPendientes(cambios, eliminados) {
        for (const [clave, linea] of Object.entries(cambios)) {
            if (!(clave in this._cambiosPendientes) && !this._eliminadosPendientes.has(clave)) {
                this._cambiosPendientes[clave] = linea;
            }
        }
        for (const clave of eliminados) {
            if (!(clave in this._cambiosPendientes)) {
                this._eliminadosPendientes.add(clave);
            }
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
            const {locationId, datosFaltantes} = await traerFaltantes(this.orm, this.props.orderId);
            this.state.locationId = locationId;
            this.state.datosFaltantes = datosFaltantes || [];
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
            await this._abrirPopupFormaPago();
        }
    }

    /** True si corresponde interrumpir con el interstitial de "a este
     * cliente le faltan datos" antes de confirmar/revisar. */
    get _debeAvisarDatosFaltantes() {
        return this.state.datosFaltantes.length > 0 && !this.state.omitirAvisoDatosFaltantes;
    }

    // -- Pop-up OBLIGATORIO de Forma de Pago + Fecha especial de
    // entrega, SOLO al confirmar un pedido -- ver el punto 11 del
    // docstring grande de fsm_order.py. A diferencia del aviso de
    // "datos del cliente" (condicional, arriba), este SIEMPRE
    // aparece antes de _confirmarPedidoDeVerdad(), sin excepción.

    /** Abre el pop-up y lo precarga: Forma de Pago e Incluye ITBMS con
     * la última elección de este cliente (shalom_ultima_forma_pago_e_itbms,
     * las dos editables igual) y Fecha especial de entrega vacía por
     * defecto. formasPagoDisponibles se pide una sola vez (catálogo
     * fijo, no depende del cliente) y se reusa en cada apertura
     * siguiente del carrito. */
    async _abrirPopupFormaPago() {
        this.state.mostrandoFormaPago = true;
        this.state.cargandoFormaPago = true;
        this.state.fechaEntregaEspecial = null;
        try {
            if (!this.state.formasPagoDisponibles.length) {
                this.state.formasPagoDisponibles = await traerFormasPago(this.orm);
            }
            if (this.state.locationId) {
                const ultima = await traerUltimaFormaPago(this.orm, this.state.locationId).catch(() => ({
                    // sin señal y sin copia: se elige a mano
                    payment_method: false,
                    includes_itbms: false,
                }));
                this.state.formaPagoSeleccionada = ultima.payment_method;
                this.state.incluyeItbms = ultima.includes_itbms;
            } else {
                this.state.formaPagoSeleccionada = false;
                this.state.incluyeItbms = false;
            }
            if (!this.state.formaPagoSeleccionada && this.state.formasPagoDisponibles.length) {
                this.state.formaPagoSeleccionada = this.state.formasPagoDisponibles[0].value;
            }
        } catch (error) {
            console.error("shalom: error al preparar el pop-up de forma de pago", error);
            this.notification.add("No se pudieron cargar las formas de pago.", {
                type: "danger",
            });
        } finally {
            this.state.cargandoFormaPago = false;
        }
    }

    /** Botón "Cancelar" del pop-up: vuelve al carrito sin confirmar
     * nada (no toca la base). */
    cancelarFormaPago() {
        this.state.mostrandoFormaPago = false;
    }

    /** onChange del DateTimeInput de Fecha especial de entrega --
     * valor es un luxon DateTime (o null si se borra), igual que
     * onCambiarFechaInicioVisitaExpress en admin_gestion.js. */
    onCambiarFechaEntregaEspecial(valor) {
        this.state.fechaEntregaEspecial = valor;
    }

    /** onChange del <select> "Incluye ITBMS" -- el value del <option>
     * es el string "true"/"false" (no un booleano real, limitación del
     * <select> nativo), se convierte acá antes de guardarlo en el
     * estado. */
    onCambiarIncluyeItbms(ev) {
        this.state.incluyeItbms = ev.target.value === "true";
    }

    /** Botón "Confirmar pedido" del pop-up: Forma de Pago es
     * obligatoria (Fecha especial de entrega no). Recién acá se sigue
     * con el flujo real -- window.confirm() nativo + shalom_confirmar_pedido
     * (ver _confirmarPedidoDeVerdad). */
    async confirmarFormaPago() {
        if (!this.state.formaPagoSeleccionada) {
            this.notification.add("Elegí una forma de pago antes de confirmar.", {
                type: "warning",
            });
            return;
        }
        this.state.mostrandoFormaPago = false;
        await this._confirmarPedidoDeVerdad();
    }

    /** Arranque del catálogo. cargarProductos() se resuelve ANTES de
     * reconciliar: _reconciliarCarritoServidorInicial() necesita
     * this.state.productos para buscarle el qty_available a cada línea
     * del servidor. Con catálogo en caché se usa ese al instante y se
     * refresca en silencio. Al final se piden por detrás los pedidos
     * anteriores, para que "Anteriores" abra sin espera. */
    async _cargarInicial() {
        let cache =
            CACHE_CATALOGO && Date.now() - CACHE_CATALOGO.ts < CACHE_CATALOGO_MS ? CACHE_CATALOGO : null;
        if (!cache) {
            // Modo offline: el catálogo guardado en el teléfono ("Preparar
            // mi día" o la última apertura) se muestra AL INSTANTE, con o
            // sin señal, y se refresca por detrás si hay señal.
            const local = await leerLocal("catalogo");
            if (local && local.valor && local.valor.productos) {
                cache = {
                    ts: local.ts,
                    productos: local.valor.productos,
                    estrategias: local.valor.estrategiaPorProducto || {},
                };
            }
        }
        if (cache) {
            this.state.productos = ordenarAlfabetico(cache.productos);
            this.state.estrategiaPorProducto = cache.estrategias;
        }
        try {
            await Promise.all([
                cache ? Promise.resolve() : this.cargarProductos(true, true),
                this._cargarDatosFaltantes(),
            ]);
            if (this._destruido) {
                return;
            }
            await this._reconciliarCarritoServidorInicial();
        } finally {
            if (!this._destruido) {
                this.state.cargando = false;
            }
        }
        if (this._destruido) {
            return;
        }
        if (cache && !sinConexion()) {
            this.cargarProductos(true);
        }
        this._precargarPedidosAnteriores();
        // Recorrido guiado: la primera vez que el vendedor toma un pedido.
        if (this.state.pantalla === "catalogo" && (await recorridoPendiente(this.orm, "catalogo"))) {
            if (!this._destruido && this.state.pantalla === "catalogo") {
                this.state.recorridoAbierto = true;
            }
        }
    }

    abrirRecorrido() {
        // La cabecera tiene que estar a la vista (sus botones son parte
        // del recorrido): se muestra y se espera a que termine de abrirse.
        this.state.cabeceraOculta = false;
        this.state.medidorAbierto = false;
        setTimeout(() => {
            if (!this._destruido) {
                this.state.recorridoAbierto = true;
            }
        }, 260);
    }

    cerrarRecorrido() {
        this.state.recorridoAbierto = false;
        marcarRecorrido(this.orm, "catalogo");
    }

    raizRecorrido() {
        return this.raizRef.el;
    }

    /** `silencioso`: refresco en segundo plano (sin spinner) -- conserva
     * la búsqueda, filtros, página y scroll, porque solo reemplaza los
     * datos de state.productos. Se usa al volver del carrito para que
     * "libres" y "reservados" reflejen lo que se acaba de prometer. */
    async cargarProductos(silencioso = false, avisarError = false) {
        if (!silencioso) {
            this.state.cargando = true;
        }
        try {
            // Productos + existencias por bodega + estrategias, mismas
            // llamadas de siempre, con copia en el teléfono (ver
            // traerCatalogo en datos_offline.js).
            const {productos, estrategiaPorProducto} = await traerCatalogo(this.orm);
            if (this._destruido) {
                return;
            }
            this.state.estrategiaPorProducto = estrategiaPorProducto || {};
            this.state.productos = ordenarAlfabetico(productos);
            CACHE_CATALOGO = {ts: Date.now(), productos: this.state.productos, estrategias: this.state.estrategiaPorProducto};
        } catch (error) {
            if (!silencioso || avisarError) {
                this.notification.add(
                    esErrorDeRed(error)
                        ? "Sin señal y sin catálogo guardado en el teléfono. Usá \"Preparar mi día\" con señal."
                        : "No se pudo cargar el catálogo de productos.",
                    {type: "danger"}
                );
            }
        } finally {
            if (!silencioso) {
                this.state.cargando = false;
            }
        }
    }

    /** Agrega a cada producto stock_dianke / stock_nevada (existencia
     * libre en cada bodega, ver shalom_existencias_bodegas). Si la
     * llamada falla, los productos quedan sin esos campos y la tarjeta
     * muestra la etiqueta única de siempre (infoExistencia): el
     * catálogo nunca depende de este dato para funcionar. */
    async _sumarExistenciasBodegas(productos) {
        try {
            const porProducto = await this.orm.call(
                "fsm.order",
                "shalom_existencias_bodegas",
                [productos.map((producto) => producto.id)]
            );
            for (const producto of productos) {
                const bodegas = porProducto[producto.id];
                if (bodegas) {
                    producto.stock_dianke = bodegas.dianke;
                    producto.stock_nevada = bodegas.nevada;
                    // Unidades por bulto (solo lectura; 0 = sin dato)
                    producto.bulto = bodegas.bulto || 0;
                }
            }
        } catch (error) {
            console.error("shalom: error al leer existencias por bodega", error);
        }
    }

    /** Estrategias vigentes del dueño para marcar productos en el
     * catálogo (EMPUJAR / NO OFRECER). Si falla, no se marca nada. */
    async _cargarEstrategias() {
        try {
            const resultado = await this.orm.call("shalom.estrategia", "shalom_estrategias_vigentes", []);
            this.state.estrategiaPorProducto = resultado.productos || {};
        } catch (error) {
            console.error("shalom: error al leer estrategias", error);
        }
    }

    estrategiaDe(producto) {
        return this.state.estrategiaPorProducto[producto.id] || "";
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
        const texto = normalizarBusqueda(this.state.busqueda).trim();
        return this.state.productos.filter((producto) => {
            if (this.state.soloConStock && !this.tieneStock(producto)) {
                return false;
            }
            if (!texto) {
                return true;
            }
            return (
                normalizarBusqueda(producto.name || "").includes(texto) ||
                normalizarBusqueda(producto.default_code || "").includes(texto) ||
                normalizarBusqueda(producto.barcode || "").includes(texto)
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
        const texto = normalizarBusqueda(this.state.busquedaCategoria).trim();
        if (!texto) {
            return this.categoriasDisponibles;
        }
        return this.categoriasDisponibles.filter((c) => normalizarBusqueda(c.nombre).includes(texto));
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

    _guardarDonde() {
        if (this._cerrado) {
            return;
        }
        try {
            window.sessionStorage.setItem(
                claveVistaGuardada(this.props.orderId),
                JSON.stringify({
                    pagina: this.state.paginaActual,
                    busqueda: this.state.busqueda,
                    categoria: this.state.categoriaSeleccionada,
                    soloConStock: this.state.soloConStock,
                    scroll: Math.round(this._scrollActual || 0),
                    en: Date.now(),
                })
            );
        } catch {
            // sin almacenamiento: solo se pierde la posición tras un Atrás
        }
    }

    _borrarDonde() {
        try {
            window.sessionStorage.removeItem(claveVistaGuardada(this.props.orderId));
        } catch {
            // nada que borrar
        }
    }

    /** Pone en la raíz las alturas de la barra superior y de la cabecera
     * (--alto-topbar / --alto-cabecera), que usa el CSS de la cabecera
     * flotante. */
    _medirCabecera() {
        const raiz = this.raizRef.el;
        if (!raiz) {
            return;
        }
        const topbar = this.topbarRef.el;
        const cabecera = this.cabeceraRef.el;
        this._altoCabecera = cabecera ? cabecera.offsetHeight : 0;
        raiz.style.setProperty("--alto-topbar", `${topbar ? topbar.offsetHeight : 0}px`);
        raiz.style.setProperty("--alto-cabecera", `${this._altoCabecera}px`);
    }

    /** Se recalcula solo si cambió algo que lo afecta: el template lo
     * pide varias veces por dibujado (páginas, cuenta, lista) y filtrar
     * 700+ productos en cada uno se notaba al desplazarse. */
    get productosFiltrados() {
        const clave = [
            this.state.busqueda,
            this.state.categoriaSeleccionada,
            this.state.soloConStock,
        ].join("\u0001");
        if (this._memoFiltro && this._memoFiltro.productos === this.state.productos && this._memoFiltro.clave === clave) {
            return this._memoFiltro.resultado;
        }
        const resultado = this._filtrarProductos();
        this._memoFiltro = {productos: this.state.productos, clave, resultado};
        return resultado;
    }

    _filtrarProductos() {
        const texto = normalizarBusqueda(this.state.busqueda).trim();
        return this.state.productos.filter((producto) => {
            if (
                this.state.categoriaSeleccionada !== CATEGORIA_TODAS &&
                (!producto.categ_id || producto.categ_id[0] !== this.state.categoriaSeleccionada)
            ) {
                return false;
            }
            if (this.state.soloConStock && !this.tieneStock(producto)) {
                return false;
            }
            if (!texto) {
                return true;
            }
            return (
                normalizarBusqueda(producto.name || "").includes(texto) ||
                normalizarBusqueda(producto.default_code || "").includes(texto) ||
                normalizarBusqueda(producto.barcode || "").includes(texto)
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

    cambiarVistaCatalogo(vista) {
        this.state.vistaCatalogo = vista;
        try {
            window.localStorage.setItem(CLAVE_VISTA_CATALOGO, vista);
        } catch {
            // sin almacenamiento: la elección dura solo esta pantalla
        }
    }

    /** Abre la foto del producto a pantalla completa. Es un nivel más
     * del historial (como la ficha de cliente): el Atrás de Android la
     * cierra a ella, no al catálogo entero. */
    abrirFoto(producto) {
        if (this.state.fotoAmpliada) {
            return;
        }
        // Foto progresiva. Bug real reportado ("no aparece la foto, sino el
        // nombre del producto"): se abría directo la de 1024 px, que nunca se
        // había descargado; con señal floja tardaba o fallaba y el navegador
        // mostraba el texto alternativo (el nombre). Ahora:
        //  1. abre AL INSTANTE con la misma foto de la tarjeta (512 px, ya
        //     guardada en el teléfono: misma URL que el catálogo);
        //  2. con señal, baja la de 1024 px por detrás y la cambia recién
        //     cuando terminó de cargar;
        //  3. al acercar (zoom), igual con la original (1920 px).
        // Nunca se reemplaza lo que se ve por algo que no cargó.
        const v = this._versionFoto(producto);
        this.state.fotoAmpliada = {
            url: this._urlFoto(producto.id, TAMANO_FOTO_TARJETA, v),
            urlBase: this._urlFoto(producto.id, TAMANO_FOTO_TARJETA, v),
            urlMini: this._urlFoto(producto.id, "image_256", v),
            urlMedia: this._urlFoto(producto.id, "image_1024", v),
            urlGrande: this._urlFoto(producto.id, "image_1920", v),
            nivel: 0, // 0 = 512 px, 1 = 1024 px, 2 = 1920 px
            sinFoto: false,
            nombre: producto.name,
        };
        this._zoom = {escala: 1, x: 0, y: 0, punteros: new Map(), pinch: null, arrastre: null, ultimoTap: null, movio: false, grandePedida: false};
        abrirNivel({tipo: "foto"});
        this._mejorarFoto(this.state.fotoAmpliada, "urlMedia", 1);
    }

    /** Baja por detrás una versión mejor de la foto ampliada y la muestra
     * solo si cargó bien (y la foto sigue abierta). Sin señal, ni se pide. */
    _mejorarFoto(foto, campo, nivel) {
        if (sinConexion()) {
            return;
        }
        const precarga = new Image();
        precarga.onload = () => {
            const actual = this.state.fotoAmpliada;
            if (actual && actual === foto && actual.nivel < nivel && !actual.sinFoto) {
                actual.url = actual[campo];
                actual.nivel = nivel;
            }
        };
        precarga.src = foto[campo];
    }

    /** Tamaño fijo de la foto en pantalla (el "contain" del lienzo, hasta
     * 1024 px de lado): así, al cambiar de 512 a 1024 px no salta de tamaño,
     * solo se ve más nítida. */
    onFotoAmpliadaCargada(ev) {
        const img = ev.target;
        const lienzo = this.fotoLienzoRef.el;
        if (!lienzo || !img.naturalWidth || !img.naturalHeight) {
            return;
        }
        const r = img.naturalWidth / img.naturalHeight;
        const ancho = Math.min(lienzo.clientWidth, lienzo.clientHeight * r, r >= 1 ? 1024 : 1024 * r);
        if (ancho > 0) {
            img.style.width = `${Math.round(ancho)}px`;
            img.style.height = `${Math.round(ancho / r)}px`;
        }
    }

    /** Si falla la foto que se ve: la mejor vuelve a la de 512 px; la de
     * 512 prueba con la miniatura (256 px); si tampoco hay, un aviso en vez
     * del nombre del producto. */
    onFotoAmpliadaError() {
        const foto = this.state.fotoAmpliada;
        if (!foto) {
            return;
        }
        if (foto.url !== foto.urlBase && foto.url !== foto.urlMini) {
            foto.url = foto.urlBase;
            foto.nivel = 0;
        } else if (foto.url === foto.urlBase) {
            foto.url = foto.urlMini;
        } else {
            foto.sinFoto = true;
        }
    }

    get textoSinFoto() {
        return sinConexion() ? "La foto se verá cuando haya señal" : "No se pudo cargar la foto";
    }

    cerrarFoto() {
        if (!this.state.fotoAmpliada) {
            return;
        }
        clearTimeout(this._cierreFotoTimer);
        this.state.fotoAmpliada = null;
        this._zoom = null;
        cerrarNivel();
    }

    // -- Zoom de la foto en grande (doble toque/clic, pellizco, rueda, arrastre) --

    /** Punto del evento relativo al centro del lienzo (ahí está el centro
     * de la foto sin transformar). */
    _puntoFoto(ev) {
        const r = this.fotoLienzoRef.el.getBoundingClientRect();
        return {x: ev.clientX - (r.left + r.width / 2), y: ev.clientY - (r.top + r.height / 2)};
    }

    /** Aplica escala y desplazamiento a la foto, sin dejar que se vaya
     * fuera de cuadro. Se escribe directo en el estilo (no en el estado
     * reactivo): son decenas de cambios por segundo durante un gesto. */
    _aplicarZoom(animado = false) {
        const z = this._zoom;
        const img = this.fotoImgRef.el;
        if (!z || !img) {
            return;
        }
        z.escala = Math.min(5, Math.max(1, z.escala));
        const maxX = ((z.escala - 1) * img.offsetWidth) / 2;
        const maxY = ((z.escala - 1) * img.offsetHeight) / 2;
        z.x = Math.min(maxX, Math.max(-maxX, z.x));
        z.y = Math.min(maxY, Math.max(-maxY, z.y));
        img.style.transition = animado ? "transform 0.2s ease" : "none";
        img.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.escala})`;
        if (this.fotoLienzoRef.el) {
            this.fotoLienzoRef.el.classList.toggle("con-zoom", z.escala > 1.01);
        }
        if (z.escala > 1.4 && !z.grandePedida && this.state.fotoAmpliada) {
            // Al acercar: la original (1920 px), por internet.
            z.grandePedida = true;
            this._mejorarFoto(this.state.fotoAmpliada, "urlGrande", 2);
        }
    }

    /** Lleva la escala a `nueva` dejando quieto el punto p (el dedo/cursor). */
    _zoomEnPunto(nueva, p, animado = false) {
        const z = this._zoom;
        const limitada = Math.min(5, Math.max(1, nueva));
        const f = limitada / z.escala;
        z.x = p.x - f * (p.x - z.x);
        z.y = p.y - f * (p.y - z.y);
        z.escala = limitada;
        this._aplicarZoom(animado);
    }

    onFotoPointerDown(ev) {
        const z = this._zoom;
        if (!z) {
            return;
        }
        try {
            ev.currentTarget.setPointerCapture(ev.pointerId);
        } catch {
            // sin captura igual funciona mientras el dedo siga encima
        }
        z.punteros.set(ev.pointerId, {x: ev.clientX, y: ev.clientY});
        if (z.punteros.size === 1) {
            z.movio = false;
            z.inicioToque = {x: ev.clientX, y: ev.clientY, t: Date.now()};
            z.arrastre = {px: ev.clientX, py: ev.clientY, x: z.x, y: z.y};
            z.pinch = null;
        } else if (z.punteros.size === 2) {
            const [a, b] = [...z.punteros.values()];
            const centro = this._puntoFoto({clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2});
            z.pinch = {dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, escala: z.escala, c: centro, x: z.x, y: z.y};
            z.arrastre = null;
            z.movio = true;
        }
    }

    onFotoPointerMove(ev) {
        const z = this._zoom;
        if (!z || !z.punteros.has(ev.pointerId)) {
            return;
        }
        z.punteros.set(ev.pointerId, {x: ev.clientX, y: ev.clientY});
        if (z.pinch && z.punteros.size >= 2) {
            const [a, b] = [...z.punteros.values()];
            const centro = this._puntoFoto({clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2});
            const escala = Math.min(5, Math.max(1, z.pinch.escala * (Math.hypot(a.x - b.x, a.y - b.y) / z.pinch.dist)));
            const f = escala / z.pinch.escala;
            z.escala = escala;
            z.x = centro.x - f * (z.pinch.c.x - z.pinch.x);
            z.y = centro.y - f * (z.pinch.c.y - z.pinch.y);
            this._aplicarZoom();
        } else if (z.arrastre) {
            const dx = ev.clientX - z.arrastre.px;
            const dy = ev.clientY - z.arrastre.py;
            if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
                z.movio = true;
            }
            if (z.escala > 1) {
                z.x = z.arrastre.x + dx;
                z.y = z.arrastre.y + dy;
                this._aplicarZoom();
            }
        }
    }

    onFotoPointerUp(ev) {
        const z = this._zoom;
        if (!z || !z.punteros.has(ev.pointerId)) {
            return;
        }
        z.punteros.delete(ev.pointerId);
        if (z.punteros.size === 1) {
            // quedó un dedo: sigue como arrastre desde donde está
            const [p] = [...z.punteros.values()];
            z.pinch = null;
            z.arrastre = {px: p.x, py: p.y, x: z.x, y: z.y};
            return;
        }
        if (z.punteros.size > 0) {
            return;
        }
        z.pinch = null;
        z.arrastre = null;
        if (z.escala < 1.05) {
            z.escala = 1;
            z.x = 0;
            z.y = 0;
            this._aplicarZoom(true);
        }
        // Doble toque / doble clic: dos toques cortos y cercanos.
        const toque = z.inicioToque;
        if (z.movio || !toque || Date.now() - toque.t > 300) {
            z.ultimoTap = null;
            return;
        }
        const ahora = {x: ev.clientX, y: ev.clientY, t: Date.now()};
        const previo = z.ultimoTap;
        if (previo && ahora.t - previo.t < 320 && Math.hypot(ahora.x - previo.x, ahora.y - previo.y) < 30) {
            z.ultimoTap = null;
            z.dobleToque = true;
            clearTimeout(this._cierreFotoTimer);
            if (z.escala > 1.01) {
                z.escala = 1;
                z.x = 0;
                z.y = 0;
                this._aplicarZoom(true);
            } else {
                this._zoomEnPunto(2.5, this._puntoFoto(ev), true);
            }
        } else {
            z.ultimoTap = ahora;
        }
    }

    onFotoWheel(ev) {
        const z = this._zoom;
        if (!z) {
            return;
        }
        ev.preventDefault();
        this._zoomEnPunto(z.escala * Math.exp(-ev.deltaY * 0.0025), this._puntoFoto(ev));
        if (z.escala <= 1.01) {
            z.x = 0;
            z.y = 0;
            this._aplicarZoom();
        }
    }

    /** Tocar el fondo (fuera de la foto) cierra, salvo que haya sido parte
     * de un gesto (arrastre, pellizco o doble toque). */
    onClickFondoFoto() {
        const z = this._zoom;
        if (!z || z.movio) {
            return;
        }
        if (z.dobleToque) {
            z.dobleToque = false;
            return;
        }
        // Espera un instante por si es el primer toque de un doble toque.
        clearTimeout(this._cierreFotoTimer);
        this._cierreFotoTimer = setTimeout(() => this.cerrarFoto(), 330);
    }

    toggleMedidor() {
        this.state.medidorAbierto = !this.state.medidorAbierto;
    }

    get clasesCabecera() {
        const clases = [];
        if (this.state.cabeceraOculta && this.state.pantalla === "catalogo" && !this.state.categMenuAbierto) {
            clases.push("oculta");
        }
        if (this.state.categMenuAbierto) {
            clases.push("menu-abierto");
        }
        if (this.cabeceraEsFlotante) {
            clases.push("flotante");
        }
        return clases.join(" ");
    }

    /** Solo en el catálogo ya cargado: flota sobre la lista y se desliza.
     * En el carrito queda fija, como siempre. */
    get cabeceraEsFlotante() {
        return this.cabeceraFlotante && this.state.pantalla === "catalogo" && !this.state.cargando;
    }

    /** Bajar por la lista esconde la cabecera; subir (o volver arriba)
     * la muestra. Umbrales para no parpadear con movimientos chicos, y
     * una pausa tras cada cambio: al esconderse/mostrarse cambia el alto
     * de la lista, y eso mismo dispara eventos de scroll. */
    onScrollCatalogo(ev) {
        const lista = ev.currentTarget;
        const actual = lista.scrollTop;
        // Dónde está el vendedor (para volver acá tras un Atrás), con pausa.
        this._scrollActual = actual;
        clearTimeout(this._guardarDondeTimer);
        this._guardarDondeTimer = setTimeout(() => this._guardarDonde(), 250);
        if (this.state.recorridoAbierto) {
            return;
        }
        const anterior = this._ultimoScrollCatalogo || 0;
        this._ultimoScrollCatalogo = actual;
        if (!this.cabeceraFlotante && Date.now() < (this._pausaCabeceraHasta || 0)) {
            return;
        }
        // Bug real reportado ("aparece de golpe, la pantalla se mueve"):
        // antes cambiaba con 6 px de movimiento y animando su altura, que
        // corría toda la lista. Ahora la cabecera flota y se desliza (el
        // contenido no se mueve), y hace falta un trecho seguido en el
        // mismo sentido para que cambie.
        const delta = actual - anterior;
        if (!delta) {
            return;
        }
        if (Math.sign(delta) !== Math.sign(this._recorridoCabecera || 0)) {
            this._recorridoCabecera = 0;
        }
        this._recorridoCabecera = (this._recorridoCabecera || 0) + delta;
        let oculta = this.state.cabeceraOculta;
        if (actual < Math.max(24, this._altoCabecera || 0)) {
            oculta = false;
        } else if (this._recorridoCabecera > CABECERA_ESCONDER_PX && lista.scrollHeight - lista.clientHeight > 240) {
            oculta = true;
        } else if (this._recorridoCabecera < -CABECERA_MOSTRAR_PX) {
            oculta = false;
        }
        if (oculta !== this.state.cabeceraOculta) {
            this.state.cabeceraOculta = oculta;
            this._recorridoCabecera = 0;
            this._pausaCabeceraHasta = Date.now() + 280;
        }
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

    /** URL de foto de producto cacheable todo el día (ver
     * TAMANO_FOTO_TARJETA más arriba). */
    /** Misma URL que precarga "Preparar mi día" (datos_offline.js), con la
     * versión estable de la foto del producto (foto_v) si se conoce. */
    _urlFoto(productId, campo, version = null) {
        return urlFotoProducto(productId, campo, version);
    }

    /** Versión de la foto de un producto: la que trae o, si no (líneas
     * del carrito restauradas, recompensas), la del catálogo cargado. Sin
     * versión la URL cambia cada día y no coincide con la foto guardada
     * en el teléfono (bug real: el carrito tardaba en mostrar las fotos). */
    _versionFoto(producto) {
        if (producto.foto_v) {
            return producto.foto_v;
        }
        const enCatalogo = this.productoDeLinea({product_id: producto.id});
        return enCatalogo ? enCatalogo.foto_v : null;
    }

    imagenUrl(producto) {
        // Tarjetas del catálogo y líneas del carrito. El tamaño en
        // pantalla (120-200 px) lo controla el CSS (.product-thumb).
        return this._urlFoto(producto.id, TAMANO_FOTO_TARJETA, this._versionFoto(producto));
    }

    /** "Pedidos anteriores": la misma foto de las tarjetas (ya guardada en
     * el teléfono) en vez de una miniatura aparte que había que bajar. */
    imagenPrecarga(linea) {
        return this._urlFoto(linea.product_id, TAMANO_FOTO_TARJETA, this._versionFoto({id: linea.product_id}));
    }

    /** Tocar la foto de una línea del carrito: la misma foto ampliada con
     * zoom del catálogo (con el producto del catálogo, que trae foto_v). */
    abrirFotoLinea(item) {
        if (item.esRecompensa) {
            return;
        }
        this.abrirFoto(this.productoDeLinea({product_id: item.producto.id}) || item.producto);
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
            setTimeout(() => {
                // Se conserva "unique" (para que, si esta vez carga,
                // quede cacheada) y se agrega un _r descartable para
                // forzar una petición nueva.
                const url = new URL(el.src, window.location.origin);
                url.searchParams.set("_r", String(Date.now()));
                el.src = url.pathname + url.search;
            }, RETRASO_REINTENTO_IMAGEN_MS * (intentos + 1));
            return;
        }
        el.style.display = "none";
    }

    /** Líneas del carrito en el orden en que se agregaron: arriba la más
     * vieja, abajo la más nueva. Antes salían "en desorden": JavaScript
     * ordena las claves numéricas (ids de producto) de menor a mayor.
     * Las líneas guardadas antes de este cambio (sin "orden") quedan
     * arriba, en su orden de siempre. */
    get itemsCarrito() {
        return Object.values(this.state.carrito)
            .map((item, i) => [item, i])
            .sort(([a, i], [b, j]) => (a.orden || 0) - (b.orden || 0) || i - j)
            .map(([item]) => item);
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

    /** Existencia LIBRE (lo que hay menos lo ya prometido a otros
     * pedidos). Si el servidor no manda free_qty, cae a qty_available. */
    stockLibre(producto) {
        const libre = producto.free_qty === undefined ? producto.qty_available : producto.free_qty;
        return Math.floor(libre || 0);
    }

    /** Etiqueta única de existencia. Solo informativa: NUNCA bloquea ni
     * oculta la venta (esa política la decide el dueño). */
    infoExistencia(producto) {
        const libre = this.stockLibre(producto);
        if (libre <= 0) {
            return {texto: "Sin existencia", tono: "danger"};
        }
        if (libre <= STOCK_BAJO_UMBRAL) {
            return {texto: `Quedan ${libre}`, tono: "warning"};
        }
        return {texto: `Disponible: ${libre}`, tono: "success"};
    }

    /** Para el filtro "Con stock": hay en Dianke O en Nevada (cualquiera
     * de las dos alcanza). Sin datos por bodega, el stock libre de siempre.
     * Antes solo miraba el stock libre propio y dejaba afuera los
     * productos que solo tienen Nevada. */
    tieneStock(producto) {
        if (producto.stock_dianke !== undefined) {
            return (producto.stock_dianke || 0) > 0 || (producto.stock_nevada || 0) > 0;
        }
        return this.stockLibre(producto) > 0;
    }

    /** Etiquetas de las dos bodegas, como en Ventas: Dianke (verde =
     * hay, rojo = no hay) y Nevada (amarillo, se pide). Devuelve null
     * si el servidor no mandó las existencias por bodega (se usa
     * entonces infoExistencia). Solo informativo: no bloquea nada. */
    chipsBodegas(producto) {
        if (producto.stock_dianke === undefined) {
            return null;
        }
        const dianke = producto.stock_dianke;
        const nevada = producto.stock_nevada || 0;
        let chipDianke = {texto: `Disponible: ${dianke}`, tono: "success"};
        if (dianke <= 0) {
            chipDianke = {texto: "Sin existencia", tono: "danger"};
        } else if (dianke <= STOCK_BAJO_UMBRAL) {
            chipDianke = {texto: `Quedan ${dianke}`, tono: "warning"};
        }
        return {
            dianke: chipDianke,
            nevada: {texto: `Nevada: ${nevada.toLocaleString("en-US")}`, tono: nevada > 0 ? "nevada" : "neutral"},
        };
    }

    /** Texto de la etiqueta "Bulto: N unidades" del catálogo, o "" si el
     * producto no trae dato de bulto (0, vacío o sin el campo): en ese
     * caso la tarjeta no muestra nada. Solo informativo. */
    textoBulto(producto) {
        const n = Math.floor(producto.bulto || 0);
        if (n <= 0) {
            return "";
        }
        return `Bulto: ${n.toLocaleString("en-US")} ${n === 1 ? "unidad" : "unidades"}`;
    }

    // -- Estrellas y margen en vivo --

    /** Pide (con 300 ms de espera, para no llamar por cada toque de
     * "+") la evaluación del carrito actual. Si falla o no hay
     * cliente, simplemente no se muestra el medidor. */
    _pedirEvaluacion() {
        if (this._destruido) {
            return;
        }
        if (this._evalTimer) {
            clearTimeout(this._evalTimer);
        }
        this._evalTimer = setTimeout(() => this._evaluarCarrito(), 300);
    }

    /** Visita de un cliente creado sin señal (id provisorio, negativo). */
    get esVisitaProvisoria() {
        return esProvisorio(this.props.orderId);
    }

    async _evaluarCarrito() {
        const items = this.itemsCarrito;
        if (!items.length || !this.state.locationId || esProvisorio(this.state.locationId)) {
            this.state.evaluacion = null;
            return;
        }
        try {
            this.state.evaluacion = await this.orm.call("fsm.order", "shalom_evaluar_pedido", [
                this.state.locationId,
                this.lineasParaBackend(items),
            ]);
        } catch (error) {
            console.error("shalom: error al evaluar el pedido", error);
        }
    }

    get medidor() {
        const ev = this.state.evaluacion;
        if (!ev || !this.cantidadItems) {
            return null;
        }
        const refs = ev.refs || {};
        const tiene = refs.n > 0;
        const tope = tiene ? Math.max(refs.record * 1.1, this.total) : 0;
        const pct = (valor) => (tope ? Math.min(100, (valor / tope) * 100) : 0);
        let mensaje = "Cliente sin historial de compras: todavía no hay estrellas que medir.";
        let mensajeCorto = "Sin historial";
        let tono = "neutral";
        if (tiene) {
            const sig = ev.siguiente;
            if (!sig) {
                mensaje = "¡Oro! Superaste su récord con buen margen.";
                mensajeCorto = "¡Oro!";
                tono = "oro";
            } else if (sig.margen_bajo) {
                mensaje = "Superaste su récord, pero el margen es menor a 20%: el oro no cuenta.";
                mensajeCorto = "Margen bajo: sin oro";
                tono = "aviso";
            } else {
                const nombres = {1: "bronce (75%)", 2: "plata (100%)", 3: "oro (récord)"};
                mensaje = `Te faltan $${sig.faltan.toFixed(0)} para ${nombres[sig.estrellas]}`;
                mensajeCorto = `Faltan $${sig.faltan.toFixed(0)} → ${"★".repeat(sig.estrellas)}`;
                tono = "falta";
            }
        }
        return {
            tiene,
            estrellas: ev.estrellas,
            verMargen: ev.margen_pct !== undefined && ev.margen_pct !== null,
            margen: ev.margen_pct,
            margenBajo: ev.margen_pct < 20,
            mensaje,
            mensajeCorto,
            tono,
            relleno: pct(this.total),
            marcas: tiene
                ? [
                      {clase: "bronce", pos: pct(refs.t75), texto: `$${Math.round(refs.t75).toLocaleString("en-US")}`},
                      {clase: "plata", pos: pct(refs.t100), texto: `$${Math.round(refs.t100).toLocaleString("en-US")}`},
                      {clase: "oro", pos: pct(refs.record), texto: `$${Math.round(refs.record).toLocaleString("en-US")}`},
                  ]
                : [],
        };
    }

    // -- Precargar de pedidos anteriores --

    /** Pide los pedidos anteriores por detrás (al terminar de cargar el
     * catálogo), para que "Anteriores" abra sin espera. */
    _precargarPedidosAnteriores() {
        if (!this.state.locationId || this._pedidosAnterioresPromesa) {
            return this._pedidosAnterioresPromesa;
        }
        this._pedidosAnterioresPromesa = traerPedidosAnteriores(this.orm, this.state.locationId)
            .catch((error) => {
                this._pedidosAnterioresPromesa = null;
                throw error;
            });
        // un fallo aquí se reintenta al tocar "Anteriores"
        this._pedidosAnterioresPromesa.catch(() => {});
        return this._pedidosAnterioresPromesa;
    }

    // La hoja de "Pedidos anteriores" es su propio nivel de navegación
    // (como la foto en grande): el Atrás de Android cierra SOLO la hoja.
    // Antes cerraba el catálogo entero.
    async abrirPrecarga() {
        if (!this.state.precargaAbierta) {
            abrirNivel({tipo: "precarga"});
        }
        this.state.precargaAbierta = true;
        this.state.pedidoPrecargaAbierto = null;
        if (!this.state.locationId) {
            return;
        }
        this.state.cargandoPrecarga = true;
        try {
            this.state.pedidosAnteriores = await this._precargarPedidosAnteriores();
            // El pedido más reciente llega desplegado: se ven las fotos y se elige directo.
            this.state.pedidoPrecargaAbierto = this.state.pedidosAnteriores.length ? this.state.pedidosAnteriores[0].id : null;
        } catch (error) {
            console.error("shalom: error al leer pedidos anteriores", error);
            this.state.pedidosAnteriores = [];
            this.notification.add("No se pudieron cargar los pedidos anteriores.", {type: "danger"});
        } finally {
            this.state.cargandoPrecarga = false;
        }
    }

    cerrarPrecarga() {
        if (!this.state.precargaAbierta) {
            return;
        }
        this.state.precargaAbierta = false;
        cerrarNivel();
    }

    seleccionarPedidoPrecarga(pedidoId) {
        this.state.pedidoPrecargaAbierto = pedidoId;
    }

    get pedidoPrecargaSeleccionado() {
        return this.state.pedidosAnteriores.find((pedido) => pedido.id === this.state.pedidoPrecargaAbierto) || null;
    }

    /** ¿El producto de esta línea ya está en el carrito actual? */
    lineaEnCarrito(linea) {
        return !!this.state.carrito[linea.product_id];
    }

    /** Líneas de un pedido anterior que todavía no están en el carrito
     * (y siguen en el catálogo). */
    lineasFaltantes(pedido) {
        return pedido.lineas.filter((linea) => !this.lineaEnCarrito(linea) && this.productoDeLinea(linea));
    }

    /** Producto del catálogo cargado para una línea de pedido anterior
     * (null si ya no está en el catálogo vendible). */
    productoDeLinea(linea) {
        if (!this._indiceProductos || this._indiceProductos.productos !== this.state.productos) {
            this._indiceProductos = {
                productos: this.state.productos,
                porId: new Map(this.state.productos.map((producto) => [producto.id, producto])),
            };
        }
        return this._indiceProductos.porId.get(linea.product_id) || null;
    }

    /** Suma las cantidades al carrito (no reemplaza lo que ya hay) y
     * guarda una sola vez: respaldo local, promos y sincronización con
     * el servidor siguen el mismo camino que agregarProducto(). */
    _precargarLineas(lineas) {
        let agregados = 0;
        for (const linea of lineas) {
            const producto = this.productoDeLinea(linea);
            if (!producto) {
                continue;
            }
            const actual = this.state.carrito[producto.id];
            this.state.carrito[producto.id] = {
                producto,
                cantidad: (actual ? actual.cantidad : 0) + linea.cantidad,
                orden: actual && actual.orden ? actual.orden : this._siguienteOrden(),
            };
            this._marcarCambioPendienteCarrito(producto.id);
            agregados += 1;
        }
        if (agregados) {
            this.actualizarPromos();
            this._guardarBorradorCarrito();
        }
        return agregados;
    }

    /** Suma al carrito solo lo que falta del pedido anterior: lo que
     * ya está no se toca (antes "Agregar todo" volvía a sumar todo y
     * duplicaba cantidades). */
    agregarFaltantes(pedido) {
        const faltantes = this.lineasFaltantes(pedido);
        if (!faltantes.length) {
            return;
        }
        const agregados = this._precargarLineas(faltantes);
        this.notification.add(
            agregados ? `Se agregaron ${agregados} producto(s) del pedido ${pedido.nombre}.` : "Esos productos ya no están en el catálogo.",
            {type: agregados ? "success" : "warning"}
        );
        if (agregados) {
            this.cerrarPrecarga();
        }
    }

    precargarLinea(linea) {
        if (!this._precargarLineas([linea])) {
            this.notification.add("Ese producto ya no está en el catálogo.", {type: "warning"});
        }
    }

    /** Unidades físicas ya prometidas a otros pedidos; 0 = no mostrar. */
    reservados(producto) {
        if (!(producto.qty_available > 0)) {
            return 0;
        }
        const n = Math.round(producto.qty_available - this.stockLibre(producto));
        return n > 0 ? n : 0;
    }

    etiquetaPromo(productoId) {
        return this.state.promoPorProducto[productoId] || "";
    }

    /** Versión corta para la tarjeta del catálogo: dice si la promo está
     * completa o cuánto falta, sin recortar con "…". Sin el detalle
     * (servidor viejo) usa el texto largo de siempre. */
    etiquetaPromoCorta(productoId) {
        const det = this.state.promoDetallePorProducto[productoId];
        if (!det) {
            return this.etiquetaPromo(productoId);
        }
        if (det.completa) {
            return det.completas > 1 ? `✅ ${det.completas} promos completas` : "✅ Promo completa";
        }
        return `⏳ Promo: faltan ${det.faltan}`;
    }

    promoCompleta(productoId) {
        return this.etiquetaPromo(productoId).includes("✅");
    }

    /** Marca de orden para una línea nueva del carrito: siempre mayor que
     * la anterior (aunque se agreguen varias en el mismo milisegundo). */
    _siguienteOrden() {
        this._ultimoOrden = Math.max(Date.now(), (this._ultimoOrden || 0) + 1);
        return this._ultimoOrden;
    }

    agregarProducto(producto) {
        const actual = this.state.carrito[producto.id];
        this.state.carrito[producto.id] = {
            producto,
            cantidad: (actual ? actual.cantidad : 0) + 1,
            orden: actual && actual.orden ? actual.orden : this._siguienteOrden(),
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
    /** Al tocar el campo de cantidad (la primera vez Y cada vez que se
     * vuelve a tocar) se selecciona toda la cifra: escribir reemplaza el
     * número entero sin borrar dígito por dígito. Un instante después del
     * toque, porque el navegador ubica el cursor justo después y si no
     * deshacía la selección. El campo es de texto con teclado numérico
     * (no type="number"): ahí select() funciona en todos los navegadores
     * y la rueda del mouse ya no cambia la cantidad sola (eso era el
     * "escribo 200 y queda 50"). */
    seleccionarTextoCantidad(ev) {
        const campo = ev.target;
        campo.select();
        setTimeout(() => {
            if (document.activeElement === campo) {
                campo.setSelectionRange(0, campo.value.length);
            }
        }, 0);
    }

    /**
     * Cantidad escrita a mano con el teclado (en vez de tocar "+" una
     * por una) -- pedido explícito para pedidos grandes (ej. 100
     * unidades). Cualquier valor inválido o menor a 1 se trata como
     * "quitar del carrito", igual que bajar el stepper hasta 0.
     */
    /** Cantidad escrita a mano: se guarda MIENTRAS se escribe, tecla por
     * tecla, sin esperar a que el campo pierda el foco. Antes solo se
     * guardaba en el "change" (al salir del campo), que en el celular no
     * siempre llega (desplazarse con el teclado abierto, algunos
     * teclados al tocar "Listo"): la app seguía con la cantidad vieja y
     * la volvía a poner (reportado: "escribo 96 y vuelve al 12").
     * Vacío o 0 a mitad de escribir no quita nada; eso lo resuelve
     * cambiarCantidadManual al salir del campo. Las promos se recalculan
     * con una pausa corta, no por cada tecla. */
    escribirCantidad(productoId, ev) {
        // Solo dígitos (en la computadora se podría escribir cualquier cosa).
        const limpio = ev.target.value.replace(/[^0-9]/g, "");
        if (limpio !== ev.target.value) {
            ev.target.value = limpio;
        }
        const item = this.state.carrito[productoId];
        const nueva = parseInt(limpio, 10);
        if (!item || !nueva || nueva <= 0 || nueva === item.cantidad) {
            return;
        }
        item.cantidad = nueva;
        this._guardarBorradorCarrito();
        this._marcarCambioPendienteCarrito(productoId);
        clearTimeout(this._promosTimer);
        this._promosTimer = setTimeout(() => {
            if (!this._destruido) {
                this.actualizarPromos();
            }
        }, 500);
    }

    /** Enter / "Ir" del teclado: cierra el teclado (y confirma la cantidad). */
    enterCierraTeclado(ev) {
        if (ev.key === "Enter") {
            ev.target.blur();
        }
    }

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
        this._pedirEvaluacion();
        const items = this.itemsCarritoPagos;
        if (!items.length) {
            this.state.promoPorProducto = {};
            this.state.promoDetallePorProducto = {};
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
            this.state.promoDetallePorProducto = resultado.detalle || {};
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
            orden: actual && actual.orden ? actual.orden : this._siguienteOrden(),
        };
        this.state.recompensaMenuAbierto = false;
        this.notification.add(
            `Promoción agregada: ${unidadesACargar} x ${recompensa.reward_product_name}`,
            {type: "success"}
        );
        this._guardarBorradorCarrito();
        this._marcarCambioPendienteCarrito(key);
    }

    /** Solo se llega acá desde el header "←" cuando pantalla ya es
     * "carrito" (ver atras()) -- siempre hay un nivel de carrito
     * propio para cerrar acá. */
    irACatalogo() {
        cerrarNivel();
        this.state.pantalla = "catalogo";
        this.cargarProductos(true);
    }

    irACarrito() {
        if (!this.cantidadItems) {
            this.notification.add("El carrito está vacío.", {type: "warning"});
            return;
        }
        // Nivel aparte, encima del catálogo -- el Atrás de Android
        // desde el carrito vuelve al catálogo (un solo nivel), no
        // cierra todo de un salto.
        abrirNivel({tipo: "carrito"});
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
            // Precio que vio el cliente (cola offline: si al enviarse
            // cambió el precio de lista, se respeta este y oficina recibe
            // una nota -- ver _shalom_aplicar_precios_visita).
            precio_visita: item.esRecompensa ? false : item.producto.list_price,
        }));
    }

    /** Texto de la acción en el panel de conexión: "Cliente ($123.45)". */
    _etiquetaCola() {
        return this.props.clienteNombre + " ($" + this.total.toFixed(2) + ")";
    }

    /** Lo que el vendedor ve del pedido en el panel de conexión mientras
     * espera enviarse (vista previa): NO se manda al servidor. */
    _resumenCola() {
        const forma = (this.state.formasPagoDisponibles || []).find(
            (f) => f.value === this.state.formaPagoSeleccionada
        );
        return {
            cliente: this.props.clienteNombre,
            total: this.total,
            forma_pago: forma ? forma.label : "",
            lineas: this.itemsCarrito.map((item) => ({
                nombre: item.producto.name,
                cantidad: item.cantidad,
                precio: item.esRecompensa ? 0 : item.producto.list_price,
                recompensa: !!item.esRecompensa,
            })),
        };
    }

    /** El pedido quedó en la cola del teléfono: desde acá nada vuelve a
     * escribir el carrito compartido (mismo corte que tras confirmar). */
    _marcarGuardadoEnTelefono() {
        this._confirmado = true;
        this._cambiosPendientes = {};
        this._eliminadosPendientes.clear();
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
        await this._abrirPopupFormaPago();
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
            // Modo offline: el pedido se guarda PRIMERO en el teléfono (cola,
            // ver sincronizador.js) y se manda; el servidor corre el mismo
            // shalom_confirmar_pedido, una sola vez por pedido aunque el
            // envío se repita. Con señal la respuesta llega como siempre.
            const lineas = this.lineasParaBackend(items);
            const uuid = await encolar(
                "confirmar_pedido",
                {
                    order_id: this.props.orderId,
                    lineas,
                    payment_method: this.state.formaPagoSeleccionada,
                    special_delivery_date: this.state.fechaEntregaEspecial
                        ? this.state.fechaEntregaEspecial.toISODate()
                        : false,
                    includes_itbms: this.state.incluyeItbms,
                },
                {etiqueta: this._etiquetaCola(), resumen: this._resumenCola()}
            );
            const respuesta = await esperarResultado(uuid, ESPERA_PEDIDO_MS);
            if (respuesta.estado === "error") {
                // Rechazado por el servidor (igual que antes, se avisa acá
                // mismo y el carrito sigue intacto para corregir).
                await descartar(uuid);
                this.notification.add(respuesta.error || "No se pudo confirmar el pedido.", {type: "danger"});
                return;
            }
            if (respuesta.estado === "pendiente") {
                // "Avisar y esperar" (decisión del usuario): queda guardado
                // y marcado "Pendiente de enviar"; el vendedor sigue.
                this._marcarGuardadoEnTelefono();
                this.notification.add(
                    "Sin señal: el pedido de " + this.props.clienteNombre + " quedó GUARDADO EN EL TELÉFONO " +
                        "y se envía solo cuando vuelva la señal. No cierres la app.",
                    {type: "warning", sticky: true}
                );
                if (this.props.onConfirmado) {
                    this.props.onConfirmado();
                }
                this.cerrarDeVerdad();
                return;
            }
            const resultado = respuesta.resultado;
            this.notification.add(
                `Pedido confirmado: ${resultado.sale_order_name} ($${resultado.total.toFixed(2)}).`,
                {type: "success"}
            );
            if (this.props.onConfirmado) {
                this.props.onConfirmado();
            }
            if (resultado.juego) {
                // Pantalla de resultado (estrellas, XP, nivel): el pedido
                // YA está confirmado, así que se corta aquí todo lo que
                // pudiera volver a escribir el carrito (tick de
                // sincronización, borrador local) y se cierra recién
                // cuando el vendedor toca "Siguiente cliente".
                this._confirmado = true;
                this._cambiosPendientes = {};
                this._eliminadosPendientes.clear();
                this._borrarBorradorCarrito();
                // Si desde el resultado llega un Atrás real, no reabrir el
                // catálogo de este pedido ya enviado (ver marcarNivel).
                marcarNivel("catalogo", {confirmado: true});
                this.state.resultadoJuego = resultado.juego;
                return;
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

    // -- Resultado del pedido (estrellas, XP, nivel) --

    /** Datos ya listos para la pantalla de resultado. */
    get resultadoVista() {
        const r = this.state.resultadoJuego;
        if (!r) {
            return null;
        }
        const nombres = {0: "Sin estrella", 1: "Bronce · 75%", 2: "Plata · 100%", 3: "Oro · récord"};
        const p = r.progreso;
        const tramo = p.xp_siguiente ? p.xp_siguiente - p.xp_nivel : 0;
        const avance = tramo ? Math.min(100, ((p.xp_total - p.xp_nivel) / tramo) * 100) : 100;
        const tieneVara = r.refs && r.refs.n > 0;
        return {
            ...r,
            etiquetaEstrellas: tieneVara ? nombres[r.estrellas] : "Cliente nuevo: sin estrellas aún",
            tieneVara,
            pctDelTipico: tieneVara && r.refs.tipico ? Math.round((r.total / r.refs.tipico) * 100) : null,
            avance,
            faltanXp: p.xp_siguiente ? p.xp_siguiente - p.xp_total : 0,
        };
    }

    cerrarResultadoJuego() {
        this.cerrarDeVerdad();
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
            // Modo offline: por la cola, igual que confirmarPedido (el
            // servidor corre shalom_guardar_borrador_pedido una sola vez).
            const lineas = this.lineasParaBackend(items);
            const uuid = await encolar(
                "guardar_borrador",
                {order_id: this.props.orderId, lineas},
                {etiqueta: this._etiquetaCola(), resumen: this._resumenCola()}
            );
            const respuesta = await esperarResultado(uuid, ESPERA_PEDIDO_MS);
            if (respuesta.estado === "error") {
                await descartar(uuid);
                this.notification.add(respuesta.error || "No se pudo guardar la cotización.", {type: "danger"});
                return;
            }
            if (respuesta.estado === "pendiente") {
                this._marcarGuardadoEnTelefono();
                this.notification.add(
                    "Sin señal: la cotización de " + this.props.clienteNombre + " quedó guardada en el teléfono " +
                        "y se envía sola con señal. Revisala en Ventas después.",
                    {type: "warning", sticky: true}
                );
                if (this.props.onRevisado) {
                    this.props.onRevisado();
                }
                this.cerrarDeVerdad();
                return;
            }
            if (this.props.onRevisado) {
                this.props.onRevisado();
            }
            const accion = normalizarAccionActWindow({
                type: "ir.actions.act_window",
                res_model: "sale.order",
                res_id: respuesta.resultado.sale_order_id,
                view_mode: "form",
                target: "current",
            });
            // Cerrar ANTES del doAction (no después, y sin ningún
            // history.back() de por medio -- eso era justo lo que
            // rompía la redirección): así OrderScreen ya no está
            // montado por encima cuando el formulario de Ventas se
            // abre.
            this.cerrarDeVerdad();
            // marcarRetorno() va DESPUÉS de cerrarDeVerdad() a propósito
            // -- tiene que capturar la profundidad YA con el catálogo/
            // carrito cerrados (solo ruta+visita), que es adonde debe
            // caer el Atrás al volver de Ventas -- ver el bloque "CASO
            // APARTE" del comentario grande de back_stack.js.
            marcarRetorno();
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
        // Modo offline: va por la cola con la copia del carrito tal como la
        // tenía este teléfono, para que quede en Administración → Registro
        // (y se pueda restaurar) aunque se descarte sin señal.
        const carritoLocal = {};
        for (const [clave, item] of Object.entries(this.state.carrito)) {
            carritoLocal[clave] = this._lineaParaServidor(item);
        }
        encolar(
            "descartar_carrito",
            {order_id: this.props.orderId, carrito: carritoLocal},
            {etiqueta: this._etiquetaCola()}
        ).catch(() => {});
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
        // Si el carrito estaba abierto (Confirmar pedido/Revisar
        // cotización se tocan siempre desde ahí), ese es un sub-nivel
        // APARTE (ver irACarrito()) que nadie más va a cerrar -- hay
        // que sacarlo acá antes de delegar el nivel del catálogo en sí
        // a quien lo abrió (VisitSheet.cerrarPedido(), vía onCerrar
        // más abajo). Si no se sacara, quedaría una entrada de más en
        // la pila guardada (un Atrás de más, más adelante, sin efecto
        // visible -- inofensivo pero evitable).
        if (this.state.pantalla === "carrito") {
            cerrarNivel();
        }
        // Único punto de cierre intencional (carrito vacío, "Salir sin
        // guardar", pedido confirmado, cotización guardada) -- se
        // limpia acá el borrador de recuperación para que no quede
        // colgado. El nivel de navegación de esta pantalla (el
        // catálogo en sí) NO se cierra acá -- lo maneja quien la abrió
        // (VisitSheet.cerrarPedido(), llamado abajo vía onCerrar) --
        // ver el comentario grande al principio del archivo.
        this._borrarBorradorCarrito();
        this._borrarDonde();
        this.props.onCerrar();
    }
}
