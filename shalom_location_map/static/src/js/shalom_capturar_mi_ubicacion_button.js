/** @odoo-module **/

import { registry } from "@web/core/registry";

/**
 * Acción cliente disparada por el botón "Capturar mi ubicación" del
 * wizard "Buscar GPS por nombre" (shalom.buscar.gps.wizard).
 *
 * A diferencia de shalom_capturar_gps (fsm_order_gps_button.js), acá NO
 * se pide confirmación: esta ubicación es de solo lectura, nunca se
 * escribe en ningún cliente -- solo se usa para calcular a cuántos km
 * está cada opción de Google que se muestre en el popup de búsqueda.
 */
async function shalomCapturarMiUbicacion(env, action) {
    const { wizard_id: wizardId } = action.params;

    if (!navigator.geolocation) {
        env.services.notification.add(
            "Este navegador no soporta geolocalización.",
            { type: "danger" }
        );
        return;
    }

    return new Promise((resolvePromise) => {
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const { latitude, longitude } = position.coords;
                try {
                    await env.services.orm.call(
                        "shalom.buscar.gps.wizard",
                        "action_guardar_mi_ubicacion",
                        [[wizardId], latitude, longitude]
                    );
                    env.services.notification.add(
                        "Tu ubicación quedó guardada para calcular distancias.",
                        { type: "success" }
                    );
                    if (env.services.action && env.services.action.currentController) {
                        env.services.action.currentController.reload?.();
                    }
                } catch (error) {
                    env.services.notification.add(
                        "Ocurrió un error al guardar tu ubicación. Intentá de nuevo.",
                        { type: "danger" }
                    );
                }
                resolvePromise();
            },
            () => {
                env.services.notification.add(
                    "No se pudo obtener tu ubicación. Verificá que el " +
                    "navegador tenga permiso de ubicación activado.",
                    { type: "danger" }
                );
                resolvePromise();
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    });
}

registry.category("actions").add("shalom_capturar_mi_ubicacion", shalomCapturarMiUbicacion);
