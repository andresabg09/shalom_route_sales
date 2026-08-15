/** @odoo-module **/

import { registry } from "@web/core/registry";

/**
 * Acción cliente disparada por el botón "Capturar mi ubicación GPS" en
 * el formulario de fsm.order.
 *
 * Flujo:
 *   1. Pide confirmación explícita al usuario (window.confirm nativo),
 *      dejando claro que esto va a sobreescribir la ubicación del cliente.
 *   2. Si confirma, pide el GPS real del dispositivo via
 *      navigator.geolocation.getCurrentPosition.
 *   3. Llama al método action_capturar_gps del backend con lat/lng reales.
 *   4. Recarga la vista para reflejar los nuevos valores.
 *
 * Separado intencionalmente del botón de "marcar visita como completada"
 * para que un vendedor no pueda alterar la ubicación de un cliente sin
 * darse cuenta de las consecuencias.
 */
async function shalomCapturarGps(env, action) {
    const { order_id: orderId, cliente_nombre: clienteNombre } = action.params;

    return new Promise((resolvePromise) => {
        const mensaje =
            `Vas a actualizar la ubicación GPS de "${clienteNombre}" ` +
            `con tu posición actual.\n\n` +
            `Esto reemplaza la ubicación guardada del cliente. ` +
            `Solo hacé esto si estás físicamente en el local ahora mismo.\n\n` +
            `¿Confirmás que querés continuar?`;

        // eslint-disable-next-line no-alert
        const acepta = window.confirm(mensaje);

        if (!acepta) {
            env.services.notification.add(
                "Captura de GPS cancelada. No se modificó nada.",
                { type: "warning" }
            );
            resolvePromise();
            return;
        }

        if (!navigator.geolocation) {
            env.services.notification.add(
                "Este navegador no soporta geolocalización.",
                { type: "danger" }
            );
            resolvePromise();
            return;
        }

        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const { latitude, longitude } = position.coords;
                try {
                    await env.services.orm.call(
                        "fsm.order",
                        "action_capturar_gps",
                        [[orderId], latitude, longitude]
                    );
                    env.services.notification.add(
                        `Ubicación GPS capturada correctamente ` +
                        `(lat: ${latitude.toFixed(6)}, lng: ${longitude.toFixed(6)}).`,
                        { type: "success" }
                    );
                    if (env.services.action && env.services.action.currentController) {
                        env.services.action.currentController.reload?.();
                    } else {
                        window.location.reload();
                    }
                } catch (error) {
                    env.services.notification.add(
                        "Ocurrió un error al guardar la ubicación GPS. " +
                        "Intentá de nuevo.",
                        { type: "danger" }
                    );
                }
                resolvePromise();
            },
            (error) => {
                env.services.notification.add(
                    "No se pudo obtener tu ubicación GPS. Verificá que " +
                    "el navegador tenga permiso de ubicación activado.",
                    { type: "danger" }
                );
                resolvePromise();
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    });
}

registry.category("actions").add("shalom_capturar_gps", shalomCapturarGps);
