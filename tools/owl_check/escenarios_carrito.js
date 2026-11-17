/*
 * Catálogo y carrito: orden del carrito, lista/cuadrícula, zoom desde el
 * carrito, fotos con versión, "Con stock" con Nevada, volver a la misma
 * página tras un Atrás real y cabecera que no salta.
 * Uso: node simular.js carrito_orden_y_vistas carrito_con_stock_nevada ...
 */
module.exports = (ctx) => {
    const {escenarios, bundle, montar, handlersOrder, ok, q, qa, click, esperar, sleep, window} = ctx;

    const fijarOnLine = (valor) => {
        for (const nav of [window.navigator, globalThis.navigator]) {
            if (nav) {
                Object.defineProperty(nav, "onLine", {value: valor, configurable: true});
            }
        }
    };
    const MARCAS = {"fsm.order.shalom_marcas_fotos": (a) => Object.fromEntries(a[0].map((id) => [id, "V" + id]))};

    async function catalogo(extra = {}, props = {}) {
        fijarOnLine(true);
        const m = await montar(bundle.OrderScreen, {
            orderId: 5, clienteNombre: "Cliente X", onCerrar: () => {}, onConfirmado: () => {}, ...props,
        }, handlersOrder({...MARCAS, ...extra}));
        await esperar(() => !m.comp.state.cargando && qa(".product-card").length >= 1);
        return m;
    }
    const agregar = async (comp, id) => {
        comp.agregarProducto(comp.state.productos.find((p) => p.id === id));
        await sleep(5);
    };

    escenarios.carrito_orden_y_vistas = async function () {
        console.log("\n[Carrito] en el orden en que se agregó, lista/cuadrícula y zoom de la foto");
        const m = await catalogo();
        const {comp} = m;
        await agregar(comp, 3);
        await agregar(comp, 1);
        await agregar(comp, 2);
        comp.cambiarCantidad(3, 4); // cambiar la cantidad no lo mueve de lugar
        ok(comp.itemsCarrito.map((i) => i.producto.id).join() === "3,1,2", "arriba el primero que se agregó, abajo el último", comp.itemsCarrito.map((i) => i.producto.id));
        // vuelta desde el servidor (otro dispositivo / recarga): conserva el orden
        const servidor = {};
        for (const [k, item] of Object.entries(comp.state.carrito)) {
            servidor[k] = JSON.parse(JSON.stringify(comp._lineaParaServidor(item)));
        }
        comp._aplicarCarritoServidor(servidor);
        ok(comp.itemsCarrito.map((i) => i.producto.id).join() === "3,1,2", "el orden se conserva al volver del servidor", comp.itemsCarrito.map((i) => i.producto.id));
        ok(comp.state.carrito[1].producto.foto_v === "V1", "la línea que vuelve del servidor usa el producto del catálogo (con versión de foto)");
        // línea vieja sin "orden" (guardada antes del cambio): queda arriba
        servidor["9"] = {product_id: 9, name: "Viejo", list_price: 1, cantidad: 1, es_recompensa: false, regla_id: false};
        comp._aplicarCarritoServidor(servidor);
        ok(comp.itemsCarrito[0].producto.id === 9, "una línea guardada antes del cambio queda arriba");
        delete comp.state.carrito[9];

        comp.irACarrito();
        await esperar(() => q(".cart-list"));
        const nombres = qa(".cart-line .name").map((n) => n.textContent.trim());
        ok(/Shampoo/.test(nombres[0]) && /Tinte/.test(nombres[1]) && /Oxigenta/.test(nombres[2]), "la pantalla del carrito muestra ese orden", nombres);
        const fotos = qa(".cart-line img.product-thumb").map((i) => i.getAttribute("src"));
        ok(fotos.every((u) => /image_512\?unique=V\d$/.test(u)), "las fotos del carrito usan la foto guardada (con versión)", fotos);
        comp.cambiarVistaCatalogo("lista");
        await sleep(20);
        ok(q(".cart-list").classList.contains("vista-lista") && q(".carrito-barra .vista-toggle"), "carrito en lista, con el botón lista/cuadrícula");
        click(qa(".carrito-barra .vista-toggle button")[1]);
        await sleep(20);
        ok(q(".cart-list").classList.contains("vista-cuadricula") && comp.state.vistaCatalogo === "cuadricula", "el botón pasa el carrito a cuadrícula (y vale para el catálogo)");
        click(q(".cart-line .product-thumb-wrap"));
        await sleep(20);
        const foto = comp.state.fotoAmpliada;
        ok(foto && /\/3\/image_512\?unique=V3$/.test(foto.url) && /image_1024\?unique=V3$/.test(foto.urlMedia), "tocar la foto en el carrito la abre en grande (512 al instante, mejora a 1024)", foto);
        comp.cerrarFoto();
        // Pedidos anteriores: misma foto guardada, no una miniatura aparte
        ok(/\/1\/image_512\?unique=V1$/.test(comp.imagenPrecarga({product_id: 1})), "Pedidos anteriores usa la foto guardada", comp.imagenPrecarga({product_id: 1}));
        if (process.env.SHALOM_VOLCADO_CARRITO) {
            for (const item of Object.values(comp.state.carrito)) item.cantidad = 9999;
            await sleep(30);
            const fs = require("fs");
            fs.writeFileSync(process.env.SHALOM_VOLCADO_CARRITO + "_carrito.html", document.body.innerHTML);
            comp.irACatalogo();
            await esperar(() => q(".catalog-list"));
            comp.cambiarVistaCatalogo("cuadricula");
            await sleep(40);
            fs.writeFileSync(process.env.SHALOM_VOLCADO_CARRITO + "_catalogo.html", document.body.innerHTML);
            console.log("    volcado en", process.env.SHALOM_VOLCADO_CARRITO + "_*.html");
        }
        m.destruir();
    };

    escenarios.carrito_con_stock_nevada = async function () {
        console.log("\n[Catálogo] 'Con stock': Dianke o Nevada");
        const m = await catalogo({
            "fsm.order.shalom_existencias_bodegas": (a) => Object.fromEntries(a[0].map((id) => [id, {
                dianke: {1: 40, 2: 0, 3: 0}[id], nevada: {1: 0, 2: 0, 3: 15}[id], bulto: 0,
            }])),
        });
        const {comp} = m;
        comp.toggleSoloConStock();
        await sleep(20);
        const ids = comp.productosFiltrados.map((p) => p.id).sort().join();
        ok(ids === "1,3", "entra lo que tiene Dianke y lo que solo tiene Nevada; sale lo que no tiene en ninguna", ids);
        ok(comp.productosParaCategorias.map((p) => p.id).sort().join() === "1,3", "el menú de categorías usa el mismo criterio");
        ok(comp.tieneStock({free_qty: 3}) && !comp.tieneStock({free_qty: 0}), "sin datos por bodega: el stock libre de siempre");
        m.destruir();
    };

    escenarios.catalogo_atras_conserva_pagina = async function () {
        console.log("\n[Catálogo] Atrás real (Odoo recarga): misma página, filtros y scroll");
        const muchos = Array.from({length: 130}, (_, i) => ({
            id: i + 1, name: `Producto ${String(i + 1).padStart(3, "0")}`, list_price: 5, barcode: "", default_code: "",
            qty_available: 10, free_qty: 10, categ_id: [1, "Tintes"],
        }));
        const extra = {
            "product.product.searchRead": () => muchos.map((p) => ({...p})),
            "fsm.order.shalom_existencias_bodegas": (a) => Object.fromEntries(a[0].map((id) => [id, {dianke: 10, nevada: 0, bulto: 0}])),
        };
        const m = await catalogo(extra);
        const {comp} = m;
        comp.state.busqueda = "producto";
        comp.toggleSoloConStock();
        comp.paginaSiguiente();
        await sleep(30);
        const lista = q(".catalog-list");
        lista.scrollTop = 420;
        comp.onScrollCatalogo({currentTarget: {scrollTop: 420, scrollHeight: 4000, clientHeight: 700}});
        await sleep(300);
        const pagina = comp.state.paginaActual;
        ok(pagina === 2, "estaba en la página 2", pagina);
        comp.abrirFoto(comp.productosPaginados[0]);
        // Atrás real: Odoo desmonta y vuelve a montar la app desde cero
        m.destruir();
        globalThis.__conservarSesion = true;
        globalThis.__conservarAlmacen = true;
        let m2;
        try {
            m2 = await catalogo(extra);
        } finally {
            globalThis.__conservarSesion = false;
            globalThis.__conservarAlmacen = false;
        }
        await sleep(60);
        const c2 = m2.comp;
        ok(!c2.state.fotoAmpliada, "la foto quedó cerrada");
        ok(c2.state.paginaActual === 2 && c2.state.busqueda === "producto" && c2.state.soloConStock, "misma página y mismos filtros", [c2.state.paginaActual, c2.state.busqueda, c2.state.soloConStock]);
        ok(c2._scrollPendiente === 0 && q(".catalog-list").scrollTop === 420, "vuelve al mismo lugar de la lista", q(".catalog-list").scrollTop);
        // cerrar el catálogo con su propio botón: la próxima vez arranca de cero
        c2.cerrarDeVerdad();
        ok(!window.sessionStorage.getItem("shalom_catalogo_donde_5"), "al cerrar el catálogo se olvida la posición");
        m2.destruir();
    };

    escenarios.catalogo_cabecera_sin_saltos = async function () {
        console.log("\n[Catálogo] la cabecera no aparece y desaparece con movimientos chicos");
        const m = await catalogo();
        const {comp} = m;
        const lista = {scrollTop: 0, scrollHeight: 5000, clientHeight: 700};
        const ir = (y) => { lista.scrollTop = y; comp.onScrollCatalogo({currentTarget: lista}); };
        comp._altoCabecera = 120;
        ir(300);
        ok(comp.state.cabeceraOculta, "bajar un buen trecho la esconde");
        comp._pausaCabeceraHasta = 0;
        ir(280); ir(300); ir(270); ir(290);
        ok(comp.state.cabeceraOculta, "subir y bajar un poco (mirar algo) NO la hace aparecer");
        ir(260); ir(230);
        ok(comp.state.cabeceraOculta, "subir 60 px todavía no");
        ir(200);
        ok(!comp.state.cabeceraOculta, "subir un trecho seguido sí la muestra");
        comp._pausaCabeceraHasta = 0;
        ir(220); ir(240);
        ok(!comp.state.cabeceraOculta, "bajar 40 px no la vuelve a esconder");
        ir(100);
        ok(!comp.state.cabeceraOculta, "arriba del todo siempre visible");
        m.destruir();
    };
};
