/** @odoo-module **/

/** Parte un texto en antes / coincidencia / después (sin distinguir mayúsculas)
 * para resaltar lo que el vendedor escribió. */
export function resaltar(texto, consulta) {
    const t = texto || "";
    const q = (consulta || "").trim().toLowerCase();
    const i = q ? t.toLowerCase().indexOf(q) : -1;
    if (i < 0) {
        return {pre: t, hit: "", post: ""};
    }
    return {pre: t.slice(0, i), hit: t.slice(i, i + q.length), post: t.slice(i + q.length)};
}

/** Qué decir del cliente encontrado: {texto, tono} con tono pendiente / completado / info. */
export function estadoDeResultado(r) {
    if (!r.schedule) {
        return {texto: "Sin ciclo activo", tono: "info"};
    }
    if (r.cerrada) {
        if (r.atendido_por) {
            return {
                texto: `Atendido por ${r.atendido_por.split(" ")[0]}${r.atendido_hoy ? " hoy" : ""}`,
                tono: "completado",
            };
        }
        return {texto: r.stage_name || "Atendido", tono: "completado"};
    }
    return {texto: "Pendiente este ciclo", tono: "pendiente"};
}

/** "Luis" / "Luis y Milciades": quién atiende la ruta, sin contarme a mí. */
export function quienAtiende(tomadaPor) {
    const otros = (tomadaPor || []).filter((t) => !t.es_yo).map((t) => t.nombre.split(" ")[0]);
    return otros.join(" y ");
}
