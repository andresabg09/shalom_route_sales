/** @odoo-module **/

/**
 * Traduce entre el estado interno de la app ("pendiente", "completado",
 * "no_quiso", "cancelado") y las etapas reales de fsm.stage
 * (stage_type="order") de esta instalación. Nunca asume IDs fijos: los
 * resuelve por nombre de etapa -- mismo criterio que ya usan
 * fsm_order_kanban.xml y fsm_route_schedule_views.xml con
 * decoration-* sobre stage_name -- y los cachea en memoria porque las
 * etapas no cambian durante una sesión del navegador.
 */

export const ESTADO_ETIQUETA = {
    pendiente: "Pendiente",
    completado: "Completada",
    no_quiso: "No quiso",
    cancelado: "Cancelado",
};

const NOMBRE_A_ESTADO = {
    Completado: "completado",
    Cancelado: "cancelado",
    "No quiso": "no_quiso",
};

export function estadoDesdeStageName(stageName) {
    return NOMBRE_A_ESTADO[stageName] || "pendiente";
}

let idsEtapasCache = null;

/**
 * Devuelve {pendiente, completado, no_quiso, cancelado} -> id de
 * fsm.stage. Se resuelve una sola vez por sesión del navegador
 * (búsqueda liviana, 4 registros) y se reusa desde ahí.
 */
export async function obtenerIdsEtapas(orm) {
    if (idsEtapasCache) {
        return idsEtapasCache;
    }
    const etapas = await orm.searchRead(
        "fsm.stage",
        [["stage_type", "=", "order"]],
        ["name"]
    );
    const ids = {pendiente: null, completado: null, no_quiso: null, cancelado: null};
    for (const etapa of etapas) {
        const clave = NOMBRE_A_ESTADO[etapa.name] || "pendiente";
        if (!ids[clave]) {
            ids[clave] = etapa.id;
        }
    }
    idsEtapasCache = ids;
    return ids;
}
