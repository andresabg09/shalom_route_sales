// @web/core/utils/hooks
export function useService(nombre) {
    const s = globalThis.__servicios[nombre];
    if (!s) throw new Error("servicio no simulado: " + nombre);
    return s;
}
