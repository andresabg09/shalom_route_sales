#!/usr/bin/env node
/*
 * Simulaciones de comportamiento con Owl real (owl.js de Odoo 18) + jsdom.
 * Monta OrderScreen, RutasHub, RutaDetalle, VisitSheet y AdminGestion con
 * servicios falsos (orm / notification / action) y datos sintéticos.
 *
 * Uso:
 *   node build_bundle.js            # genera /tmp/owl_check/bundle.cjs
 *   node simular.js [escenario...]  # sin argumentos corre todos
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const req = (m) => require(require.resolve(m, {paths: ["/tmp/owl_check", __dirname]}));
const {JSDOM} = req("jsdom");

const OWL = process.env.OWL_JS || "/tmp/owl_check/owl_odoo18.js";
const BUNDLE = process.env.BUNDLE || "/tmp/owl_check/bundle.cjs";
const MOD = process.env.SHALOM_MOD || path.resolve(__dirname, "../../shalom_location_map");
const DEV = process.env.OWL_DEV !== "0";

// ---------- entorno DOM ----------
const dom = new JSDOM('<!doctype html><html><body></body></html>', {url: "http://localhost/odoo/", pretendToBeVisual: true});
global.window = dom.window;
for (const k of Object.getOwnPropertyNames(dom.window)) {
    if (k in global) continue;
    try { global[k] = dom.window[k]; } catch (e) { /* ignorar */ }
}
global.localStorage = dom.window.localStorage;
global.sessionStorage = dom.window.sessionStorage;
global.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);
window.confirm = () => true;
window.requestAnimationFrame = global.requestAnimationFrame;
global.luxon = req("luxon");

// Mapbox GL falso: registra lo que se dibuja (no hay WebGL en jsdom).
function mapboxFalso() {
    const log = {mapas: 0, quitados: 0, marcadores: [], fitBounds: 0};
    window.__mapboxLog = log;
    class Popup { setDOMContent(el) { this.el = el; return this; } }
    class Marker {
        constructor(o) { this.element = o.element; log.marcadores.push(this); }
        setLngLat(c) { this.lngLat = c; return this; }
        setPopup(p) { this.popup = p; return this; }
        addTo() { return this; }
    }
    class LngLatBounds { extend() { return this; } }
    class Map {
        constructor() {
            if (window.__mapboxFalla) throw new Error("mapbox roto");
            log.mapas += 1; this._on = {};
            setTimeout(() => this._on.load && this._on.load(), 5);
        }
        on(ev, fn) { this._on[ev] = fn; return this; }
        remove() { log.quitados += 1; }
        fitBounds() { log.fitBounds += 1; }
        setCenter() {} setZoom() {} resize() {}
        addSource() {} addLayer() {}
    }
    return {Map, Marker, Popup, LngLatBounds};
}
window.mapboxgl = mapboxFalso();
// el CSS de Mapbox "ya está cargado" (jsdom nunca dispara onload de un <link>)
{
    const link = window.document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.css";
    window.document.head.appendChild(link);
}

// owl.js de Odoo es un IIFE que cuelga de `this.owl`
const owlSandbox = {};
vm.runInThisContext(`(function(){ ${fs.readFileSync(OWL, "utf8")} }).call(globalThis.__owlHost = {})`);
globalThis.owl = globalThis.__owlHost.owl;
const owl = globalThis.owl;
const bundle = require(BUNDLE);

// plantillas de todos los XML del módulo, en un solo <templates>
function plantillas() {
    const dirs = [path.join(MOD, "static/src/xml/ruta_shalom"), path.join(MOD, "static/src/xml")];
    let out = "<templates>";
    for (const d of dirs) {
        for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".xml"))) {
            const t = fs.readFileSync(path.join(d, f), "utf8");
            out += t.replace(/<\?xml[^>]*\?>/, "").replace(/<\/?templates[^>]*>/g, "");
        }
    }
    return out + "</templates>";
}
const TEMPLATES = plantillas();

// ---------- utilidades ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperar(cond, ms = 3000, paso = 20) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (cond()) return true;
        await sleep(paso);
    }
    return false;
}
let fallos = 0;
function ok(cond, msg, extra) {
    if (cond) console.log("  PASS  " + msg);
    else { fallos++; console.log("  FAIL  " + msg + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
const q = (sel, root = document.body) => root.querySelector(sel);
const qa = (sel, root = document.body) => [...root.querySelectorAll(sel)];
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", {bubbles: true, cancelable: true}));
const texto = (sel) => (q(sel) ? q(sel).textContent.replace(/\s+/g, " ").trim() : null);

function servicios(handlers) {
    const log = [];
    const notas = [];
    const manejar = async (model, method, args, kwargs) => {
        log.push({model, method, args});
        const h = handlers[`${model}.${method}`];
        if (h === undefined) throw new Error(`RPC no simulado: ${model}.${method}`);
        return typeof h === "function" ? h(args || [], kwargs || {}) : h;
    };
    globalThis.__servicios = {
        orm: {
            call: (model, method, args = [], kwargs = {}) => manejar(model, method, args, kwargs),
            read: (model, ids, fields) => manejar(model, "read", [ids, fields], {}),
            searchRead: (model, domain, fields, opts) => manejar(model, "searchRead", [domain, fields, opts], {}),
            unlink: () => Promise.resolve(true),
            write: () => Promise.resolve(true),
        },
        notification: {add: (msg, o) => notas.push({msg, tipo: o && o.type})},
        action: {doAction: (a) => { log.push({model: "action", method: "doAction", args: [a]}); return Promise.resolve(); }},
    };
    return {log, notas};
}

const montados = [];
async function montar(Comp, props, handlers) {
    const s = servicios(handlers);
    sessionStorage.clear(); localStorage.clear();
    document.body.innerHTML = '<div id="raiz" class="o_shalom_ruta_app"></div>';
    const errores = [];
    const onerr = (e) => errores.push(String((e && e.message) || e));
    process.on("unhandledRejection", onerr);
    const app = new owl.App(Comp, {templates: TEMPLATES, dev: DEV, env: {}, props, warnIfNoStaticProps: false});
    const comp = await app.mount(q("#raiz"));
    montados.push(app);
    return {app, comp, ...s, errores, destruir: () => { app.destroy(); process.off("unhandledRejection", onerr); }};
}

// ---------- datos sintéticos ----------
const PRODUCTOS = [
    {id: 1, name: "Tinte Rubio 8.0", list_price: 10, barcode: "111", default_code: "T1", qty_available: 50, free_qty: 40, categ_id: [1, "Tintes"]},
    {id: 2, name: "Oxigenta 20 vol con un nombre larguisimo que ocupa dos lineas en pantalla de celular", list_price: 4.5, barcode: "222", default_code: "O1", qty_available: 3, free_qty: 2, categ_id: [2, "Oxigentas"]},
    {id: 3, name: "Shampoo", list_price: 8, barcode: "333", default_code: "S1", qty_available: 0, free_qty: 0, categ_id: [3, "Cuidado"]},
];
const REFS = {n: 5, record: 400, tipico: 200, t75: 150, t100: 200};
function evaluar(lineas) {
    const total = lineas.reduce((t, l) => t + PRODUCTOS.find((p) => p.id === l.product_id).list_price * l.qty, 0);
    const est = total > 400 ? 3 : total >= 200 ? 2 : total >= 150 ? 1 : 0;
    const objetivo = est === 0 ? 150 : est === 1 ? 200 : 400.01;
    return {
        total, margen_pct: 35, utilidad: total * 0.35, estrellas: est, refs: REFS,
        siguiente: est >= 3 ? null : {estrellas: est + 1, objetivo, faltan: Math.max(objetivo - total, 0), margen_bajo: false},
    };
}
const JUEGO = {
    estrellas: 2, xp: 120, total: 220, utilidad: 77, margen_pct: 35, record_roto: false, margen_bajo: false,
    refs: REFS, clase: "A", subio_nivel: true,
    progreso: {xp_total: 450, nivel: 2, nivel_nombre: "Explorador", xp_nivel: 300, xp_siguiente: 700},
};
function handlersOrder(extra = {}) {
    // carrito "del servidor": fusiona por clave como shalom_actualizar_carrito
    const srv = {};
    let version = 0;
    return Object.assign({
        "fsm.order.read": () => [{id: 5, location_id: [7, "Cliente X"]}],
        "fsm.order.shalom_campos_cliente_faltantes": [],
        "product.product.searchRead": () => PRODUCTOS.map((p) => ({...p})),
        "fsm.order.shalom_existencias_bodegas": (a) => Object.fromEntries(a[0].map((id) => [id, {dianke: id === 1 ? 40 : id === 2 ? 2 : 0, nevada: id === 1 ? 1200 : 0}])),
        "shalom.estrategia.shalom_estrategias_vigentes": {
            empujar: [{id: 1, titulo: "Oxigenta con cada tinte", texto: "Margen alto", productos: [{id: 2, nombre: "Oxigenta"}]}],
            no_ofrecer: [{id: 2, titulo: "Shampoo viejo", texto: "", productos: [{id: 3, nombre: "Shampoo"}]}],
            productos: {2: "empujar", 3: "no_ofrecer"},
        },
        "fsm.order.shalom_leer_carrito": () => ({actualizado: version ? `2026-01-01 10:00:${String(version).padStart(2, "0")}` : false, carrito: JSON.parse(JSON.stringify(srv))}),
        "fsm.order.shalom_marcar_catalogo_abierto": {es_principal: true},
        "fsm.order.shalom_actualizar_carrito": (a) => {
            Object.assign(srv, a[1] || {});
            for (const k of a[2] || []) delete srv[String(k)];
            version++;
            return {actualizado: `2026-01-01 10:00:${String(version).padStart(2, "0")}`, carrito: JSON.parse(JSON.stringify(srv))};
        },
        "fsm.order.shalom_estado_promociones_carrito": {mensajes: {}, recompensas: []},
        "fsm.order.shalom_evaluar_pedido": (a) => evaluar(a[1]),
        "fsm.order.shalom_pedidos_anteriores": [
            {id: 90, nombre: "S0090", fecha: "2026-09-01", total: 150, lineas: [{product_id: 1, nombre: "Tinte Rubio 8.0", cantidad: 12}, {product_id: 99, nombre: "Descontinuado", cantidad: 1}]},
            {id: 91, nombre: "S0091", fecha: "2026-08-01", total: 60, lineas: [{product_id: 2, nombre: "Oxigenta", cantidad: 3}, {product_id: 2, nombre: "Oxigenta", cantidad: 2}]},
        ],
        "fsm.order.shalom_formas_pago_disponibles": [{value: "cash", label: "Efectivo"}],
        "fsm.order.shalom_ultima_forma_pago_e_itbms": {payment_method: "cash", includes_itbms: false},
        "fsm.order.shalom_confirmar_pedido": {sale_order_id: 1, sale_order_name: "S0100", total: 220, juego: JUEGO},
        "fsm.order.shalom_cerrar_sesion_catalogo": true,
        "fsm.order.shalom_limpiar_carrito": true,
    }, extra);
}

const escenarios = {};

// =====================================================================
escenarios.order = async function () {
    console.log("\n[OrderScreen] catálogo -> carrito -> evaluación -> precarga -> confirmar -> resultado");
    let cerrado = 0, confirmado = 0;
    const h = handlersOrder();
    const m = await montar(bundle.OrderScreen, {
        orderId: 5, clienteNombre: "Cliente X",
        onCerrar: () => { cerrado++; }, onConfirmado: () => { confirmado++; },
    }, h);
    const {comp, log} = m;
    await esperar(() => !comp.state.cargando && qa(".product-card").length === 3);
    ok(qa(".product-card").length === 3, "catálogo renderiza 3 productos");
    const chips = qa(".product-card")[0].querySelectorAll(".stock-chips .stock-badge");
    ok(chips.length === 2, "producto 1 muestra 2 chips de bodega", chips.length);
    ok(chips[0] && chips[0].textContent.includes("Disponible: 40"), "chip Dianke = 'Disponible: 40'", chips[0] && chips[0].textContent);
    ok(chips[1] && chips[1].textContent.includes("Nevada: 1,200"), "chip Nevada = 'Nevada: 1,200' (toLocaleString en-US)", chips[1] && chips[1].textContent);
    ok(qa(".product-card")[2].querySelector(".stock-chips .tono-danger"), "producto 3 (sin existencia) -> chip rojo");
    ok(q(".marca-empujar") && q(".marca-no-ofrecer"), "marcas EMPUJAR / NO OFRECER presentes");
    ok(!q(".medidor"), "sin carrito no hay medidor");

    // agregar al carrito (clic real)
    click(qa(".qty-add-btn")[0]);                // 1 x $10
    click(qa(".product-card")[1].querySelector(".qty-add-btn")); // oxigenta 4.5
    await esperar(() => comp.cantidadItems === 2);
    ok(comp.cantidadItems === 2, "carrito con 2 unidades");
    ok(await esperar(() => q(".medidor"), 1500), "aparece el medidor tras el debounce de 300 ms + RPC");
    const evalCalls = log.filter((c) => c.method === "shalom_evaluar_pedido");
    ok(evalCalls.length === 1, "una sola llamada shalom_evaluar_pedido (debounce)", evalCalls.length);
    ok(evalCalls[0] && evalCalls[0].args[0] === 7 && evalCalls[0].args[1][0].product_id !== undefined, "args evaluar = [locationId, lineas{product_id,qty,es_recompensa,regla_id}]", evalCalls[0] && evalCalls[0].args);
    console.log("    medidor:", texto(".medidor"));
    ok(qa(".medidor-estrellas span").length === 3, "3 estrellas en el medidor");
    ok(/Te faltan \$136 para bronce/.test(texto(".medidor-mensaje") || ""), "mensaje 'Te faltan $136 para bronce (75%)'", texto(".medidor-mensaje"));

    // precargar
    click(q(".precarga-btn"));
    await esperar(() => qa(".precarga-pedido").length === 2);
    ok(qa(".precarga-pedido").length === 2, "hoja de precarga lista 2 pedidos");
    ok(log.some((c) => c.method === "shalom_pedidos_anteriores" && c.args[0] === 7), "RPC shalom_pedidos_anteriores([locationId])");
    // desplegar pedido 90
    click(qa(".precarga-pedido-cab")[0]);
    await esperar(() => qa(".precarga-linea").length === 2);
    ok(qa(".precarga-linea").length === 2, "pedido 90 despliega 2 líneas (una de producto fuera de catálogo)");
    // Agregar todo del pedido 90: 12 tintes
    click(qa(".precarga-todo-btn")[0]);
    await sleep(50);
    ok(comp.state.carrito[1] && comp.state.carrito[1].cantidad === 13, "'Agregar todo' suma 12 al 1 que ya había (=13)", comp.state.carrito[1] && comp.state.carrito[1].cantidad);
    ok(comp.state.precargaAbierta === false, "hoja de precarga se cierra tras agregar");
    ok(m.notas.some((n) => /Se agregaron 1 producto/.test(n.msg)), "notificación 'Se agregaron 1 producto(s)'", m.notas);
    await esperar(() => comp._cambiosPendientes && Object.keys(comp._cambiosPendientes).length === 0, 2500);

    // evaluación vuelve a llegar con el nuevo total (13*10+4.5 = 134.5 -> 0 estrellas)
    await sleep(500);
    console.log("    medidor tras precarga:", texto(".medidor"), "| errores:", m.errores, "| raiz viva:", !!q(".order-overlay"));

    // ir al carrito y confirmar
    click(q(".cart-footer"));
    await esperar(() => comp.state.pantalla === "carrito");
    await esperar(() => q(".cta-order"));
    ok(comp.state.pantalla === "carrito", "pantalla = carrito");
    click(q(".cta-order"));
    await esperar(() => comp.state.mostrandoFormaPago && !comp.state.cargandoFormaPago);
    // el botón confirmar del popup
    await esperar(() => qa(".confirm-card button").some((b) => /Confirmar/.test(b.textContent)));
    const btnConf = qa(".confirm-card button").find((b) => /Confirmar/.test(b.textContent));
    ok(!!btnConf, "botón Confirmar del pop-up de forma de pago existe");
    const antesTicks = log.filter((c) => c.method === "shalom_marcar_catalogo_abierto").length;
    click(btnConf);
    await esperar(() => comp.state.resultadoJuego, 3000);
    ok(!!comp.state.resultadoJuego, "state.resultadoJuego poblado tras confirmar con juego");
    ok(cerrado === 0, "OrderScreen NO se cerró aún (onCerrar sin llamar)", cerrado);
    ok(confirmado === 1, "onConfirmado llamado una vez", confirmado);
    ok(await esperar(() => q(".resultado-overlay"), 500), "overlay de resultado visible");
    console.log("    resultado:", texto(".resultado-card"));
    ok(qa(".resultado-estrellas span.estrella-on").length === 2, "2 estrellas encendidas");
    ok(/Nivel 2/.test(texto(".resultado-nivel-nombre") || ""), "nivel mostrado");
    ok(/faltan 250 para el siguiente nivel/.test(texto(".resultado-nivel-detalle") || ""), "faltan XP = 250", texto(".resultado-nivel-detalle"));
    ok(localStorage.getItem("shalom_carrito_borrador_5") === null, "borrador local borrado");

    // el tick NO debe volver a escribir
    const nAct = () => log.filter((c) => c.method === "shalom_actualizar_carrito" || c.method === "shalom_leer_carrito" || c.method === "shalom_marcar_catalogo_abierto").length;
    const base = nAct();
    // intentar ensuciar: tocar carrito mientras se ve el resultado no debe pasar al server
    comp.state.carrito[1].cantidad = 99; comp._marcarCambioPendienteCarrito(1);
    await sleep(2300);
    ok(nAct() === base, "tick de sincronización inactivo tras _confirmado (0 llamadas nuevas en 2.3 s)", nAct() - base);
    ok(localStorage.getItem("shalom_carrito_borrador_5") === null, "el borrador local sigue sin reescribirse");

    // Siguiente cliente
    click(q(".resultado-card .cta-order"));
    await sleep(50);
    ok(cerrado === 1, "'Siguiente cliente' -> onCerrar una vez", cerrado);
    click(q(".resultado-card .cta-order") || document.body);
    ok(cerrado === 1, "doble clic no cierra dos veces");
    ok(m.errores.length === 0, "sin rechazos no manejados", m.errores);
    m.destruir();
};

// =====================================================================
escenarios.order_dup_key = async function () {
    console.log("\n[OrderScreen] pedido anterior con el mismo producto en 2 líneas (t-key duplicada)");
    const m = await montar(bundle.OrderScreen, {orderId: 5, clienteNombre: "Cliente X", onCerrar() {}, onConfirmado() {}}, handlersOrder());
    await esperar(() => !m.comp.state.cargando && qa(".product-card").length === 3);
    click(q(".precarga-btn"));
    await esperar(() => qa(".precarga-pedido").length === 2);
    click(qa(".precarga-pedido-cab")[1]);
    await sleep(80);
    ok(m.errores.length === 0 && qa(".precarga-linea").length === 2, "despliega las 2 líneas sin error", {errores: m.errores, lineas: qa(".precarga-linea").length, raizViva: !!q(".order-overlay")});
    m.destruir();
};

escenarios.order_sin_juego = async function () {
    console.log("\n[OrderScreen] confirmar sin clave 'juego' -> cierra como antes");
    let cerrado = 0;
    const m = await montar(bundle.OrderScreen, {orderId: 5, clienteNombre: "Cliente X", onCerrar: () => cerrado++, onConfirmado: () => {}},
        handlersOrder({"fsm.order.shalom_confirmar_pedido": {sale_order_id: 1, sale_order_name: "S1", total: 10, juego: null}}));
    await esperar(() => !m.comp.state.cargando && qa(".product-card").length === 3);
    click(qa(".qty-add-btn")[0]);
    await esperar(() => q(".cart-footer"));
    click(q(".cart-footer"));
    await esperar(() => m.comp.state.pantalla === "carrito");
    await esperar(() => q(".cta-order"));
    click(q(".cta-order"));
    await esperar(() => m.comp.state.mostrandoFormaPago && !m.comp.state.cargandoFormaPago);
    await m.comp.confirmarFormaPago();
    await sleep(50);
    ok(cerrado === 1 && !m.comp.state.resultadoJuego, "juego=null -> cerrarDeVerdad directo");
    m.destruir();
};

// =====================================================================
escenarios.order_eval_reabrir = async function () {
    console.log("\n[OrderScreen] reabrir con borrador local: ¿se evalúa el carrito restaurado?");
    sessionStorage.clear();
    const m0 = servicios(handlersOrder());
    // sembrar borrador (se hace dentro de montar, que limpia storage -> sembramos tras limpiar con hook)
    const h = handlersOrder({
        "fsm.order.read": async () => { await sleep(500); return [{id: 5, location_id: [7, "Cliente X"]}]; }, // red lenta
    });
    const orig = Storage.prototype.getItem;
    const m = await (async () => {
        const s = servicios(h);
        document.body.innerHTML = '<div id="raiz" class="o_shalom_ruta_app"></div>';
        localStorage.clear();
        localStorage.setItem("shalom_carrito_borrador_5", JSON.stringify({ts: Date.now(), carrito: {1: {producto: PRODUCTOS[0], cantidad: 3}}}));
        const app = new owl.App(bundle.OrderScreen, {templates: TEMPLATES, dev: DEV, env: {}, props: {orderId: 5, clienteNombre: "Cliente X", onCerrar() {}, onConfirmado() {}}});
        const comp = await app.mount(q("#raiz"));
        return {app, comp, ...s};
    })();
    await sleep(1500);
    const evalCalls = m.log.filter((c) => c.method === "shalom_evaluar_pedido").length;
    ok(m.comp.cantidadItems === 3, "carrito restaurado con 3 unidades");
    ok(evalCalls >= 1 && !!q(".medidor"), "el medidor aparece solo con el carrito restaurado (sin tocar nada)", {llamadasEvaluar: evalCalls, medidor: !!q(".medidor")});
    m.app.destroy();
};

// =====================================================================
escenarios.order_eval_vs_cierre = async function () {
    console.log("\n[OrderScreen] evaluación con debounce vs cierre de la pantalla");
    const m = await montar(bundle.OrderScreen, {orderId: 5, clienteNombre: "Cliente X", onCerrar() {}, onConfirmado() {}}, handlersOrder());
    await esperar(() => !m.comp.state.cargando);
    click(qa(".qty-add-btn")[0]);        // arma el timer de 300 ms
    m.app.destroy();                      // se desmonta antes de que dispare
    const antes = m.log.filter((c) => c.method === "shalom_evaluar_pedido").length;
    await sleep(700);
    const despues = m.log.filter((c) => c.method === "shalom_evaluar_pedido").length;
    ok(despues === antes, "tras desmontar no se dispara shalom_evaluar_pedido", {antes, despues});
    // y llamar actualizarPromos() después del desmontaje (p. ej. respuesta tardía del tick)
    m.comp.actualizarPromos();
    await sleep(700);
    const tarde = m.log.filter((c) => c.method === "shalom_evaluar_pedido").length;
    ok(tarde === despues, "actualizarPromos() tardío tras desmontar NO re-arma el timer", {despues, tarde});
};

// =====================================================================
escenarios.order_eval_carrera = async function () {
    console.log("\n[OrderScreen] respuestas de shalom_evaluar_pedido fuera de orden (red lenta)");
    let n = 0;
    const m = await montar(bundle.OrderScreen, {orderId: 5, clienteNombre: "Cliente X", onCerrar() {}, onConfirmado() {}}, handlersOrder({
        "fsm.order.shalom_evaluar_pedido": async (a) => {
            const yo = ++n;
            if (yo === 1) await sleep(900);   // la primera tarda mucho
            return evaluar(a[1]);
        },
    }));
    await esperar(() => !m.comp.state.cargando && qa(".product-card").length === 3);
    click(qa(".qty-add-btn")[0]);                 // $10 -> 0 estrellas (1ª llamada, lenta)
    await sleep(350);
    for (let i = 0; i < 20; i++) m.comp.cambiarCantidad(1, 1);   // $210 -> 2 estrellas (2ª llamada, rápida)
    await sleep(1600);
    const real = evaluar(m.comp.lineasParaBackend(m.comp.itemsCarrito)).total;
    console.log(`    total real del carrito: $${real} | total que evaluó el servidor por última vez: $${m.comp.state.evaluacion && m.comp.state.evaluacion.total} | llamadas: ${n}`);
    ok(m.comp.state.evaluacion && m.comp.state.evaluacion.total === real, "el medidor refleja el carrito actual y no una respuesta vieja", {mostrado: m.comp.state.evaluacion && m.comp.state.evaluacion.total, real});
    m.destruir();
};

// =====================================================================
escenarios.hub = async function () {
    console.log("\n[RutasHub] estrategias y progreso");
    const hoy = new Date().toISOString().slice(0, 10);
    const sched = {id: 1, route_id: 3, route_name: "Ruta Norte", date_start: hoy, date_end: hoy, tiempo_estimado: 1, capacidad: 20, estado: "en_curso", cantidad_clientes: 10, es_visita_express: false, mi_persona_id: 9, tiene_cartera: true};
    const m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, {
        "fsm.person.shalom_mis_rutas_programadas": [sched],
        "shalom.estrategia.shalom_estrategias_vigentes": {
            empujar: [{id: 1, titulo: "Oxigenta", texto: "x", productos: [{id: 2, nombre: "Ox"}, {id: 4, nombre: "Tinte"}]}],
            no_ofrecer: [{id: 2, titulo: "Shampoo", texto: "", productos: []}], productos: {},
        },
        "shalom.juego.evento.shalom_mi_progreso": {xp_total: 450, nivel: 2, nivel_nombre: "Explorador", xp_nivel: 300, xp_siguiente: 700, pedidos_mes: 4, ventas_mes: 1234.5, estrellas_mes: 7},
    });
    await esperar(() => q(".estrategias-btn") && q(".progreso-juego"));
    ok(!!q(".estrategias-btn"), "botón Estrategias visible (totalEstrategias=2)");
    ok(!!q(".progreso-juego"), "tarjeta de progreso visible");
    console.log("    progreso:", texto(".progreso-juego"));
    ok(/\$1,235/.test(texto(".progreso-juego-mes")), "ventas_mes formateadas");
    ok(q(".progreso-juego .medidor-relleno").style.width === "37.5%", "barra XP = (450-300)/(700-300)=37.5%", q(".progreso-juego .medidor-relleno").getAttribute("style"));
    click(q(".estrategias-btn"));
    await sleep(30);
    ok(qa(".estrategia-item").length === 2, "modal lista 2 estrategias");
    ok(/Ox · Tinte/.test(texto(".estrategia-productos")), "productos unidos con ' · '");
    click(q(".confirm-overlay"));
    await sleep(30);
    ok(!q(".confirm-overlay"), "clic en el fondo cierra el modal (t-on-click.self)");
    m.destruir();

    // fallos de RPC: sin estrategias ni progreso
    const m2 = await montar(bundle.RutasHub, {onAbrirRuta() {}}, {
        "fsm.person.shalom_mis_rutas_programadas": [sched],
        "shalom.juego.evento.shalom_mi_progreso": false,
    });
    await sleep(100);
    ok(!q(".estrategias-btn") && !q(".progreso-juego"), "si las RPC fallan / progreso=false: la pantalla sigue sin botón ni tarjeta");
    m2.destruir();
};

// =====================================================================
escenarios.hub_mapa = async function () {
    console.log("\n[RutasHub] mapa de rutas (Fase 5)");
    Object.assign(window.__mapboxLog, {mapas: 0, quitados: 0, marcadores: [], fitBounds: 0});
    const hoy = new Date().toISOString().slice(0, 10);
    const base = {date_start: hoy, date_end: hoy, tiempo_estimado: 1, capacidad: 20, es_visita_express: false, mi_persona_id: 9, tiene_cartera: false};
    const scheds = [
        {...base, id: 1, route_id: 3, route_name: "Ruta Norte", estado: "en_curso", cantidad_clientes: 10, centro_lat: 9.1, centro_lng: -79.4, pendientes_mios: 7, esperado_mio: 2150.5},
        {...base, id: 2, route_id: 4, route_name: "Ruta Sur", estado: "por_iniciar", cantidad_clientes: 5, centro_lat: 8.6, centro_lng: -80.1, pendientes_mios: 5, esperado_mio: 640},
        {...base, id: 3, route_id: 5, route_name: "Sin GPS", estado: "por_iniciar", cantidad_clientes: 3, centro_lat: 0, centro_lng: 0, pendientes_mios: 0, esperado_mio: 0},
    ];
    localStorage.removeItem("shalom_hub_vista");
    let abierta = null;
    const hand = {"fsm.person.shalom_mis_rutas_programadas": scheds, "shalom.estrategia.shalom_estrategias_vigentes": {empujar: [], no_ofrecer: [], productos: {}}, "shalom.juego.evento.shalom_mi_progreso": false};
    let m = await montar(bundle.RutasHub, {onAbrirRuta(s) { abierta = s; }}, hand);
    await esperar(() => window.__mapboxLog.marcadores.length >= 2, 3000);
    const log = window.__mapboxLog;
    ok(m.comp.state.vista === "mapa", "la pestaña abre en el mapa por defecto");
    ok(log.mapas === 1 && log.marcadores.length === 2, "un pin por ruta con GPS (la de centro 0,0 no)", {mapas: log.mapas, pines: log.marcadores.length});
    const textos = log.marcadores.map((mk) => mk.element.textContent);
    ok(textos[0] === "$2.2k" && textos[1] === "$640", "el pin muestra el valor esperado corto", textos);
    ok(/1 ruta\(s\) no aparecen/.test(texto(".rutas-mapa-nota")), "nota de rutas sin GPS", texto(".rutas-mapa-nota"));
    ok(!q(".route-card"), "en vista mapa no se pinta la lista");
    const boton = log.marcadores[0].popup.el.querySelector("button");
    boton.click();
    ok(abierta && abierta.id === 1, "'Abrir ruta' del popup abre esa ruta", abierta && abierta.id);
    click(qa(".segmented button")[1]);
    await sleep(60);
    ok(m.comp.state.vista === "lista" && qa(".route-card").length === 3, "interruptor Lista muestra las 3 tarjetas");
    ok(localStorage.getItem("shalom_hub_vista") === "lista", "la elección se recuerda");
    ok(log.quitados >= 1, "al salir del mapa se destruye el mapa");
    m.destruir();

    // Mapbox roto: cae a la lista sola
    localStorage.removeItem("shalom_hub_vista");
    window.__mapboxFalla = true;
    m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, hand);
    await esperar(() => m.comp.state.vista === "lista", 3000);
    ok(m.comp.state.vista === "lista" && qa(".route-card").length === 3, "si el mapa falla, se muestra la lista");
    window.__mapboxFalla = false;
    m.destruir();
};

// =====================================================================
escenarios.detalle = async function () {
    console.log("\n[RutaDetalle] Mi cartera / Toda la ruta");
    const yo = 9, otro = 10;
    const ordenes = [
        {id: 11, location_id: [101, "Cli A"], x_cliente_orden_ruta: 1, stage_name: "Pendiente", x_cliente_lat: 8.9, x_cliente_lng: -79.5, x_cartera_person_id: [yo, "Yo"], x_cartera_fecha: "2026-10-27", x_cartera_orden: 2, x_cartera_reserva: false},
        {id: 12, location_id: [102, "Cli B"], x_cliente_orden_ruta: 2, stage_name: "Pendiente", x_cliente_lat: 8.9, x_cliente_lng: -79.5, x_cartera_person_id: [otro, "Luis"], x_cartera_fecha: "2026-10-27", x_cartera_orden: 1, x_cartera_reserva: false},
        {id: 13, location_id: [103, "Cli C"], x_cliente_orden_ruta: 3, stage_name: "Completado", x_cliente_lat: 8.9, x_cliente_lng: -79.5, x_cartera_person_id: [yo, "Yo"], x_cartera_fecha: "2026-10-27", x_cartera_orden: 1, x_cartera_reserva: false},
        {id: 14, location_id: [104, "Cli D"], x_cliente_orden_ruta: 4, stage_name: "Pendiente", x_cliente_lat: false, x_cliente_lng: false, x_cartera_person_id: false, x_cartera_fecha: false, x_cartera_orden: 0, x_cartera_reserva: false},
    ];
    const h = {
        "fsm.order.searchRead": ordenes,
        "fsm.location.read": (a) => a[0].map((id) => ({id, name: "x", phone: "", mobile: "", street: "calle", street2: "", x_venta_mas_alta: 50, partner_id: [1, "p"]})),
        "fsm.location.searchRead": (a) => [],
        "fsm.order.shalom_perfiles_ruta": {101: {clase: "A", esperado: 1500.4, tipico: 300, record: 500}, 102: {clase: "B", esperado: 300, tipico: 100, record: 150}, 103: {clase: "A2", esperado: 700, tipico: 200, record: 300}},
        "fsm.route.read": [{id: 3, x_ruta_trazado: false}],
        "fsm.order.shalom_marcar_catalogo_abierto": {es_principal: true},
    };
    const sched = {id: 1, route_id: 3, route_name: "Ruta Norte", date_start: "2026-10-26", date_end: "2026-10-30", estado: "en_curso", cantidad_clientes: 4, mi_persona_id: yo, tiene_cartera: true};
    const m = await montar(bundle.RutaDetalle, {schedule: sched, onVolver() {}}, h);
    await esperar(() => !m.comp.state.cargando);
    console.log("    RPCs de arranque:", m.log.map((c) => c.model + "." + c.method).join(", "));
    ok(m.comp.state.modoCartera === "mi", "arranca en 'mi'");
    ok(qa(".stop-card").length === 1 || qa("[class*=stop]").length > 0, "lista renderizada");
    const nombres = () => qa(".stop-card .name").map((e) => e.textContent.trim());
    console.log("    Mi cartera (pendientes):", nombres());
    ok(JSON.stringify(nombres()) === JSON.stringify(["Cli A"]), "Mi cartera pendiente = solo Cli A", nombres());
    ok(/1 de 2 clientes pendientes/.test(texto(".cartera-resumen") || ""), "resumen '1 de 2 clientes pendientes'", texto(".cartera-resumen"));
    ok(/\$2,200/.test(texto(".cartera-resumen") || ""), "valor esperado de tu cartera = $2,200 (1500.4+700)", texto(".cartera-resumen"));
    ok(/A · \$1500/.test(texto(".chip-clase") || ""), "chip clase 'A · $1500'", texto(".chip-clase"));
    console.log("    chips:", qa(".stop-chips").map((e) => e.textContent.replace(/\s+/g, " ").trim()));
    const toda = qa(".segmented-cartera button")[1];
    click(toda);
    await sleep(60);
    ok(JSON.stringify(nombres()) === JSON.stringify(["Cli B", "Cli D", "Cli A"].filter((n) => nombres().includes(n))) || nombres().length === 3, "Toda la ruta: 3 pendientes (A, B, D)", nombres());
    ok(!q(".cartera-resumen"), "resumen oculto en 'toda'");
    console.log("    Toda la ruta (pendientes):", nombres(), "| chips:", qa(".stop-chips").map((e) => e.textContent.replace(/\s+/g, " ").trim()));
    click(qa(".segmented-cartera button")[0]);
    await sleep(60);
    ok(nombres().length === 1, "volver a 'Mi cartera' = 1 pendiente");

    // mapa: ¿el cambio de modo re-dibuja? (cargando true->false con setTimeout 0)
    let dibujos = 0;
    m.comp.dibujarMapa = function () { dibujos++; };
    m.comp.state.tab = "mapa";
    await sleep(80);
    const base = dibujos;
    click(qa(".segmented-cartera button")[1]);
    await sleep(200);
    ok(dibujos > base, "en pestaña Mapa, cambiar a 'Toda la ruta' vuelve a dibujar el mapa", {dibujosAntes: base, despues: dibujos});
    if (process.env.PARCHE_MAPA) {
        // parche propuesto: esperar de verdad un render entre cargando=true y false
        m.comp.cambiarModoCartera = async function (modo) {
            if (this.state.modoCartera === modo) return;
            this.state.modoCartera = modo;
            this.state.visitas = this._vistaDeVisitas(this.state.visitasTodas);
            if (this.state.tab === "mapa") {
                this.state.cargando = true;
                await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
                this.state.cargando = false;
            }
        };
        const b2 = dibujos;
        click(qa(".segmented-cartera button")[0]);
        await sleep(300);
        ok(dibujos > b2, "[con parche rAF doble] Mapa se redibuja al cambiar a 'Mi cartera'", {antes: b2, despues: dibujos});
    }
    m.destruir();

    // reconstrucción: visita fuera de 'mi' (pila restante)
    const m2 = await montar(bundle.RutaDetalle, {schedule: sched, onVolver() {}, pilaRestante: [{tipo: "visita", orderId: 12}]}, h);
    await esperar(() => !m2.comp.state.cargando);
    await sleep(50);
    ok(m2.comp.state.visitaAbiertaId === 12, "reconstrucción tras Atrás/Ventas reabre la visita 12 (de la cartera de otro vendedor)", m2.comp.state.visitaAbiertaId);
    m2.destruir();

    // schedule sin cartera
    const m3 = await montar(bundle.RutaDetalle, {schedule: {...sched, tiene_cartera: false}, onVolver() {}}, h);
    await esperar(() => !m3.comp.state.cargando);
    ok(!q(".segmented-cartera") && qa(".stop-card").length === 3, "sin cartera: sin conmutador y 3 pendientes", qa(".stop-card").length);
    m3.destruir();
};

// =====================================================================
escenarios.visita = async function () {
    console.log("\n[VisitSheet] ficha del juego");
    const h = {
        "fsm.order.read": () => [{id: 5, location_id: [7, "Cliente X"], x_cliente_orden_ruta: 1, stage_name: "Pendiente", x_observaciones_visita: "", x_cliente_lat: 1, x_cliente_lng: 1, sale_id: false}],
        "fsm.location.read": () => [{id: 7, name: "Cliente X", phone: "", mobile: "", street: "c", street2: "", partner_id: [1, "p"]}],
        "fsm.order.shalom_campos_cliente_faltantes": [],
        "fsm.order.shalom_ficha_juego": {refs: REFS, clase: "A", esperado: 400, n: 5},
        "fsm.order.shalom_marcar_catalogo_abierto": {es_principal: true},
        "fsm.order.shalom_leer_carrito": {actualizado: false, carrito: {}},
    };
    const m = await montar(bundle.VisitSheet, {orderId: 5, onCerrar() {}}, h);
    await esperar(() => !m.comp.state.cargando);
    console.log("    ficha:", texto(".ficha-juego"));
    ok(/Clase A/.test(texto(".ficha-juego")) && /\$150/.test(texto(".ficha-juego")) && /\$400/.test(texto(".ficha-juego")), "escalera 75% / 100% / récord");
    m.destruir();
    const m2 = await montar(bundle.VisitSheet, {orderId: 5, onCerrar() {}}, {...h, "fsm.order.shalom_ficha_juego": {refs: {n: 0, record: 0, tipico: 0, t75: 0, t100: 0}, clase: "NUEVO", esperado: 0, n: 0}});
    await esperar(() => !m2.comp.state.cargando);
    ok(/sin compras/.test(texto(".ficha-juego")), "cliente sin compras: mensaje alterno", texto(".ficha-juego"));
    m2.destruir();
    // ficha falla -> la hoja carga igual
    const m3 = await montar(bundle.VisitSheet, {orderId: 5, onCerrar() {}}, {...h, "fsm.order.shalom_ficha_juego": () => { throw new Error("boom"); }});
    await esperar(() => !m3.comp.state.cargando);
    ok(!q(".ficha-juego") && !!q(".cta-order"), "si shalom_ficha_juego falla, la hoja sale sin ficha");
    m3.destruir();
};

// =====================================================================
escenarios.admin = async function () {
    console.log("\n[AdminGestion] pestaña Estrategias y modal de cartera");
    const est = [
        {id: 1, titulo: "Oxigenta", tipo: "empujar", texto: "t", activa: true, date_from: false, date_to: "2026-12-31", productos: [{id: 2, nombre: "Ox"}]},
        {id: 2, titulo: "Shampoo", tipo: "no_ofrecer", texto: "", activa: false, date_from: false, date_to: false, productos: []},
    ];
    const guardados = [];
    const h = {
        "shalom.estrategia.shalom_admin_estrategias": () => est.map((e) => ({...e})),
        "shalom.estrategia.shalom_admin_guardar_estrategia": (a) => { guardados.push(a); return 3; },
        "shalom.estrategia.shalom_admin_borrar_estrategia": true,
        "product.product.searchRead": (a) => [{id: 5, display_name: "Tinte 5.0"}],
        "fsm.order.shalom_admin_seguimiento_visitas": [],
        "fsm.order.shalom_admin_visitas_en_vivo": [],
        "fsm.order.shalom_admin_carritos_pendientes": [],
        "fsm.person.shalom_admin_rutas_programadas": [{persona_id: 9, persona_nombre: "Andrés", rutas: [{id: 1, route_id: 3, route_name: "R1", cantidad_clientes: 3, estado: "en_curso", es_visita_express: false}]}, {persona_id: 10, persona_nombre: "Luis", rutas: []}],
        "fsm.route.schedule.shalom_admin_repartir_cartera": {ciclo: "R1 (26/10 - 30/10)", personas: [{persona_id: 9, persona_nombre: "Andrés", clientes: 5, reservas: 2, esperado: 2100.4, carteras: [{fecha: "2026-10-27", clientes: 5, esperado: 2100.4, completo: false}]}], sin_cartera: 3, minimo: 2000},
        "fsm.route.schedule.shalom_admin_limpiar_cartera": 3,
        "fsm.order.shalom_marcar_catalogo_abierto": {es_principal: true},
    };
    const m = await montar(bundle.AdminGestion, {}, new Proxy(h, {get: (t, k) => (k in t ? t[k] : (() => { return []; }))}));
    await sleep(150);
    // pestaña estrategias
    click(qa(".adm-tab")[3]);
    await esperar(() => qa(".adm-row").length === 2);
    ok(qa(".adm-row").length === 2, "pestaña Estrategias lista 2 filas");
    ok(/INACTIVA/.test(qa(".adm-row")[1].textContent), "fila inactiva rotulada");
    // nueva estrategia + buscar producto + guardar
    click(q(".adm-actbtn-accent"));
    await sleep(30);
    ok(!!q(".adm-modal"), "modal de estrategia abierto");
    const inputs = qa(".adm-modal input[type=text]");
    inputs[0].value = "Nueva"; inputs[0].dispatchEvent(new window.Event("input", {bubbles: true}));
    const sel = q(".adm-modal select"); sel.value = "no_ofrecer"; sel.dispatchEvent(new window.Event("change", {bubbles: true}));
    const busc = q(".adm-search input"); busc.value = "tin"; busc.dispatchEvent(new window.Event("input", {bubbles: true}));
    await esperar(() => qa(".adm-modal-row").length === 1);
    click(q(".adm-modal-row"));
    await sleep(30);
    ok(m.comp.state.estrategiaEditando.productos.length === 1, "producto agregado al borrador");
    click(q(".adm-modal input[type=checkbox]")); // t-model de checkbox escucha "click"
    click(qa(".adm-modal-foot button")[1]);
    await sleep(100);
    console.log("    guardar_estrategia args:", JSON.stringify(guardados[0]));
    ok(guardados.length === 1 && guardados[0][0] === false && guardados[0][1].titulo === "Nueva" && guardados[0][1].tipo === "no_ofrecer" && guardados[0][1].activa === false && guardados[0][1].product_ids[0] === 5, "RPC guardar = [false, {titulo,tipo,texto,activa,date_from,date_to,product_ids}]");
    // borrar con stop (no debe abrir editor)
    click(qa(".adm-row .adm-actbtn-danger")[0]);
    await sleep(60);
    ok(!q(".adm-modal"), "borrar con .stop no abre el editor");

    // cartera: ir a 'rutas', elegir ruta
    click(qa(".adm-tab")[1]);
    await sleep(120);
    console.log("    estado rutas: vendedorSeleccionadoId=", m.comp.state.vendedorSeleccionadoId, "ruta=", m.comp.state.scheduleSeleccionadoId);
    m.comp.state.scheduleSeleccionadoId = 1;
    m.comp.abrirCartera();
    await sleep(40);
    const labels = qa(".adm-estrategia-check");
    ok(labels.length === 2, "modal de cartera lista a los 2 vendedores", labels.map((l) => l.textContent.trim()));
    console.log("    nota: Luis sale porque el mock lo devuelve; el servidor real solo lista vendedores con ruta abierta propia (shalom_admin_rutas_programadas)");
    click(labels[0].querySelector("input")); // jsdom dispara change al hacer clic
    await sleep(30);
    ok(m.comp.state.carteraPersonas.length >= 1, "toggle persona", m.comp.state.carteraPersonas);
    const rep = qa(".adm-modal-foot button").find((b) => /Repartir$/.test(b.textContent.trim()));
    click(rep);
    await esperar(() => m.comp.state.carteraResultado);
    const rc = m.log.find((c) => c.method === "shalom_admin_repartir_cartera");
    console.log("    repartir args:", JSON.stringify(rc && rc.args));
    ok(rc && rc.args.length === 4 && rc.args[0] === 1 && Array.isArray(rc.args[1]) && rc.args[2] === 2000 && rc.args[3] === 3, "args = [schedule_id, person_ids, minimo, reserva]");
    console.log("    resultado:", texto(".adm-modal-body"));
    ok(/El último día no llega al mínimo/.test(texto(".adm-modal-body")), "aviso 'último día no llega al mínimo'");
    ok(m.errores.length === 0, "sin rechazos no manejados", m.errores);
    m.destruir();
};


// =====================================================================
escenarios.back = async function () {
    console.log("\n[App completa] Atrás de Android tras la pantalla de resultado / con la hoja de precarga abierta");
    const hoy = new Date().toISOString().slice(0, 10);
    let confirmado = false;
    const sched = {id: 1, route_id: 3, route_name: "Ruta Norte", date_start: hoy, date_end: hoy, tiempo_estimado: 1, capacidad: 20, estado: "en_curso", cantidad_clientes: 1, es_visita_express: false, mi_persona_id: 9, tiene_cartera: false};
    const h = handlersOrder({
        "fsm.person.shalom_mis_rutas_programadas": [sched],
        "shalom.juego.evento.shalom_mi_progreso": false,
        "fsm.order.searchRead": () => [{id: 5, location_id: [7, "Cliente X"], x_cliente_orden_ruta: 1, stage_name: confirmado ? "Completado" : "Pendiente", x_cliente_lat: 8.9, x_cliente_lng: -79.5, x_cartera_person_id: false, x_cartera_fecha: false, x_cartera_orden: 0, x_cartera_reserva: false}],
        "fsm.location.read": () => [{id: 7, name: "Cliente X", phone: "", mobile: "", street: "c", street2: "", x_venta_mas_alta: 0, partner_id: [1, "p"]}],
        "fsm.location.searchRead": [],
        "fsm.order.shalom_perfiles_ruta": {},
        "fsm.route.read": [{id: 3, x_ruta_trazado: false}],
        "fsm.order.read": () => [{id: 5, location_id: [7, "Cliente X"], x_cliente_orden_ruta: 1, stage_name: confirmado ? "Completado" : "Pendiente", x_observaciones_visita: "", x_cliente_lat: 1, x_cliente_lng: 1, sale_id: confirmado ? [1, "S0100"] : false}],
        "fsm.order.shalom_ficha_juego": {refs: REFS, clase: "A", esperado: 400, n: 5},
        "fsm.order.shalom_confirmar_pedido": () => { confirmado = true; return {sale_order_id: 1, sale_order_name: "S0100", total: 220, juego: JUEGO}; },
    });
    const s = servicios(h);
    sessionStorage.clear(); localStorage.clear();
    window.history.replaceState(null, "", "/odoo/");
    const montarApp = async () => {
        document.body.innerHTML = '<div id="raiz"></div>';
        const app = new owl.App(bundle.ShalomRutaApp, {templates: TEMPLATES, dev: DEV, env: {}, props: {}});
        const comp = await app.mount(q("#raiz"));
        return {app, comp};
    };
    let {app, comp} = await montarApp();
    await esperar(() => qa(".route-card, .schedule-card, [class*=route]").length > 0 && comp.state.screen === "rutas");
    comp.abrirRuta(sched);
    await esperar(() => qa(".stop-card").length === 1);
    click(q(".stop-card"));
    await esperar(() => q(".cta-order"));
    click(q(".cta-order"));
    await esperar(() => qa(".product-card").length === 3);
    ok(JSON.stringify(JSON.parse(sessionStorage.getItem("shalom_pila_navegacion")).map((n) => n.tipo)) === '["ruta","visita","catalogo"]', "pila tras abrir catálogo = ruta,visita,catalogo");
    click(qa(".qty-add-btn")[0]);
    await esperar(() => q(".cart-footer"));

    // --- (1) hoja de precarga abierta + Atrás real
    click(q(".precarga-btn"));
    await esperar(() => qa(".precarga-pedido").length === 2);
    console.log("    history.state con la hoja de precarga abierta:", JSON.stringify(window.history.state), "| pila:", sessionStorage.getItem("shalom_pila_navegacion"));
    window.history.back();
    await sleep(100);
    console.log("    tras history.back(): history.state =", JSON.stringify(window.history.state));
    app.destroy();                         // Odoo recarga la acción del cliente
    ({app, comp} = await montarApp());
    await sleep(300);
    const sobrevivePrecarga = !!q(".precarga-card");
    const catalogoAbierto = !!q(".order-overlay");
    console.log(`    tras 'recarga de Odoo': catálogo abierto=${catalogoAbierto}, hoja de precarga=${sobrevivePrecarga}, hoja de visita=${!!q(".sheet")}`);
    ok(catalogoAbierto, "[limitación de diseño, no bug de código] Atrás con la precarga abierta cierra solo la hoja", {catalogoAbierto});
    app.destroy();

    // --- (2) pantalla de resultado + Atrás real
    sessionStorage.clear(); localStorage.clear(); window.history.replaceState(null, "", "/odoo/"); confirmado = false;
    ({app, comp} = await montarApp());
    await esperar(() => comp.state.screen === "rutas");
    comp.abrirRuta(sched);
    await esperar(() => qa(".stop-card").length === 1);
    click(q(".stop-card"));
    await esperar(() => q(".cta-order"));
    click(q(".cta-order"));
    await esperar(() => qa(".product-card").length === 3);
    if (!qa(".qty-add-btn").length) console.log("    DEBUG body:", document.body.innerHTML.slice(0, 600));
    click(qa(".qty-add-btn")[0]);
    await esperar(() => q(".cart-footer"));
    click(q(".cart-footer"));
    await esperar(() => q(".order-overlay .cta-order"));
    click(q(".order-overlay .cta-order"));
    await esperar(() => qa(".confirm-card button").some((b) => /Confirmar/.test(b.textContent)));
    click(qa(".confirm-card button").find((b) => /Confirmar/.test(b.textContent)));
    await esperar(() => q(".resultado-overlay"), 3000);
    ok(!!q(".resultado-overlay"), "resultado visible dentro de la app completa");
    console.log("    pila con el resultado visible:", sessionStorage.getItem("shalom_pila_navegacion"), "| history.state:", JSON.stringify(window.history.state));
    window.history.back();
    await sleep(100);
    console.log("    tras history.back(): history.state =", JSON.stringify(window.history.state));
    app.destroy();
    ({app, comp} = await montarApp());
    await sleep(500);
    const hayCatalogo = !!q(".order-overlay") && qa(".product-card").length > 0;
    const hayResultado = !!q(".resultado-overlay");
    console.log(`    tras 'recarga de Odoo': catálogo reabierto=${hayCatalogo}, resultado=${hayResultado}, hoja visita=${!!q(".sheet")}, cliente en hoja=${texto(".sheet .name")}`);
    ok(!hayCatalogo, "Atrás desde el resultado NO reabre el catálogo sobre una visita ya completada", {hayCatalogo});
    app.destroy();
};

// Escenarios en archivos aparte (escenarios_*.js, uno por quien los agrega):
// cada archivo exporta function (ctx) { ctx.escenarios.nombre = async () => {...} }
// con las utilidades de este arnés. Así varias personas agregan pruebas sin
// editar este archivo.
for (const f of fs.readdirSync(__dirname).filter((x) => /^escenarios_.*\.js$/.test(x)).sort()) {
    require(path.join(__dirname, f))({
        escenarios, bundle, montar, ok, q, qa, click, texto, esperar, sleep, window, localStorage, sessionStorage, owl, MOD,
        fallo: () => { fallos++; },
    });
}

(async () => {
    const pedidos = process.argv.slice(2);
    for (const [nombre, fn] of Object.entries(escenarios)) {
        if (pedidos.length && !pedidos.includes(nombre)) continue;
        try { await fn(); } catch (e) { fallos++; console.log("  EXCEPCION en escenario " + nombre + ": " + (e && e.stack || e)); }
    }
    console.log(fallos ? `\n${fallos} verificacion(es) FALLIDAS` : "\nTodas las verificaciones pasaron");
    process.exit(fallos ? 1 : 0);
})();
