/** @odoo-module **/

import {guardarLocal, leerLocal, pedirAlmacenamientoPersistente} from "./almacen_local";
import {conTimeout, sinConexion, TiempoAgotadoError} from "./red_utils";
import {estadoOffline, marcarRed} from "./sincronizador";

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

export function traerRutas(orm, ventana) {
    return leerConRespaldo("rutas", () => orm.call("fsm.person", "shalom_mis_rutas_programadas", ventana));
}

/** RutaDetalle.cargar(): visitas del ciclo + datos de clientes + perfiles + trazado. */
export function traerDetalleRuta(orm, schedule) {
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
export function traerVisita(orm, orderId) {
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
    return leerConRespaldo(`ficha:${locationId}`, () => orm.call("fsm.order", "shalom_ficha_juego", [locationId]));
}

/** OrderScreen._cargarDatosFaltantes(). */
export function traerFaltantes(orm, orderId) {
    return leerConRespaldo(`faltantes:${orderId}`, async () => {
        const [orden] = await orm.read("fsm.order", [orderId], ["location_id"]);
        const datosFaltantes = await orm.call("fsm.order", "shalom_campos_cliente_faltantes", [[orderId]]);
        return {locationId: orden.location_id ? orden.location_id[0] : false, datosFaltantes};
    });
}

/** OrderScreen.cargarProductos(): productos + existencias por bodega +
 * estrategias (estas dos últimas a prueba de fallos, como siempre). */
export function traerCatalogo(orm) {
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
            ]);
            return {productos, estrategiaPorProducto, descargadoEn: Date.now()};
        },
        {timeoutMs: 30000}
    );
}

export function traerPedidosAnteriores(orm, locationId) {
    return leerConRespaldo(`pedidos:${locationId}`, () => orm.call("fsm.order", "shalom_pedidos_anteriores", [locationId]));
}

export function traerFormasPago(orm) {
    return leerConRespaldo("formas_pago", () => orm.call("fsm.order", "shalom_formas_pago_disponibles", []));
}

export function traerUltimaFormaPago(orm, locationId) {
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

// ------------------------------------------------------------------
// Fotos del catálogo
// ------------------------------------------------------------------

/** URL de foto de producto cacheable todo el día: con "unique", Odoo la
 * sirve como inmutable y el teléfono no la vuelve a pedir (ni con señal
 * ni sin ella). La marca es la fecha del día. */
export function urlFotoProducto(productId, campo = "image_512") {
    const hoy = new Date();
    const fecha = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
    return `/web/image/product.product/${productId}/${campo}?unique=${fecha}`;
}

function precargarImagen(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = url;
    });
}

/** Descarga las fotos de las tarjetas del catálogo a la caché del
 * navegador (de a pocas a la vez). onProgreso(hechas, total). */
export async function precargarFotos(productos, onProgreso) {
    const ids = productos.map((p) => p.id);
    let hechas = 0;
    let siguiente = 0;
    const trabajador = async () => {
        while (siguiente < ids.length) {
            if (sinConexion()) {
                return;
            }
            const id = ids[siguiente++];
            await precargarImagen(urlFotoProducto(id));
            hechas += 1;
            if (onProgreso) {
                onProgreso(hechas, ids.length);
            }
        }
    };
    await Promise.all(Array.from({length: FOTOS_EN_PARALELO}, trabajador));
    return hechas;
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
    await guardarLocal(`ruta_preparada:${schedule.id}`, Date.now());
}

/** Rutas que "Preparar mi día" descarga: las que el vendedor tomó, las de
 * su cartera con pendientes y las Visitas Exprés. */
export function rutasParaPreparar(schedules) {
    return (schedules || []).filter(
        (s) =>
            s.es_visita_express ||
            (s.tomada_por || []).some((t) => t.es_yo) ||
            (s.tiene_cartera && s.pendientes_mios > 0)
    );
}

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
 * para trabajar sin ella. `opciones.fotos`: también las fotos del
 * catálogo (~25-40 MB: mejor con Wi-Fi). `opciones.schedules`: rutas a
 * preparar (si no, las de rutasParaPreparar). Actualiza estadoOffline.
 */
export async function prepararDia(orm, {fotos = false, schedules = null} = {}) {
    if (estadoOffline.preparando) {
        return;
    }
    if (sinConexion()) {
        throw new SinDatosLocalesError("preparar");
    }
    estadoOffline.preparando = true;
    estadoOffline.progreso = 0;
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
        for (let i = 0; i < elegidas.length; i++) {
            const s = elegidas[i];
            paso(`Ruta ${s.route_name} (${i + 1} de ${elegidas.length})…`, 30 + Math.round((40 * i) / Math.max(1, elegidas.length)));
            await prepararRuta(orm, s);
        }
        const ahora = Date.now();
        estadoOffline.preparadoEn = ahora;
        await guardarLocal("meta:preparado_en", ahora);
        if (fotos) {
            await precargarFotos(catalogo.productos, (hechas, total) =>
                paso(`Fotos del catálogo: ${hechas} de ${total}…`, 70 + Math.round((30 * hechas) / Math.max(1, total)))
            );
            estadoOffline.fotosEn = Date.now();
            await guardarLocal("meta:fotos_en", estadoOffline.fotosEn);
        }
        paso(`Listo: ${elegidas.length} ruta(s) y ${catalogo.productos.length} productos en el teléfono.`, 100);
        return {rutas: elegidas.length, productos: catalogo.productos.length};
    } catch (error) {
        paso("No se pudo terminar de preparar. Probá de nuevo con mejor señal.", estadoOffline.progreso);
        throw error;
    } finally {
        estadoOffline.preparando = false;
    }
}

/** Fechas de la última preparación (para "Datos de hace X"). */
export async function cargarMetaPreparacion() {
    const [preparado, fotos] = await Promise.all([leerLocal("meta:preparado_en"), leerLocal("meta:fotos_en")]);
    estadoOffline.preparadoEn = preparado ? preparado.valor : null;
    estadoOffline.fotosEn = fotos ? fotos.valor : null;
}
