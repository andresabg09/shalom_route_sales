/** @odoo-module **/

import {leerLocal} from "./almacen_local";
import {descartar, encolar, esperarResultado, estadoOffline} from "./sincronizador";

/**
 * Clientes creados y editados SIN SEÑAL (pedido explícito: "crear, editar y
 * hacerle pedido al cliente creado, todo en modo offline").
 *
 * - Crear: el teléfono le da al cliente y a su visita ids NEGATIVOS
 *   provisorios y guarda el alta en la cola (evento crear_cliente). Todo lo
 *   que se haga después con ese cliente (pedido, estado, nota, edición) va
 *   en la misma cola, DETRÁS del alta, con esos ids: el servidor los cambia
 *   por los reales (shalom.sync.evento._shalom_resolver_temporales).
 * - Mientras el alta espera, el cliente se muestra igual: como parada nueva
 *   de su ruta, en "Clientes" y con su hoja de visita. Esa "capa local" sale
 *   directo de la cola (no hay otra copia que mantener) y desaparece sola
 *   cuando el alta se envía.
 * - Editar: va por la cola (evento editar_cliente); lo editado se ve al
 *   instante en el teléfono (aplicarEdiciones).
 */

export const ESPERA_CLIENTE_MS = 8000;

export function esProvisorio(id) {
    return typeof id === "number" && id < 0;
}

export function idProvisorio() {
    return -(Math.floor(Math.random() * 2000000000) + 1);
}

/** Altas de clientes que todavía están en la cola (pendientes o con error). */
export function altasEnCola() {
    return estadoOffline.cola.filter((i) => i.tipo === "crear_cliente" && i.datos);
}

function altaDeVisita(orderId) {
    return altasEnCola().find((i) => i.datos.tmp_order_id === orderId) || null;
}

function altaDeCliente(locationId) {
    return altasEnCola().find((i) => i.datos.tmp_location_id === locationId) || null;
}

/** Ediciones de este cliente que todavía no llegaron al servidor. */
export function edicionesPendientes(locationId) {
    return estadoOffline.cola.filter(
        (i) => i.tipo === "editar_cliente" && i.estado === "pendiente" && i.datos && i.datos.location_id === locationId
    );
}

/** Lo editado sin señal, encima de lo que se sabía del cliente. */
export function aplicarEdiciones(locationId, base) {
    const ficha = {...base};
    for (const item of edicionesPendientes(locationId)) {
        const v = item.datos.valores || {};
        for (const campo of ["name", "phone", "street", "street2", "vat", "mobile", "email"]) {
            if (campo in v) {
                ficha[campo] = v[campo] || "";
            }
        }
        if ("nombre_contacto" in v) {
            ficha.x_nombre_contacto = v.nombre_contacto || "";
        }
        if ("lat" in v || "lng" in v) {
            ficha.partner_latitude = v.lat || false;
            ficha.partner_longitude = v.lng || false;
        }
        if ("es_distribuidora" in v) {
            ficha.x_es_distribuidora = !!v.es_distribuidora;
        }
        if (v.posicion) {
            ficha.fsm_route_id = v.posicion.route_id ? [v.posicion.route_id, v.posicion.route_name || ""] : false;
        }
    }
    return ficha;
}

/** Ficha (misma forma que fsm.location.shalom_fichas_cliente_form) de un
 * cliente creado sin señal. */
function fichaDeAlta(item) {
    const d = item.datos;
    return aplicarEdiciones(d.tmp_location_id, {
        id: d.tmp_location_id,
        name: d.name || "",
        phone: d.phone || "",
        street: d.street || "",
        street2: d.street2 || "",
        fsm_route_id: d.route_id ? [d.route_id, d.route_name || ""] : false,
        partner_latitude: d.lat || false,
        partner_longitude: d.lng || false,
        x_es_distribuidora: false,
        partner_id: false,
        vat: d.vat || "",
        mobile: d.mobile || "",
        email: d.email || "",
        x_nombre_contacto: d.nombre_contacto || "",
        tiene_foto: !!d.image_1920,
        provisorio: true,
    });
}

export function fichaProvisoria(locationId) {
    const item = altaDeCliente(locationId);
    return item ? fichaDeAlta(item) : null;
}

/** Datos de la visita (misma forma que traerVisita) de un cliente nuevo. */
export function visitaProvisoria(orderId) {
    const item = altaDeVisita(orderId);
    if (!item) {
        return null;
    }
    const d = item.datos;
    const f = fichaDeAlta(item);
    return {
        orden: {
            id: orderId,
            location_id: [d.tmp_location_id, f.name],
            x_cliente_orden_ruta: d.parada_local || 0,
            stage_name: "",
            x_observaciones_visita: "",
            x_cliente_lat: f.partner_latitude || false,
            x_cliente_lng: f.partner_longitude || false,
            sale_id: false,
        },
        locacion: {
            id: d.tmp_location_id,
            name: f.name,
            phone: f.phone,
            mobile: f.mobile,
            street: f.street,
            street2: f.street2,
            partner_id: false,
        },
        datosFaltantes: [],
        provisoria: true,
    };
}

/** Paradas nuevas (sin enviar) de un ciclo, para la lista de la ruta. */
export function visitasProvisoriasDeCiclo(scheduleId) {
    return altasEnCola()
        .filter((i) => i.datos.schedule_id_local === scheduleId && i.datos.tmp_order_id)
        .map((i) => visitaProvisoria(i.datos.tmp_order_id))
        .filter(Boolean);
}

/** Clientes nuevos (sin enviar), con la forma de shalom_mis_clientes. */
export function clientesProvisorios() {
    return altasEnCola().map((item) => {
        const f = fichaDeAlta(item);
        return {
            id: f.id,
            name: f.name,
            phone: f.phone,
            street: f.street,
            street2: f.street2,
            partner_id: false,
            x_orden_ruta: item.datos.parada_local || 0,
            fsm_route_id: item.datos.route_id || false,
            fsm_route_name: item.datos.route_name || "",
            vat: f.vat,
            mobile: f.mobile,
            email: f.email,
            provisorio: true,
            sinEnviar: true,
        };
    });
}

/** Ciclo de la ruta que se está usando ahora, según lo guardado en el
 * teléfono: misma regla que el servidor (fsm.location._shalom_ocurrencia_
 * activa): en curso o por iniciar, el de fecha de inicio más nueva. */
export function ocurrenciaActivaLocal(rutas, routeId) {
    const candidatos = (rutas || []).filter(
        (s) => s.route_id === routeId && ["en_curso", "por_iniciar"].includes(s.estado)
    );
    candidatos.sort((a, b) => String(b.date_start || "").localeCompare(String(a.date_start || "")));
    return candidatos[0] || null;
}

export async function rutasGuardadas() {
    const local = await leerLocal("rutas");
    return (local && local.valor) || [];
}

/**
 * Alta de cliente (con o sin señal). `campos`: name, phone, street,
 * street2, vat, mobile, email, nombre_contacto, image_1920, lat, lng,
 * route_id, route_name, cliente_anterior_id, parada_local.
 * Devuelve {estado: "ok" | "pendiente" | "error", locationId, orderId,
 * schedule, error}. Con señal, ids reales; sin señal, provisorios.
 */
export async function crearCliente(campos) {
    const tmpLocation = idProvisorio();
    const tmpOrder = idProvisorio();
    const ciclo = ocurrenciaActivaLocal(await rutasGuardadas(), campos.route_id);
    const uuid = await encolar(
        "crear_cliente",
        {
            ...campos,
            tmp_location_id: tmpLocation,
            tmp_order_id: tmpOrder,
            schedule_id_local: ciclo ? ciclo.id : false,
        },
        {etiqueta: campos.name, resumen: {cliente: campos.name, detalle: "Cliente nuevo"}}
    );
    const respuesta = await esperarResultado(uuid, ESPERA_CLIENTE_MS);
    if (respuesta.estado === "error") {
        // Rechazado con señal (ej. datos inválidos): se avisa acá mismo,
        // no queda en la cola.
        await descartar(uuid);
        return {estado: "error", error: respuesta.error};
    }
    if (respuesta.estado === "ok") {
        const r = respuesta.resultado || {};
        const rutas = await rutasGuardadas();
        return {
            estado: "ok",
            locationId: r.location_id,
            orderId: r.order_id || false,
            parada: r.parada || 0,
            schedule: rutas.find((s) => s.id === r.schedule_id) || (ciclo && ciclo.id === r.schedule_id ? ciclo : null),
            uuid,
        };
    }
    return {
        estado: "pendiente",
        locationId: tmpLocation,
        orderId: ciclo ? tmpOrder : false,
        parada: campos.parada_local || 0,
        schedule: ciclo,
        uuid,
    };
}

/** Edición de cliente (con o sin señal): {estado, error}. */
export async function editarCliente(locationId, valores, etiqueta) {
    const uuid = await encolar(
        "editar_cliente",
        {location_id: locationId, valores},
        {etiqueta, resumen: {cliente: etiqueta, detalle: "Datos del cliente"}}
    );
    const respuesta = await esperarResultado(uuid, ESPERA_CLIENTE_MS);
    if (respuesta.estado === "error") {
        await descartar(uuid);
        return {estado: "error", error: respuesta.error};
    }
    return {estado: respuesta.estado};
}

/** GPS del cliente (botón "Registrar coordenadas" al editar). */
export async function gpsCliente(locationId, lat, lng, etiqueta) {
    const uuid = await encolar("gps_cliente", {location_id: locationId, lat, lng}, {etiqueta, resumen: {cliente: etiqueta, detalle: "GPS"}});
    const respuesta = await esperarResultado(uuid, ESPERA_CLIENTE_MS);
    if (respuesta.estado === "error") {
        await descartar(uuid);
    }
    return respuesta;
}

/** Achica la foto del local antes de guardarla (1280 px, JPEG 80 %): pesa
 * mucho menos en datos móviles y en la cola. Si el navegador no puede, la
 * original. Devuelve {dataUrl, base64}. */
export async function achicarFoto(dataUrl, lado = 1280, calidad = 0.8) {
    try {
        const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = reject;
            i.src = dataUrl;
        });
        const escala = Math.min(1, lado / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const lienzo = document.createElement("canvas");
        lienzo.width = Math.max(1, Math.round(img.naturalWidth * escala));
        lienzo.height = Math.max(1, Math.round(img.naturalHeight * escala));
        const ctx = lienzo.getContext && lienzo.getContext("2d");
        if (!ctx) {
            throw new Error("sin canvas");
        }
        ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
        const chica = lienzo.toDataURL("image/jpeg", calidad);
        if (!chica || !chica.startsWith("data:image/jpeg")) {
            throw new Error("sin jpeg");
        }
        return {dataUrl: chica, base64: chica.split(",")[1] || false};
    } catch {
        return {dataUrl, base64: dataUrl.split(",")[1] || false};
    }
}
