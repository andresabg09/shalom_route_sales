/*
 * Escenarios del modo offline (Fase 0: velocidad y tolerancia a mala señal).
 * Se cargan solos desde simular.js (escenarios_*.js). Uso:
 *   node simular.js offline_fotos offline_carrito_reintento offline_sin_red
 */
module.exports = (ctx) => {
    const {escenarios, bundle, montar, handlersOrder, ok, q, qa, click, esperar, sleep, window} = ctx;

    // Node 22 trae su propio `navigator` global (el código del bundle ve
    // ése, no el de jsdom): se fija en los dos.
    const fijarOnLine = (valor) => {
        for (const nav of [window.navigator, globalThis.navigator]) {
            if (nav) {
                Object.defineProperty(nav, "onLine", {value: valor, configurable: true});
            }
        }
    };

    async function montarCatalogo(extra = {}) {
        const m = await montar(bundle.OrderScreen, {
            orderId: 5, clienteNombre: "Cliente X", onCerrar: () => {}, onConfirmado: () => {},
        }, handlersOrder(extra));
        await esperar(() => !m.comp.state.cargando && qa(".product-card").length === 3);
        return m;
    }

    // -----------------------------------------------------------------
    escenarios.offline_fotos = async function () {
        console.log("\n[Offline F0] fotos del catálogo livianas y cacheables");
        fijarOnLine(true);
        const m = await montarCatalogo();
        const img = q(".product-card .product-thumb");
        const src = img && img.getAttribute("src");
        ok(/\/image_512\?unique=\d{4}-\d{2}-\d{2}$/.test(src || ""), "tarjeta pide image_512 con unique=<fecha>", src);
        ok(img && img.getAttribute("loading") === "lazy", "tarjeta con loading=lazy");
        // reintento conserva unique y agrega _r
        img.dispatchEvent(new window.Event("error"));
        await sleep(800);
        const src2 = img.getAttribute("src");
        ok(/image_512\?unique=[\d-]+&_r=\d+$/.test(src2 || ""), "reintento conserva unique y agrega _r", src2);
        m.comp.abrirFoto(m.comp.state.productos ? m.comp.state.productos[0] : {id: 1, name: "x"});
        ok(/image_1024\?unique=/.test((m.comp.state.fotoAmpliada || {}).url || ""), "foto ampliada pide image_1024 (solo al abrirla)", m.comp.state.fotoAmpliada);
        m.destruir();
    };

    // -----------------------------------------------------------------
    escenarios.offline_carrito_reintento = async function () {
        console.log("\n[Offline F0] si falla el envío del carrito, los cambios no se pierden");
        fijarOnLine(true);
        let fallar = true;
        let srv = {};
        const m = await montarCatalogo({
            "fsm.order.shalom_actualizar_carrito": (a) => {
                if (fallar) {
                    throw new Error("sin señal");
                }
                Object.assign(srv, a[1] || {});
                for (const k of a[2] || []) delete srv[String(k)];
                return {actualizado: "2026-01-01 10:00:01", carrito: JSON.parse(JSON.stringify(srv))};
            },
        });
        const {comp, log} = m;
        click(qa(".qty-add-btn")[0]);
        await esperar(() => comp.cantidadItems === 1);
        // primer envío falla
        await esperar(() => log.some((c) => c.method === "shalom_actualizar_carrito"), 3000);
        await sleep(50);
        ok(Object.keys(comp._cambiosPendientes).includes("1"), "tras fallar, el producto vuelve a pendientes", Object.keys(comp._cambiosPendientes));
        // vuelve la señal: el siguiente intento (con backoff ~2 s) lo manda
        fallar = false;
        await esperar(() => srv["1"], 6000);
        ok(srv["1"] && srv["1"].cantidad === 1, "con señal, el respaldo del servidor recibe el producto", srv);
        ok(Object.keys(comp._cambiosPendientes).length === 0, "sin pendientes tras el envío exitoso");

        // un cambio hecho DURANTE la falla no se pisa con el valor viejo
        comp._devolverPendientes({"1": {cantidad: 1}}, []);
        comp._cambiosPendientes = {"1": {cantidad: 5}};
        comp._devolverPendientes({"1": {cantidad: 1}}, ["2"]);
        ok(comp._cambiosPendientes["1"].cantidad === 5, "el valor local más nuevo gana sobre el envío fallido");
        ok(comp._eliminadosPendientes.has("2"), "los borrados fallidos vuelven a pendientes");
        comp._cambiosPendientes = {};
        comp._eliminadosPendientes = new Set();
        ok(m.errores.length === 0, "sin rechazos no manejados", m.errores);
        m.destruir();
    };

    // -----------------------------------------------------------------
    escenarios.offline_sin_red = async function () {
        console.log("\n[Offline F0] modo avión: el catálogo no golpea la red y retoma al volver");
        fijarOnLine(true);
        const m = await montarCatalogo();
        const {log} = m;
        const latidos = () => log.filter((c) => c.method === "shalom_marcar_catalogo_abierto").length;
        await esperar(() => latidos() >= 1, 2500);
        ok(latidos() >= 1, "con señal hay latido del catálogo");
        fijarOnLine(false);
        await sleep(1200);
        const base = latidos();
        await sleep(2500);
        ok(latidos() === base, "sin red: 0 latidos en 2.5 s", latidos() - base);
        fijarOnLine(true);
        window.dispatchEvent(new window.Event("online"));
        await esperar(() => latidos() > base, 1000);
        ok(latidos() > base, "al volver la red, late de inmediato");
        ok(m.errores.length === 0, "sin rechazos no manejados", m.errores);
        m.destruir();
    };
};
