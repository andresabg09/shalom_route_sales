/*
 * Escenarios del modo offline (Fase 0: velocidad y tolerancia a mala señal).
 * Se cargan solos desde simular.js (escenarios_*.js). Uso:
 *   node simular.js offline_fotos offline_carrito_reintento offline_sin_red
 */
module.exports = (ctx) => {
    const {escenarios, bundle, montar, handlersOrder, ok, q, qa, click, esperar, sleep, window, tarjeta, botonAgregar} = ctx;

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
        const img = tarjeta(1).querySelector(".product-thumb");
        const src = img && img.getAttribute("src");
        ok(/\/image_512\?unique=\d{4}-\d{2}-\d{2}$/.test(src || ""), "tarjeta pide image_512 con unique=<fecha>", src);
        ok(img && img.getAttribute("loading") === "lazy", "tarjeta con loading=lazy");
        // reintento conserva unique y agrega _r
        img.dispatchEvent(new window.Event("error"));
        await sleep(800);
        const src2 = img.getAttribute("src");
        ok(/image_512\?unique=[\d-]+&_r=\d+$/.test(src2 || ""), "reintento conserva unique y agrega _r", src2);
        m.comp.abrirFoto(m.comp.state.productos ? m.comp.state.productos[0] : {id: 1, name: "x"});
        ok(/image_512\?unique=/.test((m.comp.state.fotoAmpliada || {}).url || ""), "foto ampliada abre con la de 512 px de la tarjeta (ya guardada)", m.comp.state.fotoAmpliada);
        m.comp.cerrarFoto();
        m.destruir();
    };

    // -----------------------------------------------------------------
    // Foto ampliada progresiva: 512 al instante, 1024 por detrás, 1920 al
    // acercar; nunca el nombre del producto en lugar de la foto.
    // -----------------------------------------------------------------
    escenarios.offline_foto_ampliada = async function () {
        console.log("\n[Fotos] foto ampliada: al instante con la guardada y mejora sola por internet");
        fijarOnLine(true);
        const ImageReal = globalThis.Image;
        const pedidas = [];
        globalThis.Image = class {
            constructor() { pedidas.push(this); }
            set src(v) { this._src = v; }
            get src() { return this._src; }
        };
        try {
            const m = await montar(bundle.OrderScreen, {
                orderId: 5, clienteNombre: "Cliente X", onCerrar: () => {}, onConfirmado: () => {},
            }, handlersOrder({
                "fsm.order.shalom_marcas_fotos": (a) => Object.fromEntries(a[0].map((id) => [id, "20261101093000"])),
            }));
            await esperar(() => !m.comp.state.cargando && qa(".product-card").length === 3);
            const fotoTarjeta = tarjeta(1).querySelector(".product-thumb").getAttribute("src");
            m.comp.abrirFoto(m.comp.state.productos.find((p) => p.id === 1));
            await sleep(30);
            const img = q(".foto-ampliada-lienzo img");
            ok(img && img.getAttribute("src") === fotoTarjeta, "abre con la MISMA foto de la tarjeta (sin esperar red)", [img && img.getAttribute("src"), fotoTarjeta]);
            ok(img && img.getAttribute("alt") === "", "el nombre nunca va en el lugar de la foto (alt vacío)");
            const media = pedidas.find((i) => /image_1024\?unique=20261101093000$/.test(i.src));
            ok(!!media, "pide la de 1024 px por detrás, con versión (queda en caché)", pedidas.map((i) => i.src));
            ok(/image_512/.test(m.comp.state.fotoAmpliada.url), "hasta que no carga, se sigue viendo la de 512 px");
            media.onload();
            await sleep(30);
            ok(/image_1024/.test(q(".foto-ampliada-lienzo img").getAttribute("src")), "cuando cargó, cambia a la de 1024 px");
            // acercar: pide la original con versión
            m.comp._zoom.escala = 2;
            m.comp._aplicarZoom();
            const grande = pedidas.find((i) => /image_1920\?unique=20261101093000$/.test(i.src));
            ok(!!grande, "al acercar pide la original (1920 px) con versión", pedidas.map((i) => i.src));
            grande.onerror && grande.onerror();
            await sleep(20);
            ok(/image_1024/.test(m.comp.state.fotoAmpliada.url), "si la original no carga, se queda la que se ve");
            // la que se ve falla (se borró de la caché): vuelve a la de 512
            q(".foto-ampliada-lienzo img").dispatchEvent(new window.Event("error"));
            await sleep(20);
            ok(/image_512/.test(m.comp.state.fotoAmpliada.url), "si falla la mejor, vuelve a la de 512 px");
            q(".foto-ampliada-lienzo img").dispatchEvent(new window.Event("error"));
            await sleep(20);
            ok(/image_256/.test(m.comp.state.fotoAmpliada.url), "si falla la de 512, prueba la miniatura");
            fijarOnLine(false);
            q(".foto-ampliada-lienzo img").dispatchEvent(new window.Event("error"));
            await sleep(30);
            const aviso = q(".foto-ampliada-lienzo .foto-ampliada-ayuda");
            ok(aviso && /cuando haya señal/.test(aviso.textContent) && !q(".foto-ampliada-lienzo img"), "sin ninguna foto: aviso, no el nombre", aviso && aviso.textContent);
            m.comp.cerrarFoto();
            // sin señal: abre con la guardada y no pide nada más
            const antes = pedidas.length;
            m.comp.abrirFoto(m.comp.state.productos.find((p) => p.id === 2));
            await sleep(20);
            ok(pedidas.length === antes && /image_512/.test(q(".foto-ampliada-lienzo img").getAttribute("src")), "sin señal: muestra la guardada y no intenta bajar más");
            m.comp.cerrarFoto();
            m.destruir();
        } finally {
            globalThis.Image = ImageReal;
            fijarOnLine(true);
        }
    };

    // -----------------------------------------------------------------
    // Fotos guardadas en el teléfono (Cache Storage): no se bajan dos veces
    // y se borran las versiones viejas.
    // -----------------------------------------------------------------
    escenarios.offline_fotos_en_telefono = async function () {
        console.log("\n[Fotos] guardadas en el teléfono: no se repiten y se limpia lo viejo");
        fijarOnLine(true);
        const guardado = new Map();
        const bajadas = [];
        const cacheFalsa = {
            match: async (u) => guardado.get(typeof u === "string" ? u : u.url),
            put: async (u, r) => { guardado.set(u, r); },
            keys: async () => [...guardado.keys()].map((url) => ({url})),
            delete: async (pedido) => guardado.delete(pedido.url),
        };
        const cachesReal = globalThis.caches;
        const fetchReal = globalThis.fetch;
        let borradaToda = false;
        globalThis.caches = {open: async () => cacheFalsa, delete: async () => { borradaToda = true; guardado.clear(); return true; }};
        globalThis.fetch = async (url) => {
            bajadas.push(url);
            return {status: 200, headers: {get: () => "image/jpeg"}};
        };
        try {
            const productos = [{id: 1, foto_v: "A1"}, {id: 2, foto_v: "B1"}];
            await bundle.precargarFotos(productos);
            ok(bajadas.length === 2 && guardado.size === 2, "primera vez: baja y guarda cada foto", bajadas);
            ok([...guardado.keys()].every((k) => /\/web\/image\/product\.product\/\d\/image_512\?unique=(A1|B1)$/.test(k)), "misma URL que las tarjetas del catálogo", [...guardado.keys()]);
            await bundle.precargarFotos(productos);
            ok(bajadas.length === 2, "segunda vez: no se baja nada (ya están en el teléfono)", bajadas.length);
            // cambia la foto del producto 1 y el 2 sale del catálogo
            const nuevos = [{id: 1, foto_v: "A2"}];
            await bundle.precargarFotos(nuevos);
            const borradas = await bundle.limpiarFotosViejas(nuevos);
            ok(borradas === 2 && guardado.size === 1 && /unique=A2$/.test([...guardado.keys()][0]), "borra la versión vieja y la del producto que ya no está", [...guardado.keys()]);
            ok((await bundle.limpiarFotosViejas([{id: 1}])) === 0 && guardado.size === 1, "sin versiones de fotos no borra nada (no sabe cuáles son las vigentes)");
            await bundle.borrarDatosDescargados();
            ok(borradaToda, "'Borrar datos descargados' también borra las fotos");
        } finally {
            globalThis.caches = cachesReal;
            globalThis.fetch = fetchReal;
        }
    };

    escenarios.offline_fotos_automaticas = async function () {
        console.log("\n[Fotos] se bajan solas, sin abrir el catálogo ni marcar nada");
        fijarOnLine(true);
        const guardado = new Map();
        const bajadas = [];
        const cacheFalsa = {
            match: async (u) => guardado.get(typeof u === "string" ? u : u.url),
            put: async (u, r) => { guardado.set(u, r); },
            keys: async () => [...guardado.keys()].map((url) => ({url})),
            delete: async (pedido) => guardado.delete(pedido.url),
        };
        const cachesReal = globalThis.caches;
        const fetchReal = globalThis.fetch;
        globalThis.caches = {open: async () => cacheFalsa, delete: async () => true};
        globalThis.fetch = async (url) => {
            bajadas.push(url);
            return {status: 200, headers: {get: () => "image/jpeg"}};
        };
        try {
            const productos = [1, 2, 3, 4, 5].map((id) => ({id, foto_v: "abcdef012345678" + id, stock_dianke: id === 5 ? 3 : 0, stock_nevada: 0}));
            productos.push({id: 6, foto_v: "20261101093000"}); // versión vieja (por fecha): no se baja
            await bundle.completarFotos(productos);
            ok(bajadas.length === 5 && guardado.size === 5, "baja todas las fotos con versión vigente", bajadas.length);
            ok(/\/5\/image_512/.test(bajadas[0]), "primero los productos con existencias", bajadas[0]);
            ok(bundle.estadoOffline.fotosGuardadas === 5 && bundle.estadoOffline.fotosTotal === 5, "el panel cuenta 5 de 5", [bundle.estadoOffline.fotosGuardadas, bundle.estadoOffline.fotosTotal]);
            ok(bundle.estadoOffline.fotosEn, "queda marcado 'fotos al día'");
            await bundle.completarFotos(productos);
            ok(bajadas.length === 5, "otra vez: no repite lo que ya está");
            // una nueva foto: baja solo esa; dos disparos a la vez no duplican
            const mas = productos.concat([{id: 7, foto_v: "abcdef0123456787"}]);
            await Promise.all([bundle.completarFotos(mas), bundle.completarFotos(mas)]);
            ok(bajadas.length === 6 && guardado.size === 6, "solo baja la que falta, sin duplicar", bajadas.length);
            // sin señal: se pausa
            fijarOnLine(false);
            const sinSenal = mas.concat([{id: 8, foto_v: "abcdef0123456788"}]);
            await bundle.completarFotos(sinSenal);
            ok(bajadas.length === 6, "sin señal no baja nada (queda pendiente)");
            fijarOnLine(true);
            await bundle.completarFotos(sinSenal);
            ok(bajadas.length === 7 && bundle.estadoOffline.fotosGuardadas === 7, "con señal retoma las pendientes", bajadas.length);
        } finally {
            globalThis.caches = cachesReal;
            globalThis.fetch = fetchReal;
        }
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
        click(botonAgregar(1));
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

    // -----------------------------------------------------------------
    // Fase 3: pedido sin señal queda en la cola y se envía después
    // -----------------------------------------------------------------
    async function catalogoConUnProducto(extra = {}) {
        fijarOnLine(true);
        let confirmado = 0;
        let cerrado = 0;
        const m = await montar(bundle.OrderScreen, {
            orderId: 5, clienteNombre: "Cliente X",
            onCerrar: () => { cerrado++; }, onConfirmado: () => { confirmado++; },
        }, handlersOrder(extra));
        await esperar(() => !m.comp.state.cargando && qa(".product-card").length === 3);
        click(botonAgregar(1));
        await esperar(() => m.comp.cantidadItems === 1);
        m.comp.state.formaPagoSeleccionada = "cash";
        return {m, confirmados: () => confirmado, cerrados: () => cerrado};
    }

    escenarios.offline_pedido_sin_senal = async function () {
        console.log("\n[Offline F3] confirmar sin señal: queda en el teléfono y se envía al volver");
        let red = false;
        const enviados = [];
        const {m, confirmados, cerrados} = await catalogoConUnProducto({
            "shalom.sync.evento.shalom_procesar_lote": (a) => {
                if (!red) {
                    throw new Error("sin señal");
                }
                enviados.push(...a[0]);
                return a[0].map((ev) => ({uuid: ev.uuid, estado: "ok", resultado: {sale_order_id: 9, sale_order_name: "S0009", total: 10, juego: null}}));
            },
        });
        const cola = bundle.estadoOffline.cola;
        await m.comp._confirmarPedidoDeVerdad();
        ok(cola.length === 1 && cola[0].tipo === "confirmar_pedido", "el pedido quedó en la cola del teléfono", cola.map((i) => i.tipo));
        const linea = cola[0] && cola[0].datos.lineas[0];
        ok(linea && linea.precio_visita === 10 && linea.qty === 1, "lleva el precio de la visita", linea);
        ok(cola[0] && cola[0].datos.payment_method === "cash" && cola[0].datos.order_id === 5, "con forma de pago y visita");
        ok(m.notas.some((n) => /GUARDADO EN EL TELÉFONO/.test(n.msg)), "avisa que quedó guardado en el teléfono");
        ok(confirmados() === 1 && cerrados() === 1, "el vendedor sigue: la hoja se entera y el catálogo se cierra");
        const local = bundle.estadoLocalDeVisita(5);
        ok(local && local.porEnviar && local.pedidoPendiente && local.estado === "completado", "la visita se ve Completada (por enviar)", local);
        // vuelve la señal
        red = true;
        await bundle.enviarPendientes();
        ok(enviados.length === 1, "al volver la señal se envía una sola vez", enviados.length);
        ok(bundle.estadoOffline.cola.length === 0, "la cola queda vacía");
        ok(bundle.estadoLocalDeVisita(5) === null, "la visita ya no está 'por enviar'");
        m.destruir();
    };

    escenarios.offline_pedido_rechazado = async function () {
        console.log("\n[Offline F3] confirmar con señal y el servidor lo rechaza: error en el momento, carrito intacto");
        const {m, cerrados} = await catalogoConUnProducto({
            "fsm.order.shalom_confirmar_pedido": () => { throw new Error("Elegí una forma de pago"); },
        });
        await m.comp._confirmarPedidoDeVerdad();
        ok(m.notas.some((n) => n.tipo === "danger" && /forma de pago/.test(n.msg)), "muestra el motivo del servidor", m.notas);
        ok(bundle.estadoOffline.cola.length === 0, "no queda nada colgado en la cola");
        ok(cerrados() === 0 && m.comp.cantidadItems === 1, "el catálogo sigue abierto con el carrito");
        m.destruir();
    };

    escenarios.offline_pedido_con_senal = async function () {
        console.log("\n[Offline F3] confirmar con señal: igual que antes (resultado del juego)");
        const {m, confirmados} = await catalogoConUnProducto();
        await m.comp._confirmarPedidoDeVerdad();
        ok(confirmados() === 1, "onConfirmado");
        ok(!!m.comp.state.resultadoJuego, "se muestra la pantalla de resultado");
        ok(m.log.some((c) => c.method === "shalom_confirmar_pedido" && c.viaCola), "pasó por la cola");
        ok(bundle.estadoOffline.cola.length === 0, "cola vacía");
        m.destruir();
    };

    escenarios.offline_descartar_registra = async function () {
        console.log("\n[Offline F1/F3] 'Salir sin guardar' manda la copia del carrito al registro");
        let lote = null;
        const {m} = await catalogoConUnProducto({
            "shalom.sync.evento.shalom_procesar_lote": (a) => { lote = a[0]; return a[0].map((ev) => ({uuid: ev.uuid, estado: "ok", resultado: {}})); },
        });
        m.comp.confirmarSalirSinGuardar();
        await esperar(() => lote, 2000);
        const ev = lote && lote[0];
        ok(ev && ev.tipo === "descartar_carrito" && ev.datos.order_id === 5, "evento descartar_carrito de la visita", ev);
        const item = ev && Object.values(ev.datos.carrito)[0];
        ok(item && item.cantidad === 1 && item.list_price === 10, "con el carrito del teléfono", item);
        m.destruir();
    };

    // -----------------------------------------------------------------
    // Fase 2/3: hoja de visita sin señal (copia local + cola)
    // -----------------------------------------------------------------
    escenarios.offline_hoja_visita = async function () {
        console.log("\n[Offline F2/F3] hoja de visita: se abre sin señal y el estado queda en la cola");
        fijarOnLine(true);
        const h = {
            "fsm.order.read": () => [{id: 5, location_id: [7, "Cliente X"], x_cliente_orden_ruta: 1, stage_name: "Pendiente", x_observaciones_visita: "", x_cliente_lat: 1, x_cliente_lng: 1, sale_id: false}],
            "fsm.location.read": () => [{id: 7, name: "Cliente X", phone: "", mobile: "", street: "c", street2: "", partner_id: [1, "p"]}],
            "fsm.order.shalom_campos_cliente_faltantes": [],
            "fsm.order.shalom_ficha_juego": {refs: {n: 0, record: 0, tipico: 0, t75: 0, t100: 0}, clase: "NUEVO", esperado: 0, n: 0},
            "fsm.order.shalom_leer_carrito": {actualizado: false, carrito: {}},
            "fsm.stage.searchRead": () => [{id: 1, name: "Pendiente"}, {id: 2, name: "Completado"}, {id: 3, name: "No quiso"}, {id: 4, name: "Cancelado"}],
        };
        // 1) con señal: carga y deja copia (y los ids de etapas)
        const m1 = await montar(bundle.VisitSheet, {orderId: 5, onCerrar() {}}, h);
        await esperar(() => !m1.comp.state.cargando);
        await m1.comp.elegirEstado("pendiente"); // no-op, mismo estado
        m1.destruir();
        // 2) sin señal: la misma visita sale de la copia local
        globalThis.__conservarAlmacen = true;
        fijarOnLine(false);
        const m2 = await montar(bundle.VisitSheet, {orderId: 5, onCerrar() {}}, {});
        globalThis.__conservarAlmacen = false;
        await esperar(() => !m2.comp.state.cargando);
        ok(m2.comp.state.visita && m2.comp.state.visita.nombre === "Cliente X", "sin señal, la visita se abre desde el teléfono", m2.comp.state.visita);
        ok(!m2.log.some((c) => c.method === "read"), "sin pedir nada al servidor");
        m2.comp.state.visita.observaciones = "Cerrado por inventario";
        m2.comp.elegirEstado("cancelado");
        await esperar(() => m2.comp.state.visita.estado === "cancelado", 3000);
        const cola = bundle.estadoOffline.cola;
        ok(cola.length === 1 && cola[0].tipo === "cambiar_etapa" && cola[0].datos.estado_app === "cancelado", "el cambio de estado quedó en la cola", cola.map((i) => i.tipo));
        ok(m2.comp.state.visita.estado === "cancelado", "y la hoja ya lo muestra Cancelado");
        ok(q(".off-banner"), "aviso fuerte de 'Pendiente de enviar'");
        fijarOnLine(true);
        m2.destruir();
    };

    // -----------------------------------------------------------------
    // Fase 1: Administración → Registro
    // -----------------------------------------------------------------
    escenarios.offline_admin_registro = async function () {
        console.log("\n[Offline F1] Administración → Registro: lista, filtros y restaurar");
        fijarOnLine(true);
        const ahora = new Date().toISOString().slice(0, 19).replace("T", " ");
        const filas = [
            {id: 1, fecha: ahora, cliente_nombre: "Farmacia Uno", ruta_nombre: "R1", vendedor_nombre: "Luis", usuario_nombre: "Luis",
             cantidad_items: 12, total: 340.5, destacado: true, lineas: [{clave: "1", nombre: "Tinte", cantidad: 12, precio: 28.375, es_recompensa: false}],
             restaurado: false, restaurado_como: false, restaurado_por: "", restaurado_en: false, sale_id: false, sale_nombre: "", visita_abierta: true},
            {id: 2, fecha: ahora, cliente_nombre: "Salón Dos", ruta_nombre: "R2", vendedor_nombre: "Ana", usuario_nombre: "Ana",
             cantidad_items: 2, total: 20, destacado: false, lineas: [], restaurado: true, restaurado_como: "carrito", restaurado_por: "Admin",
             restaurado_en: ahora, sale_id: false, sale_nombre: "", visita_abierta: true},
        ];
        let restaurados = [];
        const h = {
            "shalom.cotizacion.registro.shalom_admin_registro": () => filas,
            "shalom.sync.evento.shalom_admin_envios_con_aviso": [{id: 7, tipo: "Confirmar pedido", estado: "error", error: "Falta nota", recibido_en: ahora, usuario_nombre: "Luis", cliente_nombre: "Farmacia Uno", precios_cambiados: [], sale_order_name: ""}],
            "shalom.cotizacion.registro.shalom_admin_restaurar": (a) => { restaurados.push(a[0]); return {modo: "carrito"}; },
        };
        const m = await montar(bundle.AdminGestion, {}, new Proxy(h, {get: (t, k) => (k in t ? t[k] : (() => []))}));
        await sleep(100);
        const tab = qa(".adm-tab").find((t) => /Registro/.test(t.textContent));
        ok(tab && tab.querySelector(".adm-tab-count") && tab.querySelector(".adm-tab-count").textContent.trim() === "1", "pestaña Registro con 1 carrito grande sin restaurar");
        click(tab);
        await esperar(() => qa(".adm-reg-row").length === 2);
        ok(qa(".adm-reg-row").length === 2, "lista los 2 descartes");
        ok(/Monto grande/.test(qa(".adm-reg-row")[0].textContent), "el grande sale marcado");
        click(qa(".adm-chip").find((c) => /Sin restaurar/.test(c.textContent)));
        await esperar(() => qa(".adm-reg-row").length === 1);
        ok(qa(".adm-reg-row").length === 1, "filtro 'Sin restaurar'");
        click(qa(".adm-reg-row")[0]);
        await esperar(() => q(".adm-reg-linea"));
        ok(q(".adm-reg-linea") && /Tinte/.test(q(".adm-reg-linea").textContent), "al tocar la fila se ven sus productos");
        click(q(".adm-reg-row .adm-actbtn-accent"));
        await esperar(() => restaurados.length === 1);
        ok(restaurados.length === 1 && restaurados[0][0] === 1, "Restaurar llama al servidor con ese registro", restaurados);
        ok(/Necesita atención/.test(document.body.textContent), "muestra los envíos de la calle que necesitan revisión");
        ok(m.errores.length === 0, "sin rechazos no manejados", m.errores);
        m.destruir();
    };

    // -----------------------------------------------------------------
    // Ajustes post-deploy
    // -----------------------------------------------------------------
    escenarios.offline_catalogo_pastilla_y_fotos = async function () {
        console.log("\n[Offline ajustes] pastilla compacta en el catálogo y versión estable de fotos");
        fijarOnLine(true);
        const m = await montar(bundle.OrderScreen, {
            orderId: 5, clienteNombre: "Cliente X", onCerrar: () => {}, onConfirmado: () => {},
        }, handlersOrder({
            "fsm.order.shalom_marcas_fotos": (a) => Object.fromEntries(a[0].map((id) => [id, "20261101093000"])),
        }));
        await esperar(() => !m.comp.state.cargando && qa(".product-card").length === 3);
        const pastilla = q(".order-topbar .off-pill");
        ok(pastilla && pastilla.classList.contains("off-pill-compacta"), "pastilla compacta en la cabecera del catálogo");
        click(pastilla);
        await esperar(() => q(".off-panel"));
        ok(q(".off-panel") && /todas las rutas/i.test(q(".off-panel").textContent), "abre el panel (Preparar mi día: todas las rutas)");
        const src = tarjeta(1).querySelector(".product-thumb").getAttribute("src");
        ok(/image_512\?unique=20261101093000$/.test(src), "la foto usa la versión estable del producto (no la fecha del día)", src);
        m.destruir();
    };

    escenarios.offline_preparar_todas_las_rutas = async function () {
        console.log("\n[Offline ajustes] Preparar mi día baja TODAS las rutas, de a 3, y sigue si una falla");
        fijarOnLine(true);
        const rutas = [1, 2, 3, 4, 5].map((id) => ({id, route_id: 100 + id, route_name: "R" + id, tomada_por: [], tiene_cartera: false, pendientes_mios: 0, es_visita_express: false}));
        let enVuelo = 0;
        let maxVuelo = 0;
        const preparadas = [];
        const m = await montar(bundle.OrderScreen, {orderId: 5, clienteNombre: "X", onCerrar() {}, onConfirmado() {}}, handlersOrder({
            "fsm.person.shalom_mis_rutas_programadas": () => rutas,
            "fsm.order.searchRead": () => [],
            "fsm.route.read": () => [{id: 1, x_ruta_trazado: false}],
            "fsm.stage.searchRead": () => [{id: 1, name: "Pendiente"}],
            "fsm.person.shalom_mis_cotizaciones": [],
            "fsm.route.schedule.shalom_paquete_offline": async (a) => {
                enVuelo++;
                maxVuelo = Math.max(maxVuelo, enVuelo);
                await sleep(30);
                enVuelo--;
                if (a[0] === 4) {
                    throw new Error("se cortó");
                }
                preparadas.push(a[0]);
                return {visitas: {}, faltantes: {}, fichas: {}, pedidos: {}, ultima_fp: {}};
            },
        }));
        await esperar(() => !m.comp.state.cargando);
        const promesa = bundle.prepararDia(m.comp.orm, {});
        await esperar(() => q(".off-barra-global"), 1000);
        ok(!q(".off-panel") && q(".off-barra-global"), "con el panel cerrado se ve la barrita de descarga arriba");
        ok(/\d+%/.test((q(".order-topbar .off-pill") || {}).textContent || ""), "y la pastilla muestra el porcentaje", (q(".order-topbar .off-pill") || {}).textContent);
        const r = await promesa;
        await sleep(30);
        ok(!q(".off-barra-global"), "al terminar la barrita desaparece");
        ok(r && r.total === 5 && r.rutas === 4 && r.fallidas === 1, "las 5 rutas (aunque nadie las tomó); 1 falló y no frenó a las demás", r);
        ok(preparadas.sort().join(",") === "1,2,3,5", "se prepararon las demás", preparadas);
        ok(maxVuelo <= 3 && maxVuelo >= 2, "de a 3 en paralelo como máximo", maxVuelo);
        ok(/4 de 5 rutas/.test(bundle.estadoOffline.mensajePreparar), "el panel avisa cuántas bajaron", bundle.estadoOffline.mensajePreparar);
        m.destruir();
    };

    // -----------------------------------------------------------------
    // Selector de tema: el menú no se sale de la pantalla
    // -----------------------------------------------------------------
    escenarios.tema_menu_no_se_sale = async function () {
        console.log("\n[Tema] el menú abre hacia donde hay lugar");
        const probar = async (derecha) => {
            const m = await montar(bundle.TemaSelector, {}, {});
            const raiz = q(".tema-selector");
            raiz.getBoundingClientRect = () => ({left: derecha - 40, right: derecha, top: 0, bottom: 40, width: 40, height: 40});
            click(q(".tema-btn"));
            await esperar(() => q(".tema-menu"), 500);
            const izq = q(".tema-menu").classList.contains("tema-menu-izq");
            m.destruir();
            return izq;
        };
        ok(await probar(60) === true, "botón pegado a la izquierda: el menú abre hacia la derecha");
        ok(await probar(380) === false, "botón a la derecha: el menú abre hacia la izquierda, como siempre");
    };

    // -----------------------------------------------------------------
    // Panel nuevo: checklist, vista previa y Eliminar
    // -----------------------------------------------------------------
    async function catalogoConPanel(extra = {}) {
        const m = await montar(bundle.OrderScreen, {orderId: 5, clienteNombre: "Maxi Carne", onCerrar() {}, onConfirmado() {}}, handlersOrder(extra));
        await esperar(() => !m.comp.state.cargando && qa(".product-card").length === 3);
        await sleep(30); // cargarMetaPreparacion
        return m;
    }

    escenarios.offline_panel_checklist = async function () {
        console.log("\n[Panel] checklist: sin descargar / al día / conviene actualizar");
        fijarOnLine(true);
        const m = await catalogoConPanel();
        const E = bundle.estadoOffline;
        click(q(".order-topbar .off-pill"));
        await esperar(() => q(".off-panel"));
        const chip = () => (q(".off-chip") || {}).textContent.trim();
        ok(chip() === "Sin descargar", "nunca descargó: 'Sin descargar'", chip());
        ok(/Descargar datos del día/.test(q(".off-panel .off-btn").textContent), "botón 'Descargar datos del día'");
        E.preparadoEn = Date.now();
        E.rutasPreparadas = [1, 2];
        E.rutasDisponibles = [1, 2];
        E.productosGuardados = 2340;
        await sleep(30);
        ok(chip() === "Al día", "descargado hoy y sin rutas nuevas: 'Al día'", chip());
        ok(/2 rutas · hoy/.test(q(".off-checklist").textContent) && /2,340 productos/.test(q(".off-checklist").textContent), "dice cuántas rutas y productos, y cuándo", q(".off-checklist").textContent);
        ok(!q(".off-aviso"), "al día: no muestra el aviso de descarga");
        E.rutasDisponibles = [1, 2, 3];
        await sleep(30);
        ok(chip() === "Conviene actualizar", "hay una ruta nueva: 'Conviene actualizar'", chip());
        ok(/1 ruta nueva sin descargar/.test(q(".off-checklist").textContent), "avisa '1 ruta nueva sin descargar'");
        ok(q(".off-aviso") && /todas las rutas/i.test(q(".off-aviso").textContent), "aviso de descarga como caja aparte");
        E.rutasDisponibles = [1, 2];
        E.preparadoEn = Date.now() - 26 * 3600 * 1000;
        await sleep(30);
        ok(chip() === "Conviene actualizar" && /ayer/.test(q(".off-checklist").textContent), "datos de ayer: 'Conviene actualizar' y dice 'ayer'");
        m.destruir();
    };

    escenarios.offline_panel_vista_previa_y_eliminar = async function () {
        console.log("\n[Panel] pedido sin señal: vista previa y Eliminar (nunca enviado)");
        fijarOnLine(false);
        const m = await catalogoConPanel();
        click(botonAgregar(1));
        await esperar(() => m.comp.cantidadItems === 1);
        m.comp.state.formasPagoDisponibles = [{value: "cash", label: "Efectivo"}];
        m.comp.state.formaPagoSeleccionada = "cash";
        await m.comp._confirmarPedidoDeVerdad();
        const [item] = bundle.estadoOffline.cola;
        ok(item && item.intento_envio === false, "sin señal nunca salió del teléfono", item && item.intento_envio);
        ok(item && item.resumen && item.resumen.cliente === "Maxi Carne" && item.resumen.lineas[0].nombre === "Tinte Rubio 8.0", "guarda la vista previa (cliente y productos)", item && item.resumen);
        // el catálogo se cerró: el panel se abre desde otra pastilla
        const m2 = await montar(bundle.IndicadorConexion, {}, {});
        globalThis.__conservarAlmacen = false;
        bundle.estadoOffline.cola.push(item);
        click(q(".off-pill"));
        await esperar(() => q(".off-tarjeta"));
        ok(/Pedido · Maxi Carne/.test(q(".off-tarjeta").textContent) && /\$10\.00/.test(q(".off-tarjeta").textContent), "tarjeta con cliente y total");
        click(q(".off-tarjeta-cab"));
        await esperar(() => q(".off-linea"));
        ok(/Tinte Rubio 8\.0/.test(q(".off-lineas").textContent) && /Efectivo/.test(q(".off-lineas").textContent), "al tocarla muestra productos y forma de pago");
        click(q(".off-btn-peligro"));
        await esperar(() => !bundle.estadoOffline.cola.length, 1000);
        ok(bundle.estadoOffline.cola.length === 0, "Eliminar lo saca de la cola");
        ok(m2.log.every((c) => c.method !== "shalom_estado_eventos"), "sin preguntar al servidor (nunca se había enviado)");
        ok(bundle.estadoLocalDeVisita(5) === null, "la visita vuelve a su estado anterior");
        fijarOnLine(true);
        m2.destruir();
        m.destruir();
    };

    escenarios.offline_eliminar_ya_intentado = async function () {
        console.log("\n[Panel] Eliminar algo que ya se intentó enviar");
        fijarOnLine(true);
        let enServidor = "ok";
        const m = await catalogoConPanel({
            "shalom.sync.evento.shalom_procesar_lote": () => { throw new Error("se cortó"); },
            "shalom.sync.evento.shalom_estado_eventos": (a) => Object.fromEntries(a[0].map((u) => [u, enServidor])),
        });
        click(botonAgregar(1));
        await esperar(() => m.comp.cantidadItems === 1);
        m.comp.state.formaPagoSeleccionada = "cash";
        await m.comp._confirmarPedidoDeVerdad();
        const [item] = bundle.estadoOffline.cola;
        ok(item && item.intento_envio === true, "ya viajó al servidor una vez (la respuesta se perdió)");
        fijarOnLine(false);
        ok(await bundle.eliminarPendiente(item.uuid) === "sin_senal", "sin señal NO se deja eliminar");
        ok(bundle.estadoOffline.cola.length === 1, "sigue en la cola");
        fijarOnLine(true);
        ok(await bundle.eliminarPendiente(item.uuid) === "ya_entro", "con señal: el servidor dice que ya entró");
        ok(bundle.estadoOffline.cola.length === 0, "se saca de la cola como hecho (no se duplica ni se pierde el rastro)");
        m.destruir();
    };

    // -----------------------------------------------------------------
    // No duplicar, limpiar lo viejo y ver qué hay descargado
    // -----------------------------------------------------------------
    escenarios.offline_panel_rutas_y_confirmacion = async function () {
        console.log("\n[Panel] qué rutas hay, 'solo lo nuevo' y confirmación al repetir");
        fijarOnLine(true);
        const preparadas = [];
        const m = await catalogoConPanel({
            "fsm.person.shalom_mis_rutas_programadas": () => [
                {id: 1, route_name: "3 - Chilibre"}, {id: 2, route_name: "14 - Chiriquí"}, {id: 3, route_name: "22 - Arraiján"},
            ],
            "fsm.order.searchRead": () => [],
            "fsm.route.read": () => [{id: 1, x_ruta_trazado: false}],
            "fsm.route.schedule.shalom_paquete_offline": (a) => { preparadas.push(a[0]); return {visitas: {}, faltantes: {}, fichas: {}, pedidos: {}, ultima_fp: {}}; },
        });
        const E = bundle.estadoOffline;
        Object.assign(E, {
            preparadoEn: Date.now(), rutasPreparadas: [1, 2], rutasDisponibles: [1, 2, 3], productosGuardados: 10,
            rutasNombres: {1: "3 - Chilibre", 2: "14 - Chiriquí", 3: "22 - Arraiján"},
            rutasMeta: {1: {nombre: "3 - Chilibre", clientes: 22, en: Date.now()}, 2: {nombre: "14 - Chiriquí", clientes: 31, en: Date.now()}},
        });
        click(q(".order-topbar .off-pill"));
        await esperar(() => q(".off-panel"));
        ok(/2 de 3 rutas/.test(q(".off-checklist").textContent), "dice '2 de 3 rutas'", q(".off-checklist").textContent);
        click(q(".off-check-boton"));
        await esperar(() => qa(".off-ruta-fila").length === 3);
        const filas = qa(".off-ruta-fila").map((f) => f.textContent.replace(/\s+/g, " ").trim());
        ok(filas.length === 3 && /22 - Arraiján\s*Sin descargar/.test(filas[0]) && /22 clientes/.test(filas.join("|")), "lista cada ruta: ✓ con clientes y hora, o 'Sin descargar' (primero)", filas);
        const boton = () => q(".off-panel > .off-btn");
        ok(/Bajar solo lo nuevo \(1 ruta\)/.test(boton().textContent), "botón 'Bajar solo lo nuevo (1 ruta)'", boton().textContent);
        click(boton());
        await esperar(() => preparadas.length === 1 && !E.preparando, 2000);
        ok(preparadas.join(",") === "3", "baja SOLO la ruta nueva, no todo de nuevo", preparadas);
        await sleep(30);
        ok((q(".off-chip") || {}).textContent.trim() === "Al día", "queda 'Al día'");
        click(boton());
        await esperar(() => q(".off-confirmacion"));
        ok(q(".off-confirmacion") && /no ocupa espacio extra/.test(q(".off-confirmacion").textContent), "con todo al día pregunta antes de descargar de nuevo");
        ok(preparadas.length === 1, "y no descargó nada todavía");
        const no = qa(".off-confirmacion button").find((b) => /No, está bien/.test(b.textContent));
        click(no);
        await sleep(60);
        ok(!q(".off-confirmacion"), "'No, está bien' cierra la pregunta");
        m.destruir();
    };

    escenarios.offline_limpieza_y_borrar = async function () {
        console.log("\n[Almacén] limpiar lo viejo y 'Borrar' sin tocar lo pendiente");
        fijarOnLine(true);
        const m = await catalogoConPanel();
        const g = bundle.guardarLocal;
        await g("meta:ruta_1", {nombre: "R1", clientes: 1, en: 1, visitas: [10], clientes_ids: [100]});
        await g("meta:ruta_9", {nombre: "R9", clientes: 1, en: 1, visitas: [90], clientes_ids: [900]});
        for (const k of ["ruta:1", "ruta:9", "ruta_preparada:1", "ruta_preparada:9", "visita:10", "visita:90", "faltantes:90", "pedidos:100", "pedidos:900", "ficha:900", "ultima_fp:900", "catalogo"]) {
            await g(k, {x: 1});
        }
        await bundle.colaGuardar({uuid: "u-pend", seq: 1, tipo: "observacion", datos: {order_id: 5}, estado: "pendiente"});
        const borradas = await bundle.limpiarDatosViejos([1]);
        const quedan = (await bundle.listarClaves("")).sort();
        // 8 de la ruta 9 + lo que el catálogo guardó de la visita 5 / cliente 7,
        // que no es de ninguna ruta vigente
        ok(borradas >= 8, "borra las claves de la ruta terminada (ruta, visitas y clientes)", borradas);
        ok(["catalogo", "meta:ruta_1", "pedidos:100", "ruta:1", "ruta_preparada:1", "visita:10"].every((k) => quedan.includes(k)), "conserva la ruta vigente y el catálogo", quedan);
        ok(!quedan.some((k) => /:9$|:90$|:900$|ruta_9/.test(k)), "no queda nada de la ruta vieja", quedan);
        ok((await bundle.colaListar()).length === 1, "la cola de pendientes queda intacta");
        await bundle.borrarDatosDescargados();
        ok((await bundle.listarClaves("")).length === 0, "'Borrar' vacía todo lo descargado");
        ok((await bundle.colaListar()).length === 1, "pero NO lo que espera enviarse");
        ok(bundle.estadoOffline.preparadoEn === null && bundle.estadoOffline.rutasPreparadas.length === 0, "el panel queda en 'Sin descargar'");
        m.destruir();
    };

    // -----------------------------------------------------------------
    // Ayuda "?": incluye la pastilla de conexión
    // -----------------------------------------------------------------
    escenarios.offline_ayuda_conexion = async function () {
        console.log("\n[Ayuda] el recorrido '?' explica la pastilla de conexión");
        fijarOnLine(true);
        ok(["PASOS_HUB", "PASOS_RUTA", "PASOS_CATALOGO"].every((n) => bundle[n].some((p) => p.selector === ".off-pill")),
            "el paso está en Elegir ruta, dentro de la ruta y el catálogo");
        const m = await catalogoConPanel();
        // jsdom no mide nada (getClientRects vacío): se simula que todo se ve.
        const P = window.Element.prototype;
        const originales = [P.getClientRects, P.getBoundingClientRect];
        P.getClientRects = function () { return [{left: 10, top: 10, width: 40, height: 30}]; };
        P.getBoundingClientRect = function () { return {left: 10, top: 10, right: 50, bottom: 40, width: 40, height: 30, x: 10, y: 10}; };
        const sinScroll = !P.scrollIntoView;
        if (sinScroll) {
            P.scrollIntoView = function () {};
        }
        m.comp.state.recorridoAbierto = true;
        await esperar(() => q(".recorrido-titulo"), 1500);
        const titulos = [];
        for (let i = 0; i < 10 && q(".recorrido-titulo"); i++) {
            titulos.push(q(".recorrido-titulo").textContent.trim());
            if (/Conexión y lo pendiente/.test(titulos[titulos.length - 1])) {
                break;
            }
            click(q(".recorrido-siguiente"));
            await sleep(80);
        }
        ok(titulos.includes("Conexión y lo pendiente"), "recorriendo la ayuda del catálogo se llega al paso de la conexión", titulos);
        [P.getClientRects, P.getBoundingClientRect] = originales;
        if (sinScroll) {
            delete P.scrollIntoView;
        }
        m.destruir();
    };

    // -----------------------------------------------------------------
    // Panel en celular: arrastrar para cerrar (como la hoja de visita)
    // -----------------------------------------------------------------
    function toque(tipo, y, destino) {
        const ev = new window.Event(tipo, {bubbles: true, cancelable: true});
        ev.touches = tipo === "touchend" ? [] : [{clientY: y}];
        (destino || window).dispatchEvent(ev);
    }

    async function panelConMuchasRutas() {
        fijarOnLine(true);
        const m = await montar(bundle.IndicadorConexion, {}, {});
        const E = bundle.estadoOffline;
        const ids = Array.from({length: 12}, (_, i) => i + 1);
        Object.assign(E, {
            preparadoEn: Date.now(), rutasPreparadas: ids.slice(0, 9), rutasDisponibles: ids, productosGuardados: 2340,
            rutasNombres: Object.fromEntries(ids.map((i) => [i, `Ruta ${i} - Zona ${i}`])),
            rutasMeta: Object.fromEntries(ids.slice(0, 9).map((i) => [i, {nombre: `Ruta ${i}`, clientes: 10 + i, en: Date.now()}])),
            espacioUsado: 14 * 1024 * 1024,
        });
        for (let i = 0; i < 3; i++) {
            E.cola.push({
                uuid: `u${i}`, seq: i, tipo: "confirmar_pedido", datos: {order_id: 100 + i}, estado: "pendiente", intento_envio: false,
                creado_en: new Date().toISOString(), etiqueta: `Cliente ${i}`,
                resumen: {cliente: `Cliente ${i}`, total: 120 + i, forma_pago: "Efectivo",
                    lineas: [{nombre: "Tinte Rubio 8.0", cantidad: 12, precio: 7, recompensa: false}, {nombre: "Oxigenta 20 vol", cantidad: 6, precio: 4.5, recompensa: false}]},
            });
        }
        click(q(".off-pill"));
        await esperar(() => q(".off-panel"));
        click(q(".off-check-boton"));
        await esperar(() => qa(".off-ruta-fila").length === 12);
        click(q(".off-tarjeta-cab"));
        await sleep(50);
        return m;
    }

    escenarios.offline_panel_arrastre = async function () {
        console.log("\n[Panel] celular: arrastrar hacia abajo cierra, como la hoja de visita");
        const m = await panelConMuchasRutas();
        const panel = q(".off-panel");
        // Los movimientos se escuchan en el panel (no pasivo) para que el
        // navegador no los tome como scroll: se disparan sobre el panel.
        const mover = (y) => toque("touchmove", y, q(".off-panel") || window);
        toque("touchstart", 100, q(".off-estado"));
        await sleep(30);
        const primer = new window.Event("touchmove", {bubbles: true, cancelable: true});
        primer.touches = [{clientY: 150}];
        q(".off-estado").dispatchEvent(primer);
        await sleep(60);
        const p2 = q(".off-panel");
        ok(/translateY\(50px\)/.test(p2.style.transform), "el panel sigue al dedo", [p2.style.transform, p2 === panel]);
        ok(primer.defaultPrevented, "el gesto hacia abajo se toma como arrastre (el navegador no lo hace scroll)");
        ok(p2.style.transition === "none", "sin transición mientras se arrastra", p2.style.transition);
        toque("touchend", 0);
        await sleep(100);
        ok(q(".off-panel") && !q(".off-panel").style.transform, "soltar antes de 90 px: vuelve a su lugar", q(".off-panel") && q(".off-panel").style.transform);
        // hacia arriba: es scroll normal, no se toca
        toque("touchstart", 300, q(".off-estado"));
        const arriba = new window.Event("touchmove", {bubbles: true, cancelable: true});
        arriba.touches = [{clientY: 200}];
        q(".off-estado").dispatchEvent(arriba);
        mover(150);
        await sleep(60);
        ok(!arriba.defaultPrevented && !q(".off-panel").style.transform, "deslizar hacia arriba sigue siendo scroll normal");
        toque("touchend", 0);
        // con el contenido scrolleado, el gesto es scroll, no cierra
        Object.defineProperty(q(".off-panel"), "scrollTop", {value: 200, configurable: true});
        toque("touchstart", 100, q(".off-estado"));
        mover(400);
        toque("touchend", 0);
        await sleep(260);
        ok(!!q(".off-panel"), "con el panel scrolleado, arrastrar NO lo cierra");
        Object.defineProperty(q(".off-panel"), "scrollTop", {value: 0, configurable: true});
        toque("touchstart", 100, q(".off-estado"));
        mover(180);
        mover(260);
        await sleep(40);
        toque("touchend", 0);
        await sleep(300);
        ok(!q(".off-panel"), "arriba del todo y más de 90 px: se cierra");
        // sin redibujos de Owl durante el gesto: el panel es el mismo nodo
        click(q(".off-pill"));
        await esperar(() => q(".off-panel"));
        await sleep(50);
        const nodo = m.comp.__owl__;
        const renderOriginal = nodo.render;
        let dibujos = 0;
        nodo.render = function (...a) { dibujos++; return renderOriginal.apply(this, a); };
        toque("touchstart", 100, q(".off-estado"));
        for (let y = 110; y <= 160; y += 10) { mover(y); await sleep(20); }
        nodo.render = renderOriginal;
        ok(dibujos === 0 && /translateY/.test(q(".off-panel").style.transform), "arrastrar no redibuja el panel con Owl (solo cambia su posición)", dibujos);
        toque("touchend", 0);
        await sleep(250);
        if (process.env.SHALOM_VOLCADO) {
            // Para la prueba en Chromium real: el panel abierto, renderizado.
            click(q(".off-pill"));
            await esperar(() => q(".off-panel"));
            await sleep(80);
            if (!qa(".off-ruta-fila").length) {
                click(q(".off-check-boton"));
                await esperar(() => qa(".off-ruta-fila").length === 12);
            }
            if (!q(".off-lineas")) {
                click(q(".off-tarjeta-cab"));
                await sleep(80);
            }
            require("fs").writeFileSync(process.env.SHALOM_VOLCADO, document.body.innerHTML);
            console.log("    volcado en", process.env.SHALOM_VOLCADO);
        }
        m.destruir();
    };
};

