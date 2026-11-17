// Políticas del dueño: el % de margen solo lo ve el administrador.
module.exports = (ctx) => {
    const {escenarios, bundle, montar, handlersOrder, ok, q, qa, click, esperar, sleep, window, tarjeta, botonAgregar} = ctx;
    escenarios.margen_solo_admin = async function () {
        console.log("\n[OrderScreen] margen visible solo para el administrador");
        for (const sinMargen of [true, false]) {
            window.__sinMargen = sinMargen;
            const m = await montar(bundle.OrderScreen, {orderId: 5, clienteNombre: "Cliente X", onCerrar() {}, onConfirmado() {}}, handlersOrder({}));
            await esperar(() => !m.comp.state.cargando && qa(".product-card").length > 0);
            click(botonAgregar(1));
            await esperar(() => q(".medidor"), 3000);
            await sleep(500);
            const pill = q(".medidor-margen");
            if (sinMargen) ok(!pill, "vendedor: no hay etiqueta de margen en el medidor");
            // Catálogo compacto: la etiqueta muestra solo "35%" (el título dice "Margen del pedido").
            else ok(!!pill && /^\s*35%\s*$/.test(pill.textContent) && /Margen/.test(pill.getAttribute("title") || ""), "administrador: ve el margen (35%)", pill && pill.textContent);
            ok(!!q(".medidor-estrellas"), "las estrellas se muestran en ambos casos");
            m.destruir();
        }
        window.__sinMargen = false;
    };
};
