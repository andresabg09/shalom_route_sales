/** @odoo-module **/

import {
    borrarLocal,
    borrarTodoLocal,
    guardarLocal,
    leerLocal,
    listarClaves,
    pedirAlmacenamientoPersistente,
} from "./almacen_local";
import {conTimeout, sinConexion, TiempoAgotadoError} from "./red_utils";
import {estadoOffline, marcarRed} from "./sincronizador";
import {
    aplicarEdiciones,
    clientesProvisorios,
    esProvisorio,
    fichaProvisoria,
    visitaProvisoria,
    visitasProvisoriasDeCiclo,
} from "./clientes_offline";

/**
 * Lecturas con respaldo en el teléfono (modo offline, Fase 2).
 *
 * Cada pantalla pide sus datos como siempre, pero a través de
 * leerConRespaldo(clave, llamada):
 * - Con buena señal: pide al servidor (con límite de tiempo) y guarda
 *   una copia local bajo `clave`.
 * - Sin señal o con señal débil y con copia local: devuelve la copia AL
 *   INSTANTE (sin esperar a la red) y refresca por detrás.
 * - Si el servidor responde con un error de negocio (permiso, etc.), se
 *   propaga igual que antes: la copia local solo cubre fallas de red.
 *
 * "Preparar mi día" (prepararDia) llena esas mismas claves de antemano,
 * con los mismos datos y la misma forma: así, sin señal, cada pantalla
 * encuentra lo suyo como si lo hubiera pedido ella.
 */

const TIMEOUT_LECTURA_MS = 8000;
const TIMEOUT_PAQUETE_MS = 60000;
const FOTOS_EN_PARALELO = 6;

export class SinDatosLocalesError extends Error {
    constructor(clave) {
        super(`Sin señal y sin datos guardados en el teléfono (${clave}).`);
        this.name = "SinDatosLocalesError";
    }
}

/** True si el error es de red (sin señal, servidor inalcanzable, corte
 * por tiempo) y no una respuesta del servidor (permiso, validación). */
export function esErrorDeRed(error) {
    if (!error) {
        return false;
    }
    if (error instanceof TiempoAgotadoError || error instanceof SinDatosLocalesError) {
        return true;
    }
    const nombre = (error.constructor && error.constructor.name) || error.name || "";
    if (/ConnectionLost|ConnectionAborted/.test(nombre) || /ConnectionLost|ConnectionAborted/.test(error.name || "")) {
        return true;
    }
    // RPCError del servidor (UserError, AccessError...): trae data/code.
    if (error.data || error.name === "RPC_ERROR" || error.exceptionName) {
        return false;
    }
    return sinConexion();
}

const refrescando = new Set();

export async function leerConRespaldo(clave, llamada, {timeoutMs = TIMEOUT_LECTURA_MS} = {}) {
    const local = await leerLocal(clave);
    const pedir = async () => {
        const valor = await conTimeout(llamada(), timeoutMs);
        marcarRed(true);
        guardarLocal(clave, valor);
        return valor;
    };
    if (local && (sinConexion() || estadoOffline.red !== "en_linea")) {
        // Sin esperar a la red: lo guardado al instante, refresco por detrás.
        if (!sinConexion() && !refrescando.has(clave)) {
            refrescando.add(clave);
            pedir()
                .catch((error) => {
                    if (esErrorDeRed(error)) {
                        marcarRed(false);
                    }
                })
                .finally(() => refrescando.delete(clave));
        }
        return local.valor;
    }
    if (sinConexion()) {
        marcarRed(false);
        throw new SinDatosLocalesError(clave);
    }
    try {
        return await pedir();
    } catch (error) {
        if (!esErrorDeRed(error)) {
            throw error;
        }
        marcarRed(false);
        if (local) {
            return local.valor;
        }
        throw error;
    }
}

// ------------------------------------------------------------------
// Lecturas de cada pantalla (mismas llamadas y forma de siempre)
// ------------------------------------------------------------------

export async function traerRutas(orm, ventana) {
    const rutas = await leerConRespaldo("rutas", () => orm.call("fsm.person", "shalom_mis_rutas_programadas", ventana));
    // Para el checklist del panel: qué rutas con pendientes existen (y
    // así cuántas todavía no están en el teléfono).
    estadoOffline.rutasDisponibles = (rutas || []).map((s) => s.id);
    estadoOffline.rutasNombres = Object.fromEntries((rutas || []).map((s) => [s.id, s.route_name]));
    return rutas;
}

/** RutaDetalle.cargar(): visitas del ciclo + datos de clientes + perfiles + trazado. */
export async function traerDetalleRuta(orm, schedule) {
    // Clientes creados sin señal en esta ruta (todavía en la cola): se
    // muestran como paradas nuevas hasta que se envíen.
    const nuevas = visitasProvisoriasDeCiclo(schedule.id);
    let detalle;
    try {
        detalle = await traerDetalleRutaServidor(orm, schedule);
    } catch (error) {
        // Ruta sin descargar y sin señal: al menos las paradas nuevas.
        if (!nuevas.length || !esErrorDeRed(error)) {
            throw error;
        }
        detalle = {ordenes: [], locaciones: [], perfiles: {}, ruta: []};
    }
    if (!nuevas.length) {
        return detalle;
    }
    const ordenes = [...(detalle.ordenes || [])];
    for (const v of nuevas) {
        const pos = ordenes.findIndex((o) => (o.x_cliente_orden_ruta || 0) >= v.orden.x_cliente_orden_ruta);
        const fila = {...v.orden, x_cartera_person_id: false, x_cartera_fecha: false, x_cartera_orden: 0, x_cartera_reserva: false, provisoria: true};
        if (pos < 0) {
            ordenes.push(fila);
        } else {
            ordenes.splice(pos, 0, fila);
        }
    }
    const locaciones = [...(detalle.locaciones || []), ...nuevas.map((v) => ({...v.locacion, x_venta_mas_alta: 0}))];
    return {...detalle, ordenes, locaciones};
}

function traerDetalleRutaServidor(orm, schedule) {
    return leerConRespaldo(`ruta:${schedule.id}`, async () => {
        const ordenes = await orm.searchRead(
            "fsm.order",
            [["x_route_schedule_id", "=", schedule.id]],
            [
                "location_id",
                "x_cliente_orden_ruta",
                "stage_name",
                "x_cliente_lat",
                "x_cliente_lng",
                "x_cartera_person_id",
                "x_cartera_fecha",
                "x_cartera_orden",
                "x_cartera_reserva",
            ],
            {order: "x_cliente_orden_ruta asc"}
        );
        const locationIds = ordenes.map((o) => o.location_id && o.location_id[0]).filter(Boolean);
        const [locaciones, perfiles, ruta] = await Promise.all([
            locationIds.length
                ? orm.read("fsm.location", locationIds, ["phone", "street", "street2", "x_venta_mas_alta"])
                : Promise.resolve([]),
            locationIds.length
                ? orm.call("fsm.order", "shalom_perfiles_ruta", [locationIds]).catch((error) => {
                      console.error("shalom: error al leer perfiles de la ruta", error);
                      return {};
                  })
                : Promise.resolve({}),
            orm.read("fsm.route", [schedule.route_id], ["x_ruta_trazado"]),
        ]);
        return {ordenes, locaciones, perfiles, ruta};
    });
}

/** VisitSheet.cargar(): la visita, su cliente y qué datos le faltan. */
/** Id real de una visita/cliente creados sin señal, cuando el alta ya se
 * envió (lo guarda sincronizador.js al recibir la respuesta). */
export async function idRealDe(provisorio, campo) {
    const local = await leerLocal(`provisorio:${provisorio}`);
    return (local && local.valor && local.valor[campo]) || null;
}

export async function traerVisita(orm, orderId) {
    if (esProvisorio(orderId)) {
        const v = visitaProvisoria(orderId);
        if (v) {
            return v;
        }
        const real = await idRealDe(orderId, "order_id");
        if (!real) {
            throw new SinDatosLocalesError(`visita:${orderId}`);
        }
        orderId = real;
    }
    return leerConRespaldo(`visita:${orderId}`, async () => {
        const [orden] = await orm.read("fsm.order", [orderId], [
            "location_id",
            "x_cliente_orden_ruta",
            "stage_name",
            "x_observaciones_visita",
            "x_cliente_lat",
            "x_cliente_lng",
            "sale_id",
        ]);
        let locacion = null;
        if (orden.location_id) {
            [locacion] = await orm.read("fsm.location", [orden.location_id[0]], [
                "name",
                "phone",
                "mobile",
                "street",
                "street2",
                "partner_id",
            ]);
        }
        const datosFaltantes = await orm.call("fsm.order", "shalom_campos_cliente_faltantes", [[orderId]]);
        return {orden, locacion, datosFaltantes};
    });
}

export function traerFichaJuego(orm, locationId) {
    if (esProvisorio(locationId)) {
        // cliente nuevo: todavía sin historial ni estrellas
        return Promise.reject(new SinDatosLocalesError(`ficha:${locationId}`));
    }
    return leerConRespaldo(`ficha:${locationId}`, () => orm.call("fsm.order", "shalom_ficha_juego", [locationId]));
}

/** OrderScreen._cargarDatosFaltantes(). */
export async function traerFaltantes(orm, orderId) {
    if (esProvisorio(orderId)) {
        const v = visitaProvisoria(orderId);
        if (v) {
            return {locationId: v.orden.location_id[0], datosFaltantes: []};
        }
        const real = await idRealDe(orderId, "order_id");
        if (!real) {
            return {locationId: false, datosFaltantes: []};
        }
        orderId = real;
    }
    return leerConRespaldo(`faltantes:${orderId}`, async () => {
        const [orden] = await orm.read("fsm.order", [orderId], ["location_id"]);
        const datosFaltantes = await orm.call("fsm.order", "shalom_campos_cliente_faltantes", [[orderId]]);
        return {locationId: orden.location_id ? orden.location_id[0] : false, datosFaltantes};
    });
}

/** OrderScreen.cargarProductos(): productos + existencias por bodega +
 * estrategias (estas dos últimas a prueba de fallos, como siempre). */
export async function traerCatalogo(orm) {
    const resultado = await traerCatalogoCrudo(orm);
    // Con señal, las fotos que falten se bajan solas por detrás.
    if (!sinConexion()) {
        completarFotos(resultado.productos);
    }
    return resultado;
}

function traerCatalogoCrudo(orm) {
    return leerConRespaldo(
        "catalogo",
        async () => {
            const productos = await orm.searchRead(
                "product.product",
                [["sale_ok", "=", true]],
                ["name", "list_price", "barcode", "default_code", "qty_available", "free_qty", "categ_id"],
                {order: "name asc"}
            );
            let estrategiaPorProducto = {};
            await Promise.all([
                orm
                    .call("fsm.order", "shalom_existencias_bodegas", [productos.map((p) => p.id)])
                    .then((porProducto) => {
                        for (const producto of productos) {
                            const bodegas = porProducto[producto.id];
                            if (bodegas) {
                                producto.stock_dianke = bodegas.dianke;
                                producto.stock_nevada = bodegas.nevada;
                                producto.bulto = bodegas.bulto || 0;
                            }
                        }
                    })
                    .catch((error) => console.error("shalom: error al leer existencias por bodega", error)),
                orm
                    .call("shalom.estrategia", "shalom_estrategias_vigentes", [])
                    .then((resultado) => {
                        estrategiaPorProducto = resultado.productos || {};
                    })
                    .catch((error) => console.error("shalom: error al leer estrategias", error)),
                // Versión estable de cada foto (ver urlFotoProducto): si falla,
                // las fotos usan la fecha del día como antes.
                orm
                    .call("fsm.order", "shalom_marcas_fotos", [productos.map((p) => p.id)])
                    .then((marcas) => {
                        for (const producto of productos) {
                            if (marcas[producto.id]) {
                                producto.foto_v = marcas[producto.id];
                            }
                        }
                    })
                    .catch((error) => console.error("shalom: error al leer versiones de fotos", error)),
            ]);
            return {productos, estrategiaPorProducto, descargadoEn: Date.now()};
        },
        {timeoutMs: 30000}
    );
}

export function traerPedidosAnteriores(orm, locationId) {
    if (esProvisorio(locationId)) {
        return Promise.resolve([]); // cliente nuevo: no tiene pedidos anteriores
    }
    return leerConRespaldo(`pedidos:${locationId}`, () => orm.call("fsm.order", "shalom_pedidos_anteriores", [locationId]));
}

export function traerFormasPago(orm) {
    return leerConRespaldo("formas_pago", () => orm.call("fsm.order", "shalom_formas_pago_disponibles", []));
}

export function traerUltimaFormaPago(orm, locationId) {
    if (esProvisorio(locationId)) {
        return Promise.resolve({payment_method: false, includes_itbms: false});
    }
    return leerConRespaldo(`ultima_fp:${locationId}`, () =>
        orm.call("fsm.order", "shalom_ultima_forma_pago_e_itbms", [locationId])
    );
}

export function traerEtapas(orm) {
    return leerConRespaldo("etapas", () => orm.searchRead("fsm.stage", [["stage_type", "=", "order"]], ["name"]));
}

export function traerCotizaciones(orm) {
    return leerConRespaldo("cotizaciones", () => orm.call("fsm.person", "shalom_mis_cotizaciones", []));
}

// -- Clientes (pestaña Clientes y formulario de cliente, también sin señal) --

/** Pestaña Clientes: los del servidor (o la copia) + los creados sin señal,
 * con lo editado sin señal ya aplicado. */
export async function traerMisClientes(orm) {
    let clientes = [];
    try {
        clientes = await leerConRespaldo("mis_clientes", () => orm.call("fsm.person", "shalom_mis_clientes", []));
    } catch (error) {
        if (!esErrorDeRed(error)) {
            throw error;
        }
        if (!clientesProvisorios().length) {
            throw error;
        }
    }
    const editados = (clientes || []).map((c) => {
        const f = aplicarEdiciones(c.id, {...c, x_nombre_contacto: ""});
        return {...c, name: f.name, phone: f.phone, street: f.street, street2: f.street2, vat: f.vat, mobile: f.mobile, email: f.email};
    });
    return [...clientesProvisorios(), ...editados];
}

/** Selector de ruta del formulario de cliente. */
export function traerMisRutas(orm) {
    return leerConRespaldo("mis_rutas", () => orm.call("fsm.person", "shalom_mis_rutas", []));
}

/** "Va después de": los clientes de una ruta en su orden (+ los nuevos). */
export async function traerClientesDeRuta(orm, routeId) {
    const lista = await leerConRespaldo(`clientes_ruta:${routeId}`, async () => {
        const r = await orm.call("fsm.location", "shalom_clientes_de_rutas", [[routeId]]);
        return r[routeId] || r[String(routeId)] || [];
    });
    const nuevos = clientesProvisorios()
        .filter((c) => c.fsm_route_id === routeId)
        .map((c) => ({id: c.id, name: c.name, x_orden_ruta: c.x_orden_ruta}));
    return [...(lista || []), ...nuevos].sort((a, b) => (a.x_orden_ruta || 0) - (b.x_orden_ruta || 0));
}

/** "Editar cliente": la ficha completa (también sin señal). */
export async function traerFichaClienteForm(orm, locationId) {
    if (esProvisorio(locationId)) {
        const f = fichaProvisoria(locationId);
        if (f) {
            return f;
        }
        const real = await idRealDe(locationId, "location_id");
        if (!real) {
            throw new SinDatosLocalesError(`cliente_form:${locationId}`);
        }
        locationId = real;
    }
    const ficha = await leerConRespaldo(`cliente_form:${locationId}`, async () => {
        const r = await orm.call("fsm.location", "shalom_fichas_cliente_form", [[locationId]]);
        const f = r[locationId] || r[String(locationId)];
        if (!f) {
            throw new Error("El cliente ya no existe.");
        }
        return f;
    });
    return aplicarEdiciones(locationId, ficha);
}

const FICHAS_POR_LLAMADA = 300;
const CLIENTES_VIGENCIA_MS = 12 * 60 * 60 * 1000; // se refrescan solos cada 12 h
let descargandoClientes = null;

/** Deja en el teléfono TODOS los clientes (las rutas son libres: cualquiera
 * puede editar o venderle a cualquiera), con su ficha completa para "Editar
 * cliente", y las listas por ruta de "Va después de". Se baja solo (al abrir
 * la app y en "Preparar mi día"); no depende de qué rutas se descargaron. */
export function descargarClientes(orm) {
    if (descargandoClientes) {
        return descargandoClientes;
    }
    descargandoClientes = (async () => {
        const [clientes] = await Promise.all([
            orm.call("fsm.person", "shalom_mis_clientes", []),
            traerMisRutas(orm).catch(() => null),
            leerConRespaldo("puede_distribuidora", () => orm.call("fsm.location", "shalom_puede_marcar_distribuidora", [])).catch(() => null),
        ]);
        marcarRed(true);
        await guardarLocal("mis_clientes", clientes);
        // Listas por ruta ("Va después de"): salen del mismo directorio.
        const porRuta = {};
        for (const c of clientes) {
            if (c.fsm_route_id) {
                (porRuta[c.fsm_route_id] = porRuta[c.fsm_route_id] || []).push({id: c.id, name: c.name || "", x_orden_ruta: c.x_orden_ruta || 0});
            }
        }
        await Promise.all(
            Object.entries(porRuta).map(([id, lista]) =>
                guardarLocal(`clientes_ruta:${id}`, lista.sort((a, b) => a.x_orden_ruta - b.x_orden_ruta))
            )
        );
        // Fichas completas, en tandas y de a 3 llamadas a la vez.
        const ids = clientes.map((c) => c.id);
        const tandas = [];
        for (let i = 0; i < ids.length; i += FICHAS_POR_LLAMADA) {
            tandas.push(ids.slice(i, i + FICHAS_POR_LLAMADA));
        }
        let siguiente = 0;
        let guardadas = 0;
        const trabajador = async () => {
            while (siguiente < tandas.length) {
                const tanda = tandas[siguiente++];
                const fichas = await orm.call("fsm.location", "shalom_fichas_cliente_form", [tanda]);
                await Promise.all(Object.entries(fichas || {}).map(([id, f]) => guardarLocal(`cliente_form:${id}`, f)));
                guardadas += Object.keys(fichas || {}).length;
                estadoOffline.clientesGuardados = guardadas;
            }
        };
        await Promise.all(Array.from({length: Math.min(3, tandas.length)}, trabajador));
        // Clientes que ya no existen o salieron de las rutas: se borran.
        const vigentes = new Set(ids.map(String));
        for (const clave of await listarClaves("cliente_form:")) {
            if (!vigentes.has(clave.slice("cliente_form:".length))) {
                await borrarLocal(clave);
            }
        }
        estadoOffline.clientesGuardados = ids.length;
        estadoOffline.clientesEn = Date.now();
        await guardarLocal("meta:clientes", {en: estadoOffline.clientesEn, total: ids.length});
        return ids.length;
    })().finally(() => {
        descargandoClientes = null;
    });
    return descargandoClientes;
}

/** Al abrir la app: si los clientes no están en el teléfono (o tienen más de
 * 12 h), se bajan solos por detrás. Sin señal no hace nada. */
export async function completarClientes(orm, {forzar = false} = {}) {
    if (sinConexion() || !orm) {
        return;
    }
    const meta = await leerLocal("meta:clientes");
    if (meta && meta.valor) {
        estadoOffline.clientesEn = meta.valor.en;
        estadoOffline.clientesGuardados = meta.valor.total;
    }
    if (!forzar && meta && meta.valor && Date.now() - meta.valor.en < CLIENTES_VIGENCIA_MS) {
        return;
    }
    try {
        await descargarClientes(orm);
    } catch (error) {
        console.error("shalom: no se pudieron bajar los clientes", error);
    }
}

// ------------------------------------------------------------------
// Fotos del catálogo
// ------------------------------------------------------------------

/** URL de foto de producto cacheable: con "unique", Odoo la sirve como
 * inmutable (1 año) y el teléfono no la vuelve a pedir, ni con señal ni
 * sin ella. `version` = shalom_marcas_fotos (cambia solo si el producto
 * o su plantilla cambian en Odoo): así cada foto se baja UNA vez y sirve
 * los días siguientes. Sin versión (catálogo viejo guardado), la fecha
 * del día, como antes. */
export function urlFotoProducto(productId, campo = "image_512", version = null) {
    let marca = version;
    if (!marca) {
        const hoy = new Date();
        marca = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
    }
    return `/web/image/product.product/${productId}/${campo}?unique=${marca}`;
}

function precargarImagen(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
    });
}

// Fotos guardadas en el teléfono (Cache Storage), como los datos offline:
// el service worker (controllers/offline_sw.py, mismo nombre de caché) las
// sirve desde acá al instante, con o sin señal. La caché HTTP del navegador
// no alcanza: en Android es chica y la comparten todos los sitios.
export const CACHE_FOTOS = "shalom-fotos-v1";
const TAMANOS_FOTO_GUARDADA = ["image_256", "image_512"];

async function abrirCacheFotos() {
    try {
        return typeof caches !== "undefined" ? await caches.open(CACHE_FOTOS) : null;
    } catch {
        return null;
    }
}

function urlAbsoluta(url) {
    return new URL(url, window.location.origin).href;
}

/** Guarda una foto en el teléfono. Si ya estaba, no se vuelve a bajar. */
async function guardarFoto(cache, url) {
    if (!cache) {
        // Sin Cache Storage: al menos queda en la caché del navegador.
        return precargarImagen(url);
    }
    try {
        const clave = urlAbsoluta(url);
        if (await cache.match(clave)) {
            return true;
        }
        const respuesta = await fetch(clave, {credentials: "same-origin"});
        const tipo = respuesta.headers.get("content-type") || "";
        if (respuesta.status !== 200 || !tipo.startsWith("image/")) {
            return false;
        }
        await cache.put(clave, respuesta);
        return true;
    } catch {
        return false;
    }
}

/** Borra del teléfono las fotos que ya no sirven: versiones viejas (la foto
 * o el producto cambiaron en Odoo) y productos que ya no están. */
export async function limpiarFotosViejas(productos) {
    // Sin las versiones de las fotos (shalom_marcas_fotos falló), no se
    // sabe cuáles son las vigentes: no se borra nada.
    if (!productos.length || productos.some((p) => !p.foto_v)) {
        return 0;
    }
    const cache = await abrirCacheFotos();
    if (!cache) {
        return 0;
    }
    const vigentes = new Set();
    for (const producto of productos) {
        for (const campo of TAMANOS_FOTO_GUARDADA) {
            vigentes.add(urlAbsoluta(urlFotoProducto(producto.id, campo, producto.foto_v)));
        }
    }
    let borradas = 0;
    try {
        for (const pedido of await cache.keys()) {
            if (!vigentes.has(pedido.url)) {
                await cache.delete(pedido);
                borradas += 1;
            }
        }
    } catch {
        // si falla, se limpia la próxima vez
    }
    return borradas;
}

/** Guarda en el teléfono las fotos de las tarjetas del catálogo (de a pocas
 * a la vez). Las que ya están no se bajan. onProgreso(hechas, total). */
export async function precargarFotos(productos, onProgreso) {
    const cache = await abrirCacheFotos();
    let hechas = 0;
    let siguiente = 0;
    const trabajador = async () => {
        while (siguiente < productos.length) {
            if (sinConexion()) {
                return;
            }
            const producto = productos[siguiente++];
            // Misma URL que las tarjetas del catálogo y que la foto ampliada.
            await guardarFoto(cache, urlFotoProducto(producto.id, "image_512", producto.foto_v));
            hechas += 1;
            if (onProgreso) {
                onProgreso(hechas, productos.length);
            }
        }
    };
    await Promise.all(Array.from({length: FOTOS_EN_PARALELO}, trabajador));
    return hechas;
}

// Pantalla encendida mientras se descarga (así el teléfono no congela la
// página). Se pide de nuevo al volver a la app si sigue descargando.
let pantallaLock = null;
let pantallaPedidos = 0;

async function pedirPantalla() {
    if (pantallaLock || !pantallaPedidos || typeof navigator === "undefined" || !navigator.wakeLock) {
        return;
    }
    try {
        pantallaLock = await navigator.wakeLock.request("screen");
        pantallaLock.addEventListener("release", () => {
            pantallaLock = null;
        });
    } catch {
        pantallaLock = null; // sin permiso o batería baja: no es crítico
    }
}

/** Mantiene la pantalla encendida hasta llamar a la función devuelta. */
export function mantenerPantalla() {
    pantallaPedidos += 1;
    pedirPantalla();
    let suelto = false;
    return () => {
        if (suelto) {
            return;
        }
        suelto = true;
        pantallaPedidos = Math.max(0, pantallaPedidos - 1);
        if (!pantallaPedidos && pantallaLock) {
            const lock = pantallaLock;
            pantallaLock = null;
            lock.release().catch(() => {});
        }
    };
}

const FOTOS_POR_LOTE_SEGUNDO_PLANO = 200;
const PREFIJO_BG_FOTOS = "shalom-fotos-";

/** Background Fetch (Chrome/Android): el sistema baja las fotos aunque se
 * apague la pantalla o se cierre la app; el service worker las guarda.
 * Devuelve false si no se puede (se baja desde la página). */
async function fotosEnSegundoPlano(faltan) {
    try {
        if (typeof navigator === "undefined" || !navigator.serviceWorker) {
            return false;
        }
        const registro = await navigator.serviceWorker.ready;
        if (!registro || !registro.backgroundFetch) {
            return false;
        }
        const activos = (await registro.backgroundFetch.getIds()).filter((id) => id.startsWith(PREFIJO_BG_FOTOS));
        if (activos.length) {
            return true; // ya hay lotes bajando: solo se espera
        }
        for (let i = 0; i < faltan.length; i += FOTOS_POR_LOTE_SEGUNDO_PLANO) {
            const lote = faltan.slice(i, i + FOTOS_POR_LOTE_SEGUNDO_PLANO);
            await registro.backgroundFetch.fetch(
                `${PREFIJO_BG_FOTOS}${Date.now()}-${i}`,
                lote.map((p) => urlAbsoluta(urlFotoProducto(p.id, "image_512", p.foto_v))),
                {title: "Fotos de Ruta Shalom", downloadTotal: lote.length * 60000}
            );
        }
        return true;
    } catch {
        return false;
    }
}

async function hayLotesEnSegundoPlano() {
    try {
        const registro = await navigator.serviceWorker.ready;
        const ids = registro.backgroundFetch ? await registro.backgroundFetch.getIds() : [];
        return ids.some((id) => id.startsWith(PREFIJO_BG_FOTOS));
    } catch {
        return false;
    }
}

const FOTO_VERSION_VIEJA = /^\d{14}$/; // versión por fecha (antes de la huella)
let productosDeFotos = [];
let completandoFotos = null;
let repetirFotos = false;

function tieneVersionVigente(producto) {
    return !!producto.foto_v && !FOTO_VERSION_VIEJA.test(producto.foto_v);
}

/** Cuenta las fotos del catálogo que ya están en el teléfono. */
async function contarFotosGuardadas(cache, productos) {
    const guardadas = new Set();
    try {
        for (const pedido of await cache.keys()) {
            guardadas.add(pedido.url);
        }
    } catch {
        // sin lista: se verá producto por producto
    }
    return productos.filter((p) => guardadas.has(urlAbsoluta(urlFotoProducto(p.id, "image_512", p.foto_v))));
}

/**
 * Deja TODAS las fotos del catálogo en el teléfono, sin que el vendedor
 * tenga que recorrer el catálogo: baja por detrás solo las que faltan (6 a
 * la vez, primero los productos con existencias). Un solo proceso a la
 * vez; sin señal se pausa y retoma cuando vuelve (ver el oyente "online").
 */
export function completarFotos(productos) {
    productosDeFotos = productos || productosDeFotos;
    if (completandoFotos) {
        // Ya hay uno corriendo: se le avisa que repase y se espera al mismo.
        repetirFotos = true;
        return completandoFotos;
    }
    // La promesa se guarda antes de cualquier espera: no corren dos a la vez.
    completandoFotos = bajarFotosFaltantes().finally(() => {
        completandoFotos = null;
    });
    return completandoFotos;
}

async function bajarFotosFaltantes() {
    const soltarPantalla = mantenerPantalla();
    try {
        const cache = await abrirCacheFotos();
        const lista = productosDeFotos.filter(tieneVersionVigente);
        if (!cache || !lista.length) {
            return;
        }
        do {
            repetirFotos = false;
            const ya = new Set((await contarFotosGuardadas(cache, lista)).map((p) => p.id));
            estadoOffline.fotosTotal = lista.length;
            estadoOffline.fotosGuardadas = ya.size;
            const faltan = lista
                .filter((p) => !ya.has(p.id))
                .sort((a, b) => (b.stock_dianke > 0 || b.stock_nevada > 0 ? 1 : 0) - (a.stock_dianke > 0 || a.stock_nevada > 0 ? 1 : 0));
            if (faltan.length && !sinConexion() && (await fotosEnSegundoPlano(faltan))) {
                // El sistema baja las fotos; acá solo se sigue el avance.
                while (!sinConexion() && (await hayLotesEnSegundoPlano())) {
                    await new Promise((r) => setTimeout(r, 3000));
                    estadoOffline.fotosGuardadas = (await contarFotosGuardadas(cache, lista)).length;
                }
                estadoOffline.fotosGuardadas = (await contarFotosGuardadas(cache, lista)).length;
                break;
            }
            let siguiente = 0;
            const trabajador = async () => {
                while (siguiente < faltan.length) {
                    if (sinConexion()) {
                        return;
                    }
                    const producto = faltan[siguiente++];
                    if (await guardarFoto(cache, urlFotoProducto(producto.id, "image_512", producto.foto_v))) {
                        estadoOffline.fotosGuardadas += 1;
                    }
                }
            };
            await Promise.all(Array.from({length: FOTOS_EN_PARALELO}, trabajador));
        } while (repetirFotos && !sinConexion());
        if (estadoOffline.fotosGuardadas >= estadoOffline.fotosTotal && estadoOffline.fotosTotal) {
            if (!estadoOffline.fotosEn) {
                estadoOffline.fotosEn = Date.now();
                await guardarLocal("meta:fotos_en", estadoOffline.fotosEn);
            }
        }
    } catch (error) {
        console.error("shalom: no se pudieron completar las fotos", error);
    } finally {
        soltarPantalla();
    }
}

/** Al abrir la app: con el catálogo guardado en el teléfono, completa las
 * fotos que falten. Si el catálogo guardado es de antes de las versiones por
 * huella (o no hay), con señal lo refresca primero. */
export async function completarFotosGuardadas(orm) {
    ormParaReanudar = orm || ormParaReanudar;
    if (sinConexion()) {
        return;
    }
    completarClientes(orm); // clientes y fichas, por detrás
    const local = await leerLocal("catalogo");
    const productos = local && local.valor ? local.valor.productos || [] : [];
    if (productos.length && productos.every(tieneVersionVigente)) {
        return completarFotos(productos);
    }
    if (orm) {
        try {
            await traerCatalogo(orm); // dispara completarFotos con lo nuevo
        } catch {
            // sin señal buena: se reintenta al abrir otra vez
        }
    }
}

let ormParaReanudar = null;

/** Volvió la señal o la app: repasar lo que falte (fotos y, si "Preparar
 * mi día" quedó a medias, seguir con eso). */
async function reanudarDescargas() {
    if (sinConexion()) {
        return;
    }
    if (pantallaPedidos) {
        pedirPantalla(); // el sistema suelta el bloqueo al ocultar la app
    }
    if (ormParaReanudar) {
        const interrumpido = await leerLocal("meta:preparando");
        if (interrumpido && interrumpido.valor && !estadoOffline.preparando) {
            prepararDia(ormParaReanudar, {reanudarDesde: interrumpido.valor}).catch(() => {});
            return;
        }
        completarFotosGuardadas(ormParaReanudar);
        completarClientes(ormParaReanudar);
    } else if (productosDeFotos.length) {
        completarFotos();
    }
}

if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("online", reanudarDescargas);
    window.addEventListener("pageshow", reanudarDescargas);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            reanudarDescargas();
        }
    });
}

// ------------------------------------------------------------------
// Preparar mi día
// ------------------------------------------------------------------

/** Guarda en el teléfono todo lo de UNA ruta: lista de visitas y, en una
 * sola llamada (shalom_paquete_offline), lo de cada visita y cliente. */
export async function prepararRuta(orm, schedule) {
    await traerDetalleRuta(orm, schedule);
    const paquete = await conTimeout(
        orm.call("fsm.route.schedule", "shalom_paquete_offline", [schedule.id]),
        TIMEOUT_PAQUETE_MS
    );
    const escrituras = [];
    for (const [orderId, datos] of Object.entries(paquete.visitas || {})) {
        escrituras.push(guardarLocal(`visita:${orderId}`, datos));
    }
    for (const [orderId, datos] of Object.entries(paquete.faltantes || {})) {
        escrituras.push(guardarLocal(`faltantes:${orderId}`, datos));
    }
    for (const [locationId, datos] of Object.entries(paquete.fichas || {})) {
        escrituras.push(guardarLocal(`ficha:${locationId}`, datos));
    }
    for (const [locationId, datos] of Object.entries(paquete.pedidos || {})) {
        escrituras.push(guardarLocal(`pedidos:${locationId}`, datos));
    }
    for (const [locationId, datos] of Object.entries(paquete.ultima_fp || {})) {
        escrituras.push(guardarLocal(`ultima_fp:${locationId}`, datos));
    }
    await Promise.all(escrituras);
    // Ficha de "Editar cliente" de cada cliente de la ruta (sin señal).
    const idsClientes = Object.keys(paquete.pedidos || {}).map(Number);
    if (idsClientes.length) {
        try {
            const fichas = await orm.call("fsm.location", "shalom_fichas_cliente_form", [idsClientes]);
            await Promise.all(Object.entries(fichas || {}).map(([id, f]) => guardarLocal(`cliente_form:${id}`, f)));
        } catch (error) {
            console.error("shalom: no se pudieron guardar las fichas de cliente", error);
        }
    }
    const ahora = Date.now();
    await guardarLocal(`ruta_preparada:${schedule.id}`, ahora);
    // Ficha de lo que quedó guardado de esta ruta: para mostrarla en el
    // panel (nombre, clientes, hora) y para la limpieza de lo viejo
    // (qué visitas y clientes le pertenecen).
    const visitas = Object.keys(paquete.visitas || {}).map(Number);
    const clientes = Object.keys(paquete.pedidos || {}).map(Number);
    const ficha = {nombre: schedule.route_name || "", clientes: visitas.length, en: ahora, visitas, clientes_ids: clientes};
    await guardarLocal(`meta:ruta_${schedule.id}`, ficha);
    estadoOffline.rutasMeta = {...estadoOffline.rutasMeta, [schedule.id]: {nombre: ficha.nombre, clientes: ficha.clientes, en: ahora}};
    if (!estadoOffline.rutasPreparadas.includes(schedule.id)) {
        estadoOffline.rutasPreparadas = [...estadoOffline.rutasPreparadas, schedule.id];
        await guardarLocal("meta:rutas_preparadas", estadoOffline.rutasPreparadas);
    }
}

/**
 * Borra del teléfono lo que ya no sirve: rutas que ya no tienen clientes
 * pendientes, y las visitas y clientes que no son de ninguna ruta vigente.
 * `vigentes`: ids de las rutas con pendientes. `soloRutas`: no tocar
 * visitas/clientes (si alguna ruta no se pudo bajar, sus datos viejos se
 * conservan por las dudas). NUNCA toca la cola de lo que espera enviarse.
 * Devuelve cuántas claves borró.
 */
export async function limpiarDatosViejos(vigentes, {soloRutas = false} = {}) {
    const siguen = new Set(vigentes.map(String));
    const visitas = new Set();
    const clientes = new Set();
    const borrar = [];
    for (const clave of await listarClaves("meta:ruta_")) {
        const id = clave.slice("meta:ruta_".length);
        if (!siguen.has(id)) {
            borrar.push(clave);
            continue;
        }
        const ficha = await leerLocal(clave);
        for (const v of (ficha && ficha.valor && ficha.valor.visitas) || []) {
            visitas.add(String(v));
        }
        for (const c of (ficha && ficha.valor && ficha.valor.clientes_ids) || []) {
            clientes.add(String(c));
        }
    }
    for (const prefijo of ["ruta:", "ruta_preparada:"]) {
        for (const clave of await listarClaves(prefijo)) {
            if (!siguen.has(clave.slice(prefijo.length))) {
                borrar.push(clave);
            }
        }
    }
    if (!soloRutas) {
        for (const prefijo of ["visita:", "faltantes:"]) {
            for (const clave of await listarClaves(prefijo)) {
                if (!visitas.has(clave.slice(prefijo.length))) {
                    borrar.push(clave);
                }
            }
        }
        for (const prefijo of ["ficha:", "pedidos:", "ultima_fp:"]) {
            for (const clave of await listarClaves(prefijo)) {
                if (!clientes.has(clave.slice(prefijo.length))) {
                    borrar.push(clave);
                }
            }
        }
    }
    await Promise.all(borrar.map((clave) => borrarLocal(clave)));
    const metas = {...estadoOffline.rutasMeta};
    for (const id of Object.keys(metas)) {
        if (!siguen.has(String(id))) {
            delete metas[id];
        }
    }
    estadoOffline.rutasMeta = metas;
    return borrar.length;
}

/** "Bajar solo lo nuevo": descarga únicamente las rutas con pendientes
 * que todavía no están en el teléfono (el resto ya está de hoy). */
export async function prepararSoloNuevas(orm) {
    if (estadoOffline.preparando) {
        return;
    }
    if (sinConexion()) {
        throw new SinDatosLocalesError("preparar");
    }
    estadoOffline.preparando = true;
    estadoOffline.progreso = 5;
    try {
        estadoOffline.red = "en_linea";
        const rutas = await traerRutas(orm, ventanaRutas());
        const tenidas = new Set(estadoOffline.rutasPreparadas);
        const nuevas = (rutas || []).filter((s) => !tenidas.has(s.id));
        let hechas = 0;
        let fallidas = 0;
        for (const s of nuevas) {
            estadoOffline.mensajePreparar = `Ruta nueva: ${s.route_name}…`;
            try {
                await prepararRuta(orm, s);
            } catch (error) {
                fallidas += 1;
            }
            hechas += 1;
            estadoOffline.progreso = 5 + Math.round((95 * hechas) / Math.max(1, nuevas.length));
        }
        estadoOffline.mensajePreparar = fallidas
            ? `Se bajaron ${nuevas.length - fallidas} de ${nuevas.length} rutas nuevas. Probá de nuevo con mejor señal.`
            : `Listo: ${nuevas.length} ruta(s) nueva(s) en el teléfono.`;
        estadoOffline.progreso = 100;
        return {rutas: nuevas.length - fallidas, total: nuevas.length, fallidas};
    } finally {
        soltarPantalla();
        estadoOffline.preparando = false;
    }
}

/** Botón "Borrar" del panel: vacía TODO lo descargado. La cola de lo que
 * espera enviarse queda intacta. */
export async function borrarDatosDescargados() {
    await borrarTodoLocal();
    try {
        if (typeof caches !== "undefined") {
            await caches.delete(CACHE_FOTOS);
        }
    } catch {
        // sin Cache Storage: nada que borrar
    }
    estadoOffline.preparadoEn = null;
    estadoOffline.fotosEn = null;
    estadoOffline.rutasPreparadas = [];
    estadoOffline.rutasMeta = {};
    estadoOffline.productosGuardados = 0;
    estadoOffline.clientesGuardados = 0;
    estadoOffline.clientesEn = null;
    estadoOffline.mensajePreparar = "";
    await estimarEspacio();
}

/** Cuánto ocupan los datos de la app en el teléfono (si el navegador lo dice). */
export async function estimarEspacio() {
    try {
        if (navigator.storage && navigator.storage.estimate) {
            const {usage} = await navigator.storage.estimate();
            estadoOffline.espacioUsado = typeof usage === "number" ? usage : null;
            return estadoOffline.espacioUsado;
        }
    } catch {
        // sin API: no se muestra
    }
    estadoOffline.espacioUsado = null;
    return null;
}

export function textoMegas(bytes) {
    if (typeof bytes !== "number") {
        return "";
    }
    const mb = bytes / (1024 * 1024);
    return mb < 1 ? "menos de 1 MB" : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Rutas que "Preparar mi día" descarga: TODAS las que tienen clientes
 * pendientes (decisión del usuario: las rutas no están asignadas, cada
 * vendedor elige la suya en la calle). shalom_mis_rutas_programadas ya
 * trae solo esas. */
export function rutasParaPreparar(schedules) {
    return [...(schedules || [])];
}

// Rutas que se preparan a la vez (en vez de una tras otra).
const RUTAS_EN_PARALELO = 3;

function ventanaRutas() {
    const hoy = new Date();
    const desde = new Date(hoy);
    desde.setDate(desde.getDate() - 7);
    const hasta = new Date(hoy);
    hasta.setDate(hasta.getDate() + 28);
    const f = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return [f(desde), f(hasta)];
}

/**
 * "Preparar mi día": con señal, deja en el teléfono todo lo necesario
 * para trabajar sin ella. Las fotos del catálogo se bajan siempre
 * (solo las que faltan; ~100 MB la primera vez). `opciones.schedules`: rutas a
 * preparar (si no, las de rutasParaPreparar). Actualiza estadoOffline.
 */
export async function prepararDia(orm, {schedules = null, reanudarDesde = null} = {}) {
    if (estadoOffline.preparando) {
        return;
    }
    if (sinConexion()) {
        throw new SinDatosLocalesError("preparar");
    }
    estadoOffline.preparando = true;
    estadoOffline.progreso = 0;
    ormParaReanudar = orm;
    const soltarPantalla = mantenerPantalla();
    // Marca de "a medias": si la app se congela, al volver sigue donde iba.
    const inicio = reanudarDesde || Date.now();
    await guardarLocal("meta:preparando", inicio);
    const paso = (mensaje, progreso) => {
        estadoOffline.mensajePreparar = mensaje;
        estadoOffline.progreso = progreso;
    };
    try {
        pedirAlmacenamientoPersistente();
        // Forzar red (no la copia local): se está preparando con señal.
        estadoOffline.red = "en_linea";
        paso("Tus rutas…", 5);
        const rutas = await traerRutas(orm, ventanaRutas());
        paso("Catálogo, precios y existencias…", 15);
        const catalogo = await traerCatalogo(orm);
        paso("Formas de pago y estados…", 25);
        await Promise.all([traerFormasPago(orm), traerEtapas(orm), traerCotizaciones(orm).catch(() => null)]);
        const elegidas = schedules || rutasParaPreparar(rutas);
        paso("Clientes y sus fichas…", 28);
        await completarClientes(orm, {forzar: true});
        let hechas = 0;
        let fallidas = 0;
        let siguiente = 0;
        const trabajador = async () => {
            while (siguiente < elegidas.length) {
                const s = elegidas[siguiente++];
                try {
                    const meta = reanudarDesde ? estadoOffline.rutasMeta[s.id] : null;
                    if (!(meta && meta.en >= reanudarDesde)) {
                        await prepararRuta(orm, s);
                    }
                } catch (error) {
                    // Una ruta que no baja no frena las demás: se informa al final.
                    fallidas += 1;
                    console.error("shalom: no se pudo preparar la ruta", s.route_name, error);
                }
                hechas += 1;
                paso(
                    `Rutas: ${hechas} de ${elegidas.length} (${s.route_name})…`,
                    30 + Math.round((40 * hechas) / Math.max(1, elegidas.length))
                );
            }
        };
        await Promise.all(Array.from({length: Math.min(RUTAS_EN_PARALELO, elegidas.length)}, trabajador));
        if (fallidas && fallidas === elegidas.length) {
            throw new SinDatosLocalesError("rutas");
        }
        const ahora = Date.now();
        estadoOffline.preparadoEn = ahora;
        await guardarLocal("meta:preparado_en", ahora);
        // Solo cuentan las rutas que siguen con pendientes (las demás ya
        // no aparecen en la lista y no hace falta tenerlas).
        const disponibles = new Set(elegidas.map((s) => s.id));
        estadoOffline.rutasPreparadas = estadoOffline.rutasPreparadas.filter((id) => disponibles.has(id));
        await guardarLocal("meta:rutas_preparadas", estadoOffline.rutasPreparadas);
        estadoOffline.productosGuardados = catalogo.productos.length;
        await guardarLocal("meta:productos", estadoOffline.productosGuardados);
        // Lo viejo (ciclos terminados) se borra: el teléfono no acumula.
        await limpiarDatosViejos(elegidas.map((s) => s.id), {soloRutas: fallidas > 0});
        await limpiarFotosViejas(catalogo.productos);
        // Las fotos se bajan siempre (solo las que faltan).
        await guardarLocal("meta:preparando", null); // terminó lo de datos
        await completarFotos(catalogo.productos);
        if (estadoOffline.fotosTotal) {
            paso(`Fotos del catálogo: ${estadoOffline.fotosGuardadas} de ${estadoOffline.fotosTotal}…`, 95);
        }
        const listas = elegidas.length - fallidas;
        estimarEspacio();
        paso(
            fallidas
                ? `Listo: ${listas} de ${elegidas.length} rutas (${fallidas} no se pudieron bajar: probá de nuevo con mejor señal) y ${catalogo.productos.length} productos.`
                : `Listo: ${listas} ruta(s) y ${catalogo.productos.length} productos en el teléfono.`,
            100
        );
        return {rutas: listas, total: elegidas.length, fallidas, productos: catalogo.productos.length};
    } catch (error) {
        paso("No se pudo terminar de preparar. Probá de nuevo con mejor señal.", estadoOffline.progreso);
        throw error;
    } finally {
        estadoOffline.preparando = false;
    }
}

/** Fechas de la última preparación (para "Datos de hace X"). */
export async function cargarMetaPreparacion() {
    const [preparado, fotos, rutas, productos, listaRutas, clavesFichas, clientesMeta] = await Promise.all([
        leerLocal("meta:preparado_en"),
        leerLocal("meta:fotos_en"),
        leerLocal("meta:rutas_preparadas"),
        leerLocal("meta:productos"),
        leerLocal("rutas"),
        listarClaves("meta:ruta_"),
        leerLocal("meta:clientes"),
    ]);
    if (clientesMeta && clientesMeta.valor) {
        estadoOffline.clientesEn = clientesMeta.valor.en;
        estadoOffline.clientesGuardados = clientesMeta.valor.total;
    }
    const metas = {};
    for (const clave of clavesFichas) {
        const ficha = await leerLocal(clave);
        if (ficha && ficha.valor) {
            metas[Number(clave.slice("meta:ruta_".length))] = {
                nombre: ficha.valor.nombre,
                clientes: ficha.valor.clientes,
                en: ficha.valor.en,
            };
        }
    }
    estadoOffline.rutasMeta = metas;
    estimarEspacio();
    estadoOffline.preparadoEn = preparado ? preparado.valor : null;
    estadoOffline.fotosEn = fotos ? fotos.valor : null;
    estadoOffline.rutasPreparadas = rutas && Array.isArray(rutas.valor) ? rutas.valor : [];
    estadoOffline.productosGuardados = productos ? productos.valor || 0 : 0;
    if (estadoOffline.rutasDisponibles === null && listaRutas && Array.isArray(listaRutas.valor)) {
        estadoOffline.rutasDisponibles = listaRutas.valor.map((s) => s.id);
        estadoOffline.rutasNombres = Object.fromEntries(listaRutas.valor.map((s) => [s.id, s.route_name]));
    }
}

/** Fecha y hora cortas y amigables: "hoy 8:05 a. m.", "ayer 5:40 p. m.",
 * "lun 14/11, 9:00 a. m.". */
export function cuandoAmigable(ts) {
    if (!ts) {
        return "";
    }
    const fecha = new Date(ts);
    const hora = fecha.toLocaleTimeString("es-PA", {hour: "numeric", minute: "2-digit"});
    const hoy = new Date();
    const ayer = new Date();
    ayer.setDate(hoy.getDate() - 1);
    const mismoDia = (a, b) => a.toDateString() === b.toDateString();
    if (mismoDia(fecha, hoy)) {
        return `hoy ${hora}`;
    }
    if (mismoDia(fecha, ayer)) {
        return `ayer ${hora}`;
    }
    const dia = fecha.toLocaleDateString("es-PA", {weekday: "short", day: "numeric", month: "numeric"});
    return `${dia}, ${hora}`;
}

/** Estado de los datos del teléfono para el checklist del panel. */
export function resumenDatosTelefono(estado, ahora = new Date()) {
    const preparadas = new Set(estado.rutasPreparadas || []);
    const disponibles = estado.rutasDisponibles;
    const rutasGuardadas = disponibles ? disponibles.filter((id) => preparadas.has(id)).length : preparadas.size;
    const rutasNuevas = disponibles ? disponibles.filter((id) => !preparadas.has(id)).length : 0;
    let frescura = "al_dia";
    if (!estado.preparadoEn) {
        frescura = "sin_descargar";
    } else if (new Date(estado.preparadoEn).toDateString() !== ahora.toDateString() || rutasNuevas > 0) {
        frescura = "actualizar";
    }
    const nombres = estado.rutasNombres || {};
    const metas = estado.rutasMeta || {};
    const rutasLista = (disponibles || [...preparadas]).map((id) => {
        const meta = metas[id];
        return {
            id,
            nombre: nombres[id] || (meta && meta.nombre) || `Ruta ${id}`,
            descargada: preparadas.has(id),
            clientes: meta ? meta.clientes : null,
            hora: meta && meta.en
                ? new Date(meta.en).toLocaleTimeString("es-PA", {hour: "numeric", minute: "2-digit"})
                : "",
        };
    }).sort((a, b) => (a.descargada === b.descargada ? a.nombre.localeCompare(b.nombre) : a.descargada ? 1 : -1));
    // Descargado hoy y solo faltan rutas nuevas: no hace falta bajar todo.
    const soloNuevas = frescura === "actualizar" && rutasNuevas > 0
        && new Date(estado.preparadoEn).toDateString() === ahora.toDateString();
    return {
        frescura,
        rutasGuardadas,
        rutasTotal: disponibles ? disponibles.length : preparadas.size,
        rutasLista,
        soloNuevas,
        rutasNuevas,
        productos: estado.productosGuardados || 0,
        cuando: cuandoAmigable(estado.preparadoEn),
        fotosCuando: estado.fotosEn ? cuandoAmigable(estado.fotosEn) : "",
    };
}
