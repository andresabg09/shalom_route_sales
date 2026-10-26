/*
 * Escenarios de la Fase 7 (pestaña "Gerente" de Administración):
 * mes en curso, reparto de rutas con "Pasar a…", salud de los datos y GPS
 * prioritario, y que una llamada que falla no tumba el resto de Administración.
 *
 * Formato: ver "Escenarios en archivos aparte" al final de simular.js.
 */
module.exports = (ctx) => {
    const {escenarios, bundle, montar, ok, q, qa, click, texto, esperar, sleep, window} = ctx;

    // ---------- datos sintéticos ----------
    const MES = {
        mes: "2026-10-01", hasta: "2026-11-01", pedidos: 12, ventas: 41900, utilidad: 8463.8, costo: 33436.2,
        margen_pct: 20.2, margen_anio_pct: 21.2, piso: 60000, meta: 80000,
        pct_piso: 69.8, pct_meta: 52.4, falta_piso: 18100, falta_meta: 38100,
        oxigenta: {tintes: 300, oxigenta: 48, por_100: 16, pedidos_con_oxigenta: 5, por_100_en_pedidos_con_oxigenta: 33},
        vendedores: [
            {persona_id: 9, persona_nombre: "Andrés", pedidos: 7, ventas: 25000, estrellas: 20, oro: 6, xp: 2300},
            {persona_id: 10, persona_nombre: "Luis", pedidos: 5, ventas: 16900, estrellas: 11, oro: 3, xp: 1700},
        ],
        equipo: {pedidos: 12, estrellas: 31, oro: 9, xp: 4000},
    };
    const ruta = (id, name, valor, clientes, persona) => ({
        id, name, valor, clientes, dias: Math.round(valor / 200) / 10, dias_ciclo: 7,
        persona_id: persona ? persona[0] : false, persona_nombre: persona ? persona[1] : "",
    });
    const repartoBase = () => ({
        vendedores: [
            {persona_id: 9, persona_nombre: "Andrés", valor_mes: 25300, dias: 12.7, clientes: 60, dias_ciclo: 14,
                rutas: [ruta(1, "Darién", 6127, 5, [9, "Andrés"]), ruta(2, "Colón", 19173, 55, [9, "Andrés"])]},
            {persona_id: 10, persona_nombre: "Luis", valor_mes: 27100, dias: 13.6, clientes: 70, dias_ciclo: 7,
                rutas: [ruta(3, "Chorrera", 27100, 70, [10, "Luis"])]},
        ],
        sin_dueno_o_ventas: [
            {...ruta(4, "Ruta huérfana", 800, 2, null), motivo: "sin_dueno"},
            {...ruta(5, "Ruta sin ventas", 0, 0, [10, "Luis"]), motivo: "sin_ventas"},
        ],
        total_mes: 52400,
        sin_ruta: {clientes: 28, valor: 7600, top: [{id: 90, name: "Farmacia Yeny", clase: "A", valor: 1515}]},
        personas: [{id: 9, name: "Andrés"}, {id: 10, name: "Luis"}, {id: 11, name: "Milciades"}],
        por_dia: 2000,
    });
    const saludBase = () => {
        const filas = [];
        for (let i = 0; i < 35; i++) {
            filas.push({
                id: 100 + i, name: `Cliente ${i + 1}`, ruta_id: i % 3 === 0 ? false : 1, ruta: i % 3 === 0 ? "" : "Darién",
                clase: i % 2 ? "A2" : "A", valor: 1600 - i * 40, sin_ruta: i % 3 === 0,
            });
        }
        return {
            total_ubicaciones: 1086, sin_gps: 502, sin_tipo: 1086, sin_telefono: 40,
            buenos: {total: 193, con_gps: 158, sin_gps: 35, valor_sin_gps: 30000},
            gps_n: 30, gps_cobertura_pct: 70.4, gps_prioritario: filas,
            buenos_sin_ruta: {total: 28, valor: 7600},
            distribuidoras: {cantidad: 14, sin_gps: 3, ventas: 11000, pct_ventas: 11.0},
            ciclos_sin_cartera: {abiertos: 13, sin_cartera: 12, lista: [{id: 1, name: "Darién (26/10 - 30/10)", visitas: 5}]},
        };
    };
    const resumen = (simulado, extra = {}) => ({
        simulado, ruta_id: 1, ruta: "Darién", anterior: {id: 9, nombre: "Andrés"}, nuevo: {id: 11, nombre: "Milciades"},
        visitas_abiertas: 6, visitas_pasadas: 5, visitas_de_otro: 1, visitas_cerradas_intactas: 14,
        cartera_limpiada: 3, ciclos_con_cartera: ["Darién (26/10 - 30/10)"], ...extra,
    });

    /** Handlers de Administración + Gerente. `extra` pisa cualquiera. */
    function handlers(extra = {}) {
        return Object.assign({
            "fsm.order.shalom_admin_seguimiento_visitas": [],
            "fsm.order.shalom_admin_visitas_en_vivo": [],
            "fsm.order.shalom_admin_carritos_pendientes": [],
            "fsm.person.shalom_admin_rutas_programadas": [],
            "shalom.estrategia.shalom_admin_estrategias": [],
            "fsm.route.shalom_admin_gerente_mes": () => JSON.parse(JSON.stringify(MES)),
            "fsm.route.shalom_admin_reparto_rutas": () => repartoBase(),
            "fsm.route.shalom_admin_salud_datos": () => saludBase(),
            "fsm.route.shalom_admin_reasignar_ruta": (a) => resumen(a[2] === true),
            // ClienteForm (botón "Ficha")
            "fsm.person.shalom_mis_rutas": [{id: 1, name: "Darién"}],
            "fsm.location.read": [{id: 100, name: "Cliente 1", phone: "", street: "", street2: "", partner_id: false, fsm_route_id: false, partner_latitude: 0, partner_longitude: 0}],
            "fsm.location.shalom_buscar_clientes_faltantes_ruta": [],
        }, extra);
    }
    const sinFallas = (m) => ok(m.errores.length === 0, "sin rechazos no manejados", m.errores);
    const llamadas = (m, metodo) => m.log.filter((c) => c.method === metodo);
    const err = (msg) => { const e = new Error(msg); e.data = {message: msg}; return e; };
    const tabActiva = (i) => qa(".adm-tab")[i].classList.contains("adm-tab-active");

    // =====================================================================
    escenarios.gerente_pestana = async function () {
        console.log("\n[Gerente] la pestaña monta el componente y muestra las cuatro secciones");
        const m = await montar(bundle.AdminGestion, {}, handlers());
        await sleep(100);
        const tabs = qa(".adm-tab");
        ok(tabs.length === 5 && /Gerente/.test(tabs[4].textContent), "hay una quinta pestaña 'Gerente'", tabs.map((t) => t.textContent.trim()));
        ok(!q(".adm-ger"), "sin abrirla no se carga nada del gerente");
        ok(llamadas(m, "shalom_admin_gerente_mes").length === 0, "ninguna RPC del gerente antes de abrir la pestaña");
        click(tabs[4]);
        await esperar(() => q(".adm-ger-kpi-ventas"));
        await esperar(() => qa(".adm-ger-gps-fila").length > 0);
        ok(tabActiva(4), "la pestaña queda activa");

        // Mes en curso
        const ventas = texto(".adm-ger-kpi-ventas");
        console.log("    ventas:", ventas);
        ok(/\$41,900/.test(ventas), "ventas del mes $41,900");
        ok(/69\.8% del piso/.test(ventas) && /52\.4% de la meta/.test(ventas), "% del piso y de la meta");
        ok(/Faltan \$18,100 para el piso/.test(ventas), "falta para el piso");
        const barra = q(".adm-ger-kpi-ventas .adm-ger-bar-fill").getAttribute("style");
        ok(/width:\s*52\.375%/.test(barra), "la barra llega al % de la meta", barra);
        ok(/left:\s*75%/.test(q(".adm-ger-bar-mark").getAttribute("style")), "la marca del piso está al 75% de la barra");
        ok(/20\.2%/.test(texto(".adm-ger-kpi-margen")) && /Utilidad \$8,464/.test(texto(".adm-ger-kpi-margen")), "margen 20.2% y utilidad en dólares", texto(".adm-ger-kpi-margen"));
        ok(/16/.test(texto(".adm-ger-kpi-oxigenta .adm-ger-kpi-valor")) && /33 en los 5 pedido/.test(texto(".adm-ger-kpi-oxigenta")), "oxigenta por 100 tintes = 16 (33 en los que la llevan)", texto(".adm-ger-kpi-oxigenta"));
        ok(/12/.test(texto(".adm-ger-kpi-pedidos")) && /31 estrellas \(9 de oro\)/.test(texto(".adm-ger-kpi-pedidos")), "pedidos y estrellas del equipo");
        ok(qa(".adm-ger-vendedor").length === 2, "una fila por vendedor", qa(".adm-ger-vendedor").length);
        ok(/octubre 2026/.test(texto(".adm-body.adm-ger")), "el mes se rotula 'octubre 2026'");

        // Reparto
        const personas = qa(".adm-ger-persona");
        ok(personas.length === 2, "una tarjeta por vendedor", personas.length);
        ok(/Andrés/.test(personas[0].textContent) && /\$25\.3k · 12\.7 días/.test(personas[0].textContent), "Andrés $25.3k · 12.7 días", personas[0].textContent.replace(/\s+/g, " "));
        ok(/\$27\.1k · 13\.6 días/.test(personas[1].textContent), "Luis $27.1k · 13.6 días");
        ok(personas[0].querySelectorAll(".adm-ger-pasar").length === 2, "botón 'Pasar a…' por cada ruta de Andrés");
        ok(qa(".adm-ger-aviso .adm-ger-pasar").length === 2, "las rutas sin dueño / sin ventas también tienen 'Pasar a…'");
        ok(/Sin dueño/.test(texto(".adm-ger-aviso")) && /Sin ventas · de Luis/.test(texto(".adm-ger-aviso")), "motivos de las rutas apartadas");
        ok(/28 clientes buenos sin ruta: \$7\.6k/.test(texto(".adm-ger-sin-ruta")), "28 clientes buenos sin ruta $7.6k", texto(".adm-ger-sin-ruta"));

        // Salud
        const filas = qa(".adm-ger-salud-fila").map((f) => f.textContent.replace(/\s+/g, " ").trim());
        console.log("    salud:", JSON.stringify(filas));
        ok(filas.some((f) => /Ubicaciones sin GPS\s*502 de 1086/.test(f)), "502 de 1086 sin GPS");
        ok(filas.some((f) => /Clientes buenos sin ruta\s*28/.test(f)), "buenos sin ruta");
        ok(filas.some((f) => /Distribuidoras marcadas\s*14 · 11% de las ventas/.test(f)), "distribuidoras 14 · 11%");
        ok(qa(".adm-ger-warn").length >= 4, "las filas con problemas van resaltadas", qa(".adm-ger-warn").length);

        // GPS prioritario
        ok(/158 de 193/.test(texto(".adm-ger-gps-resumen")) && /70\.4%/.test(texto(".adm-ger-gps-resumen")), "avance 158 de 193 y cobertura 70.4%", texto(".adm-ger-gps-resumen"));
        ok(qa(".adm-ger-gps-fila").length === 30, "'Primeros 30' muestra 30 filas", qa(".adm-ger-gps-fila").length);
        ok(/Cliente 1(?!\d)/.test(qa(".adm-ger-gps-fila")[0].textContent) && /\$1,600/.test(qa(".adm-ger-gps-fila")[0].textContent), "la primera es la de mayor valor", qa(".adm-ger-gps-fila")[0].textContent.replace(/\s+/g, " "));
        ok(/sin ruta/.test(qa(".adm-ger-gps-fila")[0].textContent) && /Darién/.test(qa(".adm-ger-gps-fila")[1].textContent), "ruta o 'sin ruta' en cada fila");
        const rpcs = m.log.filter((c) => c.model === "fsm.route").map((c) => c.method).sort();
        ok(rpcs.length === 3, "una sola llamada por sección al abrir", rpcs);
        sinFallas(m);
        m.destruir();
    };

    // =====================================================================
    escenarios.gerente_reasignar = async function () {
        console.log("\n[Gerente] 'Pasar a…': vista previa, confirmación, RPC con los argumentos correctos y refresco");
        const m = await montar(bundle.AdminGestion, {}, handlers());
        await sleep(80);
        click(qa(".adm-tab")[4]);
        await esperar(() => qa(".adm-ger-persona").length === 2);
        const antes = llamadas(m, "shalom_admin_reparto_rutas").length;

        // Darién (ruta 1, de Andrés): su selector no ofrece a Andrés
        click(qa(".adm-ger-persona")[0].querySelector(".adm-ger-pasar"));
        await esperar(() => q(".adm-ger-pasar-overlay"));
        ok(!!q(".adm-ger-pasar-overlay"), "se abre el modal");
        ok(/Pasar «Darién» a…/.test(texto(".adm-modal-title")) && /Hoy es de Andrés/.test(texto(".adm-modal-sub")), "título y dueño actual", texto(".adm-modal-head"));
        const opciones = qa(".adm-ger-select-persona option").map((o) => o.textContent.trim());
        ok(JSON.stringify(opciones) === JSON.stringify(["Elige un vendedor…", "Luis", "Milciades"]), "el selector no ofrece al dueño actual", opciones);
        ok(q(".adm-ger-confirmar").disabled, "Confirmar está deshabilitado hasta elegir");
        ok(llamadas(m, "shalom_admin_reasignar_ruta").length === 0, "todavía ninguna RPC de reasignación");

        // elegir a Milciades (id 11) -> vista previa (simular=true), sin escribir
        const sel = q(".adm-ger-select-persona");
        sel.value = "11";
        sel.dispatchEvent(new window.Event("change", {bubbles: true}));
        await esperar(() => q(".adm-ger-resumen"));
        const previa = llamadas(m, "shalom_admin_reasignar_ruta");
        console.log("    RPC de vista previa:", JSON.stringify(previa.map((c) => c.args)));
        ok(previa.length === 1 && JSON.stringify(previa[0].args) === JSON.stringify([1, 11, true]), "vista previa = [route_id, person_id, true]");
        const rs = texto(".adm-ger-resumen");
        console.log("    resumen:", rs);
        ok(/de Andrés a Milciades/.test(rs), "de quién a quién");
        ok(/5 visita\(s\) abierta\(s\) pasan a su nombre/.test(rs) && /1 abierta\(s\) asignada\(s\) a otra persona no se tocan/.test(rs), "visitas que pasan y las de otro que no");
        ok(/14 visita\(s\) cerrada\(s\) quedan como están/.test(rs), "cerradas intactas");
        ok(/limpia el reparto de cartera de 3/.test(rs) && /habrá que volver a repartir/.test(rs), "aviso de cartera limpiada");
        ok(!q(".adm-ger-confirmar").disabled, "ahora Confirmar está habilitado");

        // confirmar -> RPC real (2 argumentos), aviso, cierre y refresco del reparto
        click(q(".adm-ger-confirmar"));
        await esperar(() => !q(".adm-ger-pasar-overlay"));
        const todas = llamadas(m, "shalom_admin_reasignar_ruta");
        ok(todas.length === 2 && JSON.stringify(todas[1].args) === JSON.stringify([1, 11]), "confirmación = [route_id, person_id] (sin simular)", todas.map((c) => c.args));
        ok(!q(".adm-ger-pasar-overlay"), "el modal se cierra");
        ok(m.notas.length === 1 && m.notas[0].tipo === "success" && /«Darién» ahora es de Milciades/.test(m.notas[0].msg) && /5 visita\(s\)/.test(m.notas[0].msg), "aviso de éxito con el resumen", m.notas);
        await esperar(() => llamadas(m, "shalom_admin_reparto_rutas").length > antes);
        ok(llamadas(m, "shalom_admin_reparto_rutas").length === antes + 1, "el reparto se vuelve a pedir al servidor");
        ok(llamadas(m, "shalom_admin_gerente_mes").length === 1, "el resto de las secciones no se recarga sin necesidad");

        // ruta sin dueño: ofrece a todos
        await esperar(() => q(".adm-ger-aviso .adm-ger-pasar"));
        click(q(".adm-ger-aviso .adm-ger-pasar"));
        await esperar(() => q(".adm-ger-pasar-overlay"));
        const todos = qa(".adm-ger-select-persona option").map((o) => o.textContent.trim());
        ok(todos.length === 4 && /nadie/.test(texto(".adm-modal-sub")), "una ruta sin dueño se puede pasar a cualquiera", todos);
        // cancelar no escribe
        click(qa(".adm-modal-foot button")[0]);
        await sleep(30);
        ok(!q(".adm-ger-pasar-overlay") && llamadas(m, "shalom_admin_reasignar_ruta").length === 2, "Cancelar cierra sin llamar al servidor");
        sinFallas(m);
        m.destruir();
    };

    escenarios.gerente_reasignar_errores = async function () {
        console.log("\n[Gerente] 'Pasar a…' con errores del servidor");
        let falla = null;
        const m = await montar(bundle.AdminGerente, {}, handlers({
            "fsm.route.shalom_admin_reasignar_ruta": (a) => {
                if (falla) throw err(falla);
                return resumen(a[2] === true, {nuevo: {id: a[1], nombre: a[1] === 10 ? "Luis" : "Milciades"}});
            },
        }));
        await esperar(() => qa(".adm-ger-persona").length === 2);
        // 1) la vista previa falla (ej. Visita Exprés): se muestra y no se puede confirmar
        click(qa(".adm-ger-persona")[0].querySelector(".adm-ger-pasar"));
        await esperar(() => q(".adm-ger-pasar-overlay"));
        falla = "«Darién» es una Visita Exprés";
        let sel = q(".adm-ger-select-persona");
        sel.value = "10"; sel.dispatchEvent(new window.Event("change", {bubbles: true}));
        await esperar(() => q(".adm-ger-error-pasar"));
        ok(/Visita Exprés/.test(texto(".adm-ger-error-pasar")), "se muestra el mensaje del servidor", texto(".adm-ger-error-pasar"));
        ok(q(".adm-ger-confirmar").disabled && !q(".adm-ger-resumen"), "sin resumen no se puede confirmar");
        // 2) la vista previa va bien pero la confirmación falla: el modal queda abierto y reintenta
        falla = null;
        sel = q(".adm-ger-select-persona");
        sel.value = "11"; sel.dispatchEvent(new window.Event("change", {bubbles: true}));
        await esperar(() => q(".adm-ger-resumen"));
        ok(!q(".adm-ger-error-pasar"), "al elegir otra persona el error anterior se limpia");
        falla = "No tienes permiso";
        click(q(".adm-ger-confirmar"));
        await esperar(() => q(".adm-ger-error-pasar"));
        ok(!!q(".adm-ger-pasar-overlay") && /No tienes permiso/.test(texto(".adm-ger-error-pasar")), "si falla escribir, el modal sigue abierto con el error");
        ok(m.notas.length === 0, "y no avisa éxito");
        ok(!q(".adm-ger-confirmar").disabled, "se puede reintentar");
        falla = null;
        click(q(".adm-ger-confirmar"));
        await esperar(() => !q(".adm-ger-pasar-overlay"));
        ok(m.notas.length === 1 && m.notas[0].tipo === "success", "el reintento funciona");
        sinFallas(m);
        m.destruir();
    };

    // =====================================================================
    escenarios.gerente_gps = async function () {
        console.log("\n[Gerente] GPS prioritario: pestañas, 'Ubicar' (asistente nativo), 'Ficha' y CSV");
        const m = await montar(bundle.AdminGerente, {}, handlers());
        // el doAction falso de simular.js descarta las opciones: aquí se capturan completas
        const acciones = [];
        globalThis.__servicios.action.doAction = (accion, opciones) => { acciones.push([accion, opciones]); return Promise.resolve(); };
        await esperar(() => qa(".adm-ger-gps-fila").length > 0);
        const chips = qa(".adm-ger-gps-tabs .adm-chip").map((c) => c.textContent.replace(/\s+/g, " ").trim());
        ok(JSON.stringify(chips) === JSON.stringify(["Primeros 30", "Todos (35)", "Sin ruta (12)"]), "pestañas Primeros 30 / Todos (35) / Sin ruta (12)", chips);
        ok(qa(".adm-ger-gps-fila").length === 30, "primeros 30");
        click(qa(".adm-ger-gps-tabs .adm-chip")[1]);
        await sleep(30);
        ok(qa(".adm-ger-gps-fila").length === 35, "Todos: 35 filas", qa(".adm-ger-gps-fila").length);
        click(qa(".adm-ger-gps-tabs .adm-chip")[2]);
        await sleep(30);
        ok(qa(".adm-ger-gps-fila").length === 12 && qa(".adm-ger-gps-fila").every((f) => /sin ruta/.test(f.textContent)), "Sin ruta: 12 filas, todas 'sin ruta'");
        ok(qa(".adm-ger-gps-rank").map((r) => r.textContent).join() === "1,2,3,4,5,6,7,8,9,10,11,12", "se numera por posición en la lista");
        // las filas están por valor, de mayor a menor
        const valores = qa(".adm-ger-gps-fila .adm-row-monto-total").map((v) => Number(v.textContent.replace(/[$,]/g, "")));
        ok(valores.every((v, i) => i === 0 || v <= valores[i - 1]), "ordenadas por valor", valores);

        // Ubicar -> acción nativa precargada con ese cliente
        click(qa(".adm-ger-gps-fila")[1].querySelector(".adm-ger-ubicar"));
        console.log("    doAction:", JSON.stringify(acciones));
        ok(acciones.length === 1 && acciones[0][0] === "shalom_location_map.shalom_buscar_gps_wizard_action", "'Ubicar' abre el asistente 'Buscar GPS por nombre'");
        const ctxAccion = (acciones[0] && acciones[0][1] && acciones[0][1].additionalContext) || {active_ids: []};
        ok(ctxAccion.active_model === "fsm.location" && ctxAccion.active_ids.length === 1 && ctxAccion.active_ids[0] === 103, "con active_ids = [id del cliente de la fila]", ctxAccion);

        // Ficha -> ClienteForm del cliente
        click(qa(".adm-ger-gps-fila")[0].querySelector(".adm-ger-ficha"));
        await esperar(() => m.comp.state.locationIdEditando);
        ok(m.comp.state.locationIdEditando === 100, "'Ficha' abre la ficha del cliente 100");
        await esperar(() => m.log.some((c) => c.model === "fsm.location" && c.method === "read"));
        ok(m.log.some((c) => c.model === "fsm.location" && c.method === "read" && c.args[0][0] === 100), "ClienteForm lee al cliente 100");
        // al guardar, se recargan la salud y el reparto
        const nSalud = llamadas(m, "shalom_admin_salud_datos").length;
        const nReparto = llamadas(m, "shalom_admin_reparto_rutas").length;
        await m.comp.fichaGuardada();
        ok(m.comp.state.locationIdEditando === null, "la ficha se cierra");
        ok(llamadas(m, "shalom_admin_salud_datos").length === nSalud + 1 && llamadas(m, "shalom_admin_reparto_rutas").length === nReparto + 1, "al guardar la ficha se recargan salud y reparto");

        // CSV: lista COMPLETA (no solo la pestaña activa)
        let blobTexto = null;
        const descargas = [];
        // el componente usa el URL/Blob globales de Node, no los de jsdom
        const urlOriginal = [globalThis.URL.createObjectURL, globalThis.URL.revokeObjectURL];
        globalThis.URL.createObjectURL = (b) => { b.text().then((t) => { blobTexto = t; }); return "blob:prueba"; };
        globalThis.URL.revokeObjectURL = () => {};
        const clickOriginal = window.HTMLAnchorElement.prototype.click;
        window.HTMLAnchorElement.prototype.click = function () { descargas.push(this.download); };
        click(q(".adm-ger-csv"));
        await esperar(() => blobTexto);
        window.HTMLAnchorElement.prototype.click = clickOriginal;
        [globalThis.URL.createObjectURL, globalThis.URL.revokeObjectURL] = urlOriginal;
        const lineas = (blobTexto || "").replace("﻿", "").split("\r\n");
        ok(descargas[0] === "gps_prioritario.csv", "se descarga gps_prioritario.csv", descargas);
        ok(lineas.length === 36 && lineas[0] === '"Prioridad","Cliente","Clase","Ruta","Valor esperado"', "encabezado + 35 filas", [lineas.length, lineas[0]]);
        ok(lineas[1] === '"1","Cliente 1","A","sin ruta","1600.00"', "primera fila", lineas[1]);
        sinFallas(m);
        m.destruir();
    };

    escenarios.gerente_gps_vacio = async function () {
        console.log("\n[Gerente] sin clientes buenos sin GPS");
        const salud = saludBase();
        salud.buenos = {total: 193, con_gps: 193, sin_gps: 0, valor_sin_gps: 0};
        salud.gps_prioritario = [];
        salud.gps_cobertura_pct = 0;
        const m = await montar(bundle.AdminGerente, {}, handlers({"fsm.route.shalom_admin_salud_datos": () => salud}));
        await esperar(() => q(".adm-ger-gps-resumen"));
        ok(/Todos los clientes buenos tienen GPS/.test(texto(".adm-ger-gps-resumen")), "mensaje de todo ubicado");
        ok(!q(".adm-ger-gps-tabs") && !q(".adm-ger-csv"), "no se muestran pestañas ni CSV");
        sinFallas(m);
        m.destruir();
    };

    // =====================================================================
    escenarios.gerente_falla_rpc = async function () {
        console.log("\n[Gerente] si una RPC falla, el resto de Administración sigue");
        let fallaReparto = true;
        const m = await montar(bundle.AdminGestion, {}, handlers({
            "fsm.route.shalom_admin_reparto_rutas": () => {
                if (fallaReparto) throw err("Esta acción es solo para el rol Administrador de Servicio de Campo.");
                return repartoBase();
            },
            "shalom.estrategia.shalom_admin_estrategias": [{id: 1, titulo: "Oxigenta", tipo: "empujar", texto: "", activa: true, date_from: false, date_to: false, productos: []}],
        }));
        await sleep(80);
        click(qa(".adm-tab")[4]);
        await esperar(() => q(".adm-ger-error-reparto") && q(".adm-ger-kpi-ventas") && qa(".adm-ger-gps-fila").length);
        ok(!!q(".adm-ger-error-reparto") && /solo para el rol/.test(texto(".adm-ger-error-reparto")), "el reparto muestra su error con el mensaje del servidor", texto(".adm-ger-error-reparto"));
        ok(!!q(".adm-ger-kpi-ventas") && qa(".adm-ger-gps-fila").length === 30, "el mes y la salud siguen mostrándose");
        ok(!q(".adm-ger-persona"), "el reparto no deja tarjetas a medias");
        // reintentar
        fallaReparto = false;
        click(q(".adm-ger-error-reparto button"));
        await esperar(() => qa(".adm-ger-persona").length === 2);
        ok(!q(".adm-ger-error-reparto") && qa(".adm-ger-persona").length === 2, "'Reintentar' recupera la sección");

        // las otras pestañas de Administración siguen funcionando
        click(qa(".adm-tab")[3]);
        await esperar(() => qa(".adm-row").length === 1);
        ok(qa(".adm-row").length === 1 && !q(".adm-ger"), "Estrategias sigue funcionando después de la pestaña Gerente");
        click(qa(".adm-tab")[0]);
        await sleep(60);
        ok(!q(".adm-ger") && tabActiva(0), "Seguimiento también");
        sinFallas(m);
        m.destruir();
    };

    escenarios.gerente_falla_todo = async function () {
        console.log("\n[Gerente] el servidor rechaza las tres llamadas (ej. usuario sin rol de gerente)");
        const rechazo = () => { throw err("Esta acción es solo para el rol Administrador de Servicio de Campo."); };
        const m = await montar(bundle.AdminGestion, {}, handlers({
            "fsm.route.shalom_admin_gerente_mes": rechazo,
            "fsm.route.shalom_admin_reparto_rutas": rechazo,
            "fsm.route.shalom_admin_salud_datos": rechazo,
        }));
        await sleep(80);
        click(qa(".adm-tab")[4]);
        await esperar(() => qa(".adm-ger-error").length === 3);
        ok(qa(".adm-ger-error").length === 3, "cada sección muestra su propio error", qa(".adm-ger-error").length);
        ok(!q(".adm-ger-pasar") && !q(".adm-ger-gps-fila"), "no hay botones de escritura sin datos");
        click(qa(".adm-tab")[0]);
        await sleep(60);
        ok(tabActiva(0) && !q(".adm-ger"), "se puede volver a las otras pestañas");
        sinFallas(m);
        m.destruir();
    };

    // El título 'octubre 2026' y el formato de dinero son funciones puras exportadas.
    escenarios.gerente_formato = async function () {
        console.log("\n[Gerente] formatos");
        ok(bundle.dinero(41900) === "$41,900" && bundle.dinero(-1250.4) === "-$1,250" && bundle.dinero(null) === "$0", "dinero()");
        ok(bundle.dineroCorto(25300) === "$25.3k" && bundle.dineroCorto(950) === "$950" && bundle.dineroCorto(0) === "$0", "dineroCorto()");
        ok(bundle.nombreMes("2026-10-01") === "octubre 2026" && bundle.nombreMes("2027-01-01") === "enero 2027" && bundle.nombreMes("") === "", "nombreMes()");
        ok(bundle.celdaCsv('a "b"') === '"a ""b"""' && bundle.celdaCsv(null) === '""', "celdaCsv() escapa comillas");
    };
};
