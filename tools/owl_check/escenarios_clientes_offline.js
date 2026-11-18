/*
 * Clientes creados y editados SIN SEÑAL (ids provisorios) y "Tomar pedido
 * ahora". Uso: node simular.js clientes_crear_sin_senal clientes_pedido_provisorio ...
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
    const hoy = new Date().toISOString().slice(0, 10);
    const CICLO = {id: 1, route_id: 3, route_name: "Ruta Norte", date_start: hoy, date_end: hoy, estado: "en_curso", cantidad_clientes: 2, mi_persona_id: 9, tiene_cartera: false};

    async function datosEnTelefono() {
        const g = bundle.guardarLocal;
        await g("rutas", [CICLO, {...CICLO, id: 2, route_id: 4, route_name: "Ruta Sur", estado: "completada"}]);
        await g("mis_rutas", [{id: 3, name: "Ruta Norte"}, {id: 4, name: "Ruta Sur"}]);
        await g("mis_clientes", [{id: 7, name: "Farmacia El Sol", street: "Calle 3", street2: "", phone: "", fsm_route_id: 3, fsm_route_name: "Ruta Norte", x_orden_ruta: 8}]);
        await g("clientes_ruta:3", [{id: 7, name: "Farmacia El Sol", x_orden_ruta: 8}]);
        await g("cliente_form:7", {id: 7, name: "Farmacia El Sol", phone: "", street: "Calle 3", street2: "", fsm_route_id: [3, "Ruta Norte"], partner_latitude: false, partner_longitude: false, x_es_distribuidora: false, partner_id: [70, "Farmacia El Sol"], vat: "", mobile: "", email: "", x_nombre_contacto: "", tiene_foto: false});
        await g("puede_distribuidora", false);
        await g("ruta:1", {
            ordenes: [
                {id: 80, location_id: [7, "Farmacia El Sol"], x_cliente_orden_ruta: 8, stage_name: "Completado"},
                {id: 81, location_id: [8, "Minisuper La Esperanza"], x_cliente_orden_ruta: 9, stage_name: ""},
            ],
            locaciones: [{id: 7, phone: "", street: "Calle 3", street2: "", x_venta_mas_alta: 0}, {id: 8, phone: "", street: "Bajo", street2: "", x_venta_mas_alta: 0}],
            perfiles: {},
            ruta: [],
        });
    }

    async function montarClientes(handlers = {}) {
        let pedido = null;
        // El almacén se llena DESPUÉS de montar (montar() lo vacía) y se
        // vuelve a cargar la lista.
        const m = await montar(bundle.Clientes, {onTomarPedido: (schedule, orderId) => { pedido = {schedule, orderId}; }}, handlers);
        await datosEnTelefono();
        await m.comp.cargar();
        await sleep(20);
        return {m, pedido: () => pedido};
    }

    escenarios.clientes_crear_sin_senal = async function () {
        console.log("\n[Clientes] crear sin señal: queda en el teléfono, parada nueva y 'Tomar pedido ahora'");
        fijarOnLine(false);
        const {m, pedido} = await montarClientes({});
        ok(qa(".cliente-card").length === 1, "la lista sale de la copia del teléfono", qa(".cliente-card").length);
        click(q(".fab-add"));
        await esperar(() => q(".clf-overlay") && !q(".clf-empty"));
        ok(q(".clf-aviso-offline") && /se guarda en el teléfono/.test(q(".clf-aviso-offline").textContent), "avisa que se guarda en el teléfono");
        const form = Object.values(m.comp.__owl__.children).find((n) => n.component && n.component.guardar);
        const comp = form ? form.component : null;
        ok(comp && comp.state.rutas.length === 2, "las rutas salen del teléfono", comp && comp.state.rutas.length);
        comp.state.campos.name = "Abarrotería Doña Luz";
        comp.state.campos.street = "Vía principal";
        await comp.guardar();
        await sleep(20);
        ok(comp.state.faltaRuta && q(".clf-dropdown-error") && q(".clf-error-texto"), "sin ruta no crea: marca la ruta en rojo con el motivo");
        ok(bundle.estadoOffline.cola.length === 0, "y no encola nada");
        ok(q(".clf-dropdown-btn[disabled]") && /Primero elegí la ruta/.test(q(".clf-dropdown-btn[disabled]").textContent), "'Va después de' deshabilitado hasta elegir ruta");
        await comp.elegirRuta(3);
        comp.elegirClienteAnterior(7);
        await comp.guardar();
        await esperar(() => q(".cc-hoja"), 2000);
        const cola = bundle.estadoOffline.cola;
        const alta = cola.find((i) => i.tipo === "crear_cliente");
        ok(alta && alta.datos.tmp_location_id < 0 && alta.datos.tmp_order_id < 0 && alta.datos.route_id === 3 && alta.datos.schedule_id_local === 1, "el alta queda en la cola con ids provisorios y su ciclo", alta && alta.datos);
        ok(alta && alta.datos.cliente_anterior_id === 7 && alta.datos.parada_local === 9, "va después de Farmacia El Sol (parada 9)", alta && alta.datos);
        ok(q(".cc-hoja") && /Abarrotería Doña Luz/.test(q(".cc-hoja").textContent) && /9, después de Farmacia El Sol/.test(q(".cc-hoja").textContent), "hoja 'Cliente creado' con ruta y parada");
        ok(q(".cc-aviso") && /Guardado en el teléfono/.test(q(".cc-aviso").textContent), "avisa que se envía con la señal");
        await esperar(() => qa(".cliente-card").length === 2);
        const nuevo = qa(".cliente-card").find((c) => /Doña Luz/.test(c.textContent));
        ok(nuevo && nuevo.querySelector(".off-nuevo") && /Sin enviar/.test(nuevo.textContent), "en Clientes aparece como NUEVO · Sin enviar");
        click(q(".cc-pedido"));
        ok(pedido() && pedido().schedule.id === 1 && pedido().orderId === alta.datos.tmp_order_id, "'Tomar pedido ahora' abre la ruta y la visita provisoria", pedido());
        // la ruta muestra la parada nueva; la hoja de visita la abre
        const detalle = await bundle.traerDetalleRuta(null, CICLO).catch((e) => ({error: String(e)}));
        const fila = detalle.ordenes && detalle.ordenes.find((o) => o.id === alta.datos.tmp_order_id);
        ok(fila && fila.provisoria && fila.x_cliente_orden_ruta === 9, "la ruta tiene la parada nueva (sin enviar)", detalle.error || fila);
        ok(detalle.ordenes && detalle.ordenes.map((o) => o.id).join() === `80,${alta.datos.tmp_order_id},81`, "en su lugar: después de Farmacia El Sol", detalle.ordenes && detalle.ordenes.map((o) => o.id));
        const visita = await bundle.traerVisita(null, alta.datos.tmp_order_id);
        ok(visita.locacion.name === "Abarrotería Doña Luz" && visita.orden.location_id[0] === alta.datos.tmp_location_id, "la hoja de visita sale del teléfono");
        const faltantes = await bundle.traerFaltantes(null, alta.datos.tmp_order_id);
        ok(faltantes.locationId === alta.datos.tmp_location_id, "el catálogo sabe de qué cliente es");
        ok((await bundle.traerPedidosAnteriores(null, alta.datos.tmp_location_id)).length === 0, "cliente nuevo: sin pedidos anteriores (sin pedir al servidor)");
        m.destruir();
        fijarOnLine(true);
    };

    escenarios.clientes_pedido_provisorio = async function () {
        console.log("\n[Clientes] pedido al cliente nuevo: sin llamadas al servidor y por la cola con el id provisorio");
        fijarOnLine(true);
        const m0 = await montar(bundle.Clientes, {}, {});
        await datosEnTelefono();
        fijarOnLine(false);
        const r = await bundle.crearCliente({name: "Cliente Nuevo", route_id: 3, route_name: "Ruta Norte", parada_local: 1});
        ok(r.estado === "pendiente" && r.orderId < 0 && r.schedule && r.schedule.id === 1, "sin señal: queda pendiente con id provisorio", r);
        m0.destruir();
        globalThis.__conservarAlmacen = true;
        let m;
        try {
            m = await montar(bundle.OrderScreen, {orderId: r.orderId, clienteNombre: "Cliente Nuevo", onCerrar: () => {}, onConfirmado: () => {}}, handlersOrder({}));
        } finally {
            globalThis.__conservarAlmacen = false;
        }
        // montar() reinicia la cola en memoria: se vuelve a cargar del teléfono
        await bundle.iniciarSincronizador(globalThis.__servicios.orm, globalThis.__servicios.notification);
        await esperar(() => !m.comp.state.cargando, 3000);
        await sleep(1500);
        const llamadas = m.log.filter((c) => ["shalom_leer_carrito", "shalom_actualizar_carrito", "shalom_marcar_catalogo_abierto", "shalom_evaluar_pedido"].includes(c.method));
        ok(llamadas.length === 0, "el catálogo de la visita provisoria no llama al servidor por el carrito", llamadas.map((c) => c.method));
        ok(m.comp.esVisitaProvisoria, "sabe que es una visita provisoria");
        m.destruir();
    };

    escenarios.clientes_envio_y_editar = async function () {
        console.log("\n[Clientes] al volver la señal: alta + pedido en orden; editar sin señal");
        fijarOnLine(true);
        const enviados = [];
        let red = false;
        const m = await montar(bundle.Clientes, {}, {
            "fsm.person.shalom_mis_clientes": () => [],
            "shalom.sync.evento.shalom_procesar_lote": (a) => {
                if (!red) {
                    throw new Error("sin señal");
                }
                enviados.push(...a[0]);
                return a[0].map((ev) => ({
                    uuid: ev.uuid, estado: "ok",
                    resultado: ev.tipo === "crear_cliente" ? {location_id: 501, order_id: 601, schedule_id: 1, partner_id: 70} : {},
                }));
            },
        });
        await datosEnTelefono();
        fijarOnLine(false);
        const r = await bundle.crearCliente({name: "Minisuper Nuevo", route_id: 3, route_name: "Ruta Norte", parada_local: 1, image_1920: "AAAA"});
        await bundle.encolar("confirmar_pedido", {order_id: r.orderId, lineas: [{product_id: 1, qty: 2}], payment_method: "cash"});
        // editar el cliente nuevo sin señal: se ve al instante
        const e = await bundle.editarCliente(r.locationId, {name: "Minisuper Nuevo 2", phone: "6000-0000"}, "Minisuper Nuevo");
        ok(e.estado === "pendiente", "editar sin señal queda pendiente", e);
        const ficha = await bundle.traerFichaClienteForm(null, r.locationId);
        ok(ficha.name === "Minisuper Nuevo 2" && ficha.phone === "6000-0000", "lo editado se ve al instante en la ficha", ficha);
        const lista = await bundle.traerMisClientes(globalThis.__servicios.orm);
        ok(lista.some((c) => c.name === "Minisuper Nuevo 2" && c.sinEnviar), "y en la lista de Clientes");
        // editar un cliente existente sin señal
        await bundle.editarCliente(7, {name: "Farmacia El Sol 24h"}, "Farmacia El Sol");
        ok((await bundle.traerFichaClienteForm(null, 7)).name === "Farmacia El Sol 24h", "cliente existente editado sin señal: se ve al instante");
        // vuelve la señal: la foto viaja sola; después el resto, en orden
        fijarOnLine(true);
        red = true;
        await bundle.enviarPendientes();
        await sleep(20);
        const tipos = enviados.map((ev) => ev.tipo);
        ok(tipos.join() === "crear_cliente,confirmar_pedido,editar_cliente,editar_cliente", "se envía en orden: alta, pedido, ediciones", tipos);
        ok(enviados[1] && enviados[1].datos.order_id === r.orderId, "el pedido viaja con el id provisorio (lo traduce el servidor)");
        ok(bundle.estadoOffline.cola.length === 0 && bundle.clientesProvisorios().length === 0, "la capa local desaparece sola");
        ok((await bundle.idRealDe(r.orderId, "order_id")) === 601, "queda anotado el id real de la visita");
        m.destruir();
    };
};
