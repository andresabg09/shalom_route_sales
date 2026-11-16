/** @odoo-module **/

import {user} from "@web/core/user";

/**
 * Almacén local del teléfono (modo offline, Fase 2): IndexedDB, una base
 * por usuario de Odoo (si dos vendedores usan el mismo teléfono, sus
 * datos no se mezclan). Mismo enfoque que el Punto de Venta de Odoo 18
 * (un envoltorio propio de IndexedDB, sin librerías).
 *
 * Dos almacenes:
 * - "kv":   datos descargados para trabajar sin señal (rutas, visitas,
 *           catálogo, pedidos anteriores...), como {clave, valor, ts}.
 * - "cola": acciones del vendedor esperando a ser enviadas (ver
 *           sincronizador.js), como {uuid, seq, tipo, datos, ...}.
 *
 * TODO es a prueba de fallos: si IndexedDB no está disponible (modo
 * privado, navegador viejo, cuota llena) se usa memoria y la app sigue
 * funcionando como antes, solo que sin sobrevivir a una recarga. Nunca
 * se lanza un error hacia la pantalla.
 */

const VERSION_DB = 1;

/** Copia plana: IndexedDB no puede guardar los Proxy reactivos de Owl
 * (DataCloneError), y así lo guardado nunca cambia por detrás. */
function clonar(valor) {
    return valor === undefined ? null : JSON.parse(JSON.stringify(valor));
}
const memoria = {kv: new Map(), cola: new Map()};
let promesaDb = null;
let sinIndexedDb = false;

function nombreDb() {
    let uid = "anon";
    try {
        uid = user.userId || "anon";
    } catch {
        // sin usuario: base genérica
    }
    return `shalom_offline_${uid}`;
}

function abrir() {
    if (sinIndexedDb || typeof indexedDB === "undefined") {
        sinIndexedDb = true;
        return Promise.resolve(null);
    }
    if (promesaDb) {
        return promesaDb;
    }
    promesaDb = new Promise((resolve) => {
        let peticion;
        try {
            peticion = indexedDB.open(nombreDb(), VERSION_DB);
        } catch {
            sinIndexedDb = true;
            resolve(null);
            return;
        }
        peticion.onupgradeneeded = () => {
            const db = peticion.result;
            if (!db.objectStoreNames.contains("kv")) {
                db.createObjectStore("kv", {keyPath: "clave"});
            }
            if (!db.objectStoreNames.contains("cola")) {
                db.createObjectStore("cola", {keyPath: "uuid"});
            }
        };
        peticion.onsuccess = () => {
            const db = peticion.result;
            // Si el navegador cierra la conexión (pasa en iOS al volver de
            // segundo plano: "Connection to Indexed Database server lost"),
            // la próxima operación vuelve a abrirla.
            db.onclose = () => {
                promesaDb = null;
            };
            db.onversionchange = () => {
                db.close();
                promesaDb = null;
            };
            resolve(db);
        };
        peticion.onerror = () => {
            sinIndexedDb = true;
            resolve(null);
        };
        peticion.onblocked = () => resolve(null);
    });
    return promesaDb;
}

/** Corre `fn(store)` en una transacción; devuelve lo que resuelva la
 * petición que devuelva `fn` (o undefined). Si algo falla, reintenta UNA
 * vez reabriendo la base (conexión perdida en iOS) y si no, usa memoria. */
async function operar(nombreStore, modo, fn, respaldo) {
    for (let intento = 0; intento < 2; intento++) {
        const db = await abrir();
        if (!db) {
            return respaldo();
        }
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(nombreStore, modo);
                const peticion = fn(tx.objectStore(nombreStore));
                let resultado;
                if (peticion) {
                    peticion.onsuccess = () => {
                        resultado = peticion.result;
                    };
                }
                tx.oncomplete = () => resolve(resultado);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } catch {
            promesaDb = null;
        }
    }
    return respaldo();
}

// ------------------------------------------------------------------
// Datos descargados ("kv")
// ------------------------------------------------------------------

/** {valor, ts} guardado bajo `clave`, o null si no hay nada. */
export async function leerLocal(clave) {
    const fila = await operar("kv", "readonly", (s) => s.get(clave), () => memoria.kv.get(clave));
    return fila ? {valor: fila.valor, ts: fila.ts} : null;
}

export async function guardarLocal(clave, valor) {
    const fila = {clave, valor: clonar(valor), ts: Date.now()};
    memoria.kv.set(clave, fila);
    await operar("kv", "readwrite", (s) => s.put(fila), () => undefined);
}

export async function borrarLocal(clave) {
    memoria.kv.delete(clave);
    await operar("kv", "readwrite", (s) => s.delete(clave), () => undefined);
}

// ------------------------------------------------------------------
// Cola de salida ("cola")
// ------------------------------------------------------------------

export async function colaListar() {
    const filas = await operar("cola", "readonly", (s) => s.getAll(), () => [...memoria.cola.values()]);
    return (filas || []).sort((a, b) => a.seq - b.seq);
}

export async function colaGuardar(item) {
    const copia = clonar(item);
    memoria.cola.set(copia.uuid, copia);
    await operar("cola", "readwrite", (s) => s.put(copia), () => undefined);
}

export async function colaBorrar(uuid) {
    memoria.cola.delete(uuid);
    await operar("cola", "readwrite", (s) => s.delete(uuid), () => undefined);
}

/** Pide al navegador que no borre estos datos si le falta espacio
 * (Chrome lo concede a apps instaladas/usadas seguido). Best-effort. */
export async function pedirAlmacenamientoPersistente() {
    try {
        if (navigator.storage && navigator.storage.persist) {
            if (await navigator.storage.persisted()) {
                return true;
            }
            return await navigator.storage.persist();
        }
    } catch {
        // sin API: nada que hacer
    }
    return false;
}

/** Solo para pruebas: vacía la memoria y olvida la conexión. */
export function _reiniciarAlmacenParaPruebas() {
    memoria.kv.clear();
    memoria.cola.clear();
    promesaDb = null;
}
