/** @odoo-module **/

/**
 * Los diccionarios de acción devueltos por métodos Python del backend
 * (ej. action_crear_cotizacion, shalom_guardar_borrador_pedido) traen
 * view_mode como string ("form" o "list,form") -- eso alcanza cuando la
 * acción la dispara un botón nativo del formulario (Odoo completa el
 * campo "views" solo), pero action.doAction() llamado directo desde JS
 * necesita "views" ya armado como lista de [id, tipo], si no revienta
 * con "Cannot read properties of undefined (reading 'map')".
 */
export function normalizarAccionActWindow(resultado) {
    if (!resultado || resultado.views) {
        return resultado;
    }
    return {
        ...resultado,
        views: (resultado.view_mode || "form")
            .split(",")
            .map((modo) => [false, modo.trim()]),
    };
}
