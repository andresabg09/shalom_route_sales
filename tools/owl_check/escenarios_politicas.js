// Políticas del dueño: el % de margen solo lo ve el administrador.
module.exports = (ctx) => {
    const {escenarios, bundle, montar, handlersOrder, ok, q, qa, click, esperar, sleep, window} = ctx;
    escenarios.margen_solo_admin = async function () {
        console.log("\n[OrderScreen] margen visible solo para el administrador");
        for (const sinMargen of [true, false]) {
            window.__sinMargen = sinMargen;
            const m = await montar(bundle.OrderScreen, {orderId: 5, clienteNombre: "Cliente X", onCerrar() {}, onConfirmado() {}}, handlersOrder({}));
            await esperar(() => !m.comp.state.cargando && qa(".product-card").length > 0);
            click(qa(".qty-add-btn")[0]);
            await esperar(() => q(".medidor"), 3000);
            await sleep(500);
            const pill = q(".medidor-margen");
            if (sinMargen) ok(!pill, "vendedor: no hay etiqueta de margen en el medidor");
            else ok(!!pill && /Margen 35%/.test(pill.textContent), "administrador: ve 'Margen 35%'", pill && pill.textContent);
            ok(!!q(".medidor-estrellas"), "las estrellas se muestran en ambos casos");
            m.destruir();
        }
        window.__sinMargen = false;
    };
};
