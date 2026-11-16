/** @odoo-module **/

import {reactive} from "@odoo/owl";
import {colaBorrar, colaGuardar, colaListar} from "./almacen_local";
import {conTimeout, esperaConBackoff, sinConexion} from "./red_utils";

/**
 * Cola de salida del teléfono (modo offline, Fase 3).
 *
 * Toda acción importante del vendedor (confirmar pedido, guardar
 * cotización, cambiar estado de la visita, nota, GPS, descartar carrito)
 * se guarda PRIMERO en el teléfono, con un id único (uuid), y después se
 * manda al servidor (shalom.sync.evento.shalom_procesar_lote). Si no hay
 * señal, queda en la cola y se manda sola cuando vuelve: al volver la
 * red, al volver a la app, y cada 30 seg. El servidor procesa cada uuid
 * UNA sola vez, así que reintentar nunca duplica un pedido.
 *
 * - Error de red: la acción queda pendiente; se reintenta con espera
 *   creciente (2 s ... 5 min).
 * - Error de negocio (el servidor la rechazó, ej. falta una nota): queda
 *   como "Necesita atención" con el motivo, visible en el panel de
 *   conexión, hasta que el vendedor la reintente o la descarte. Nunca se
 *   borra sola.
 *
 * `estadoOffline` es reactivo: las pantallas lo leen con useState() para
 * mostrar la pastilla de conexión y las marcas "Pendiente de enviar".
 */

const TAMANO_LOTE = 10;
const TIMEOUT_LOTE_MS = 45000; // un pedido grande puede tardar en confirmarse
const TIMEOUT_PING_MS = 5000;
const INTERVALO_REVISION_MS = 30000;
const BASE_REINTENTO_MS = 2000;
const TOPE_REINTENTO_MS = 5 * 60 * 1000;
const REINTENTO_EN_PROCESO_MS = 5000;

export const estadoOffline = reactive({
    // en_linea | debil | sin_senal
    red: typeof navigator !== "undefined" && navigator.onLine === false ? "sin_senal" : "en_linea",
    cola: [], // acciones pendientes o con error (copias de lo guardado)
    enviando: false,
    ultimoEnvioOk: null,
    panelAbierto: false,
    // "Preparar mi día" (ver datos_offline.js)
    preparando: false,
    progreso: 0,
    mensajePreparar: "",
    preparadoEn: null,
    fotosEn: null,
});

let orm = null;
let notificar = null;
let iniciado = false;
let enCurso = null;
let fallosSeguidos = 0;
let timerReintento = null;
let contadorSeq = 0;
const esperando = new Map(); // uuid -> [resolve]
const oyentes = new Set();

/** Arranca la cola una sola vez por pestaña. `ormCrudo` tiene que ser el
 * servicio orm SIN la protección de componente (env.services.orm): si el
 * componente que la arrancó se desmonta, la cola sigue funcionando. */
export async function iniciarSincronizador(ormCrudo, notificacion) {
    orm = orm || ormCrudo;
    notificar = notificar || notificacion;
    if (iniciado) {
        return;
    }
    iniciado = true;
    estadoOffline.cola = await colaListar();
    window.addEventListener("online", () => {
        fallosSeguidos = 0;
        estadoOffline.red = "en_linea";
        programarEnvio(0);
    });
    window.addEventListener("offline", () => {
        estadoOffline.red = "sin_senal";
    });
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            programarEnvio(0);
        }
    });
    setInterval(() => {
        if (estadoOffline.cola.some((i) => i.estado === "pendiente")) {
            enviarPendientes();
        } else if (estadoOffline.red !== "en_linea" && !document.hidden) {
            comprobarRed();
        }
    }, INTERVALO_REVISION_MS);
    programarEnvio(0);
}

/** El servicio orm que usa la cola (para las lecturas de datos_offline.js). */
export function ormDeLaCola() {
    return orm;
}

export function nuevoUuid() {
    try {
        if (crypto && crypto.randomUUID) {
            return crypto.randomUUID();
        }
    } catch {
        // sin crypto.randomUUID (http sin TLS en pruebas)
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/**
 * Guarda una acción en la cola del teléfono y dispara el envío.
 * `datos` debe llevar order_id (la visita). `etiqueta`: texto para el
 * panel ("Pedido de Farmacia X"). Devuelve el uuid.
 */
export async function encolar(tipo, datos, {etiqueta = ""} = {}) {
    contadorSeq = (contadorSeq + 1) % 1000;
    const item = {
        uuid: nuevoUuid(),
        seq: Date.now() * 1000 + contadorSeq,
        tipo,
        datos,
        etiqueta,
        creado_en: new Date().toISOString(),
        estado: "pendiente",
        intentos: 0,
        error: "",
    };
    await colaGuardar(item);
    estadoOffline.cola.push(item);
    programarEnvio(0);
    return item.uuid;
}

/**
 * Espera el resultado de una acción ya encolada, hasta `timeoutMs`:
 * {estado: "ok", resultado} | {estado: "error", error} | {estado: "pendiente"}.
 * "pendiente" = sin señal o el servidor tarda: la acción SIGUE guardada
 * en la cola y se va a enviar sola.
 */
export function esperarResultado(uuid, timeoutMs = TIMEOUT_LOTE_MS + 5000) {
    return new Promise((resolve) => {
        const lista = esperando.get(uuid) || [];
        let resuelto = false;
        const terminar = (valor) => {
            if (!resuelto) {
                resuelto = true;
                clearTimeout(timer);
                resolve(valor);
            }
        };
        const timer = setTimeout(() => terminar({estado: "pendiente"}), timeoutMs);
        lista.push(terminar);
        esperando.set(uuid, lista);
        enviarPendientes();
    });
}

function resolverEspera(uuid, valor) {
    const lista = esperando.get(uuid);
    if (lista) {
        esperando.delete(uuid);
        for (const terminar of lista) {
            terminar(valor);
        }
    }
}

/** Avisos a las pantallas cuando una acción terminó (ok o error). */
export function alTerminarEnvio(callback) {
    oyentes.add(callback);
    return () => oyentes.delete(callback);
}

function avisarOyentes(item, respuesta) {
    for (const oyente of oyentes) {
        try {
            oyente(item, respuesta);
        } catch {
            // un oyente roto no frena la cola
        }
    }
}

function programarEnvio(ms) {
    clearTimeout(timerReintento);
    timerReintento = setTimeout(() => enviarPendientes(), ms);
}

function esperaSinRespuesta(itemsDelLote) {
    for (const item of itemsDelLote) {
        resolverEspera(item.uuid, {estado: "pendiente"});
    }
}

/** Manda lo pendiente (de a TAMANO_LOTE, en orden). Nunca corre dos veces
 * a la vez: si ya hay un envío en curso, devuelve ese. */
export function enviarPendientes() {
    if (enCurso) {
        return enCurso;
    }
    enCurso = (async () => {
        try {
            for (;;) {
                const pendientes = estadoOffline.cola.filter((i) => i.estado === "pendiente");
                if (!pendientes.length) {
                    return;
                }
                if (!orm || sinConexion()) {
                    if (sinConexion()) {
                        estadoOffline.red = "sin_senal";
                    }
                    esperaSinRespuesta(pendientes);
                    return;
                }
                const lote = pendientes.slice(0, TAMANO_LOTE);
                estadoOffline.enviando = true;
                let respuestas;
                try {
                    respuestas = await conTimeout(
                        orm.call("shalom.sync.evento", "shalom_procesar_lote", [
                            lote.map((i) => ({uuid: i.uuid, tipo: i.tipo, datos: i.datos, creado_en: i.creado_en})),
                        ]),
                        TIMEOUT_LOTE_MS
                    );
                } catch (error) {
                    fallosSeguidos += 1;
                    marcarRed(false);
                    esperaSinRespuesta(pendientes);
                    programarEnvio(esperaConBackoff(BASE_REINTENTO_MS, fallosSeguidos, TOPE_REINTENTO_MS));
                    return;
                } finally {
                    estadoOffline.enviando = false;
                }
                fallosSeguidos = 0;
                marcarRed(true);
                estadoOffline.ultimoEnvioOk = Date.now();
                let hayEnProceso = false;
                for (const respuesta of respuestas || []) {
                    const item = estadoOffline.cola.find((i) => i.uuid === respuesta.uuid);
                    if (!item) {
                        continue;
                    }
                    if (respuesta.estado === "ok") {
                        await colaBorrar(item.uuid);
                        estadoOffline.cola = estadoOffline.cola.filter((i) => i.uuid !== item.uuid);
                        resolverEspera(item.uuid, {estado: "ok", resultado: respuesta.resultado || {}});
                        avisarOyentes(item, respuesta);
                    } else if (respuesta.estado === "error") {
                        item.estado = "error";
                        item.error = respuesta.error || "El servidor rechazó esta acción.";
                        item.intentos = (item.intentos || 0) + 1;
                        await colaGuardar({...item});
                        resolverEspera(item.uuid, {estado: "error", error: item.error});
                        avisarOyentes(item, respuesta);
                    } else {
                        hayEnProceso = true;
                    }
                }
                if (hayEnProceso) {
                    esperaSinRespuesta(lote.filter((i) => i.estado === "pendiente"));
                    programarEnvio(REINTENTO_EN_PROCESO_MS);
                    return;
                }
            }
        } finally {
            enCurso = null;
        }
    })();
    return enCurso;
}

/** Botón "Reintentar" de una acción con error. */
export async function reintentar(uuid) {
    const item = estadoOffline.cola.find((i) => i.uuid === uuid);
    if (!item) {
        return;
    }
    item.estado = "pendiente";
    item.error = "";
    await colaGuardar({...item});
    fallosSeguidos = 0;
    return enviarPendientes();
}

/** Botón "Descartar" de una acción con error (con confirmación en la UI). */
export async function descartar(uuid) {
    await colaBorrar(uuid);
    estadoOffline.cola = estadoOffline.cola.filter((i) => i.uuid !== uuid);
    resolverEspera(uuid, {estado: "error", error: "Descartada por el vendedor."});
}

/** Lo que el teléfono todavía no pudo entregar para esta visita. */
export function pendientesDeVisita(orderId) {
    return estadoOffline.cola.filter((i) => i.datos && i.datos.order_id === orderId);
}

/**
 * Estado de la visita "según el teléfono": si hay un pedido o un cambio
 * de estado esperando a enviarse, la visita se muestra con ese estado
 * (no con el viejo del servidor) y marcada "Pendiente de enviar".
 * Devuelve null si no hay nada pendiente para esta visita.
 */
export function estadoLocalDeVisita(orderId) {
    const items = pendientesDeVisita(orderId);
    if (!items.length) {
        return null;
    }
    // El estado "según el teléfono" sale solo de lo que todavía espera
    // enviarse: lo que el servidor rechazó no pasó, solo se avisa.
    let estado = null;
    let pedidoPendiente = false;
    for (const item of items) {
        if (item.estado !== "pendiente") {
            continue;
        }
        if (item.tipo === "confirmar_pedido" || item.tipo === "guardar_borrador") {
            pedidoPendiente = true;
            estado = "completado";
        } else if (item.tipo === "cambiar_etapa" && item.datos.estado_app) {
            estado = item.datos.estado_app;
        }
    }
    const conError = items.filter((i) => i.estado === "error");
    return {
        estado,
        pedidoPendiente,
        porEnviar: items.some((i) => i.estado === "pendiente"),
        conError: conError.length > 0,
        error: conError.length ? conError[conError.length - 1].error : "",
        items,
    };
}

/** Lo usan las lecturas con respaldo (datos_offline.js): cada respuesta
 * buena o fallida ajusta la pastilla de conexión. */
export function marcarRed(ok) {
    if (ok) {
        estadoOffline.red = "en_linea";
        return;
    }
    estadoOffline.red = sinConexion() ? "sin_senal" : "debil";
}

/** Latido real al servidor (no basta con navigator.onLine). */
export async function comprobarRed() {
    if (!orm || sinConexion()) {
        marcarRed(false);
        return false;
    }
    try {
        await conTimeout(orm.call("shalom.sync.evento", "shalom_ping", []), TIMEOUT_PING_MS);
        const venia = estadoOffline.red;
        marcarRed(true);
        if (venia !== "en_linea") {
            programarEnvio(0);
        }
        return true;
    } catch {
        marcarRed(false);
        return false;
    }
}

/** Notificación de la app (la que pasó iniciarSincronizador). */
export function avisar(mensaje, tipo = "info") {
    if (notificar) {
        notificar.add(mensaje, {type: tipo});
    }
}

/** Solo para pruebas. */
export function _reiniciarSincronizadorParaPruebas() {
    orm = null;
    notificar = null;
    iniciado = false;
    enCurso = null;
    fallosSeguidos = 0;
    clearTimeout(timerReintento);
    esperando.clear();
    oyentes.clear();
    estadoOffline.cola = [];
    estadoOffline.red = "en_linea";
}
