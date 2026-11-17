/** @odoo-module **/

/** Texto para comparar en los buscadores: sin tildes ni mayúsculas
 * ("José Pérez" -> "jose perez"). Pedido explícito: escribir "jose",
 * "JOSÉ" o "Jose" tiene que encontrar igual a "José". La ñ también
 * coincide con n (como en Google). */
export function normalizarBusqueda(texto) {
    return String(texto || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

/** ¿`texto` contiene la `consulta`? (sin tildes ni mayúsculas) */
export function coincideBusqueda(texto, consulta) {
    return normalizarBusqueda(texto).includes(normalizarBusqueda(consulta).trim());
}

/** Parte un texto en antes / coincidencia / después (sin distinguir
 * mayúsculas ni tildes) para resaltar lo que el vendedor escribió. */
export function resaltar(texto, consulta) {
    const t = texto || "";
    const q = normalizarBusqueda(consulta).trim();
    if (!q) {
        return {pre: t, hit: "", post: ""};
    }
    // Texto normalizado + de qué letra del original sale cada letra, para
    // resaltar el pedazo ORIGINAL (con sus tildes).
    let norm = "";
    const origen = [];
    for (let i = 0; i < t.length; i++) {
        for (const letra of normalizarBusqueda(t[i])) {
            norm += letra;
            origen.push(i);
        }
    }
    const k = norm.indexOf(q);
    if (k < 0) {
        return {pre: t, hit: "", post: ""};
    }
    const desde = origen[k];
    const hasta = k + q.length < origen.length ? origen[k + q.length] : t.length;
    return {pre: t.slice(0, desde), hit: t.slice(desde, hasta), post: t.slice(hasta)};
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
