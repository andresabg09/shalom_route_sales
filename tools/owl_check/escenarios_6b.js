/*
 * Escenarios de la Fase 6B (avisos por WhatsApp, distribuidoras, casilla "Es
 * distribuidora" y modo conducción). Los carga simular.js (escenarios_*.js).
 *
 *   node simular.js avisos_lista avisos_whatsapp ... (o sin argumentos: todos)
 */
module.exports = (ctx) => {
    const {escenarios, bundle, montar, ok, q, qa, click, texto, esperar, sleep, window, localStorage, sessionStorage} = ctx;

    // ---------- utilidades ----------
    const HOY = new Date().toISOString().slice(0, 10);

    function avisoDe(id, nombre, extra = {}) {
        return {
            order_id: id, location_id: 100 + id, nombre, clase: "A", esperado: 1161.4,
            fecha: "2026-10-28", fecha_texto: "miércoles 28 de octubre", dias: 2, ruta: "Ruta Norte",
            telefono: "50766781234", telefono_texto: "+507 6678-1234",
            mensaje: `Hola ${nombre}, paso el miércoles 28 de octubre.`,
            url: `https://wa.me/50766781234?text=Hola%20${encodeURIComponent(nombre)}`,
            avisado: false, ...extra,
        };
    }
    const DISTRIBUIDORAS = [
        {location_id: 1, nombre: "MANLEY GROUP S.A", telefono: "50769998888", telefono_texto: "+507 6999-8888",
         ultimo_fecha: "2026-09-18", ultimo_monto: 3630, dias: 38, mensaje: "Hola Manley", url: "https://wa.me/50769998888?text=Hola%20Manley"},
        {location_id: 2, nombre: "DISTRIBUIDORA SMART", telefono: "", telefono_texto: "",
         ultimo_fecha: false, ultimo_monto: 0, dias: false, mensaje: "Hola", url: ""},
    ];
    const SCHED_HUB = {id: 1, route_id: 3, route_name: "Ruta Norte", date_start: HOY, date_end: HOY, tiempo_estimado: 1, capacidad: 20,
        estado: "en_curso", cantidad_clientes: 10, es_visita_express: false, mi_persona_id: 9, tiene_cartera: false,
        centro_lat: 0, centro_lng: 0, pendientes_mios: 0, esperado_mio: 0};

    function handlersHub(avisos, extra = {}) {
        return Object.assign({
            "fsm.person.shalom_mis_rutas_programadas": [SCHED_HUB],
            "shalom.estrategia.shalom_estrategias_vigentes": {empujar: [], no_ofrecer: [], productos: {}},
            "shalom.juego.evento.shalom_mi_progreso": false,
            "fsm.person.shalom_avisos_proximos": () => avisos.map((a) => ({...a})),
            "fsm.person.shalom_distribuidoras": () => DISTRIBUIDORAS.map((d) => ({...d})),
            "fsm.person.shalom_marcar_avisado": (a) => {
                for (const id of a[0]) { const x = avisos.find((v) => v.order_id === id); if (x) x.avisado = true; }
                return a[0];
            },
        }, extra);
    }

    /** window.open falso: anota cada llamada. */
    function abridorFalso() {
        const llamadas = [];
        const original = window.open;
        window.open = (...args) => { llamadas.push(args); return null; };
        return {llamadas, restaurar: () => { window.open = original; }};
    }

    /** navigator.geolocation falso: guarda los watchers y permite emitir lecturas. */
    function gpsFalso() {
        const g = {watchers: new Map(), siguiente: 1, retirados: [], altas: 0};
        const api = {
            watchPosition(ok_, err_) { const id = g.siguiente++; g.altas++; g.watchers.set(id, {ok: ok_, err: err_}); return id; },
            clearWatch(id) { g.retirados.push(id); g.watchers.delete(id); },
            getCurrentPosition(ok_) { /* la navegación real no se usa en estas pruebas */ },
        };
        for (const nav of [globalThis.navigator, window.navigator]) {
            if (nav) Object.defineProperty(nav, "geolocation", {value: api, configurable: true});
        }
        g.activos = () => g.watchers.size;
        /** Emite una lectura a todos los watchers. speed en m/s (o null). */
        g.emitir = ({speed = null, lat = 8.98, lng = -79.52, accuracy = 10} = {}) => {
            for (const w of [...g.watchers.values()]) {
                w.ok({coords: {latitude: lat, longitude: lng, accuracy, speed}, timestamp: Date.now()});
            }
        };
        g.error = () => { for (const w of [...g.watchers.values()]) w.err({code: 1, message: "denegado"}); };
        g.quitar = () => {
            for (const nav of [globalThis.navigator, window.navigator]) {
                if (nav) Object.defineProperty(nav, "geolocation", {value: undefined, configurable: true});
            }
        };
        return g;
    }

    // =====================================================================
    escenarios.avisos_lista = async function () {
        console.log("\n[Avisos] botón con contador, hoja con dos secciones, Atrás");
        const avisos = [avisoDe(11, "Carnes Primium"), avisoDe(12, "Super Smart del Este", {clase: "A2", esperado: 828}), avisoDe(13, "Ya Avisado SA", {avisado: true})];
        const m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub(avisos));
        await esperar(() => q(".avisos-btn"));
        ok(!!q(".avisos-btn"), "botón Avisos visible en la pestaña Rutas");
        ok(texto(".avisos-btn-cuenta") === "2", "el contador cuenta solo los pendientes (2 de 3)", texto(".avisos-btn-cuenta"));
        ok(!q(".av-overlay"), "la hoja arranca cerrada");
        click(q(".avisos-btn"));
        await esperar(() => !m.comp.state.cargando && q(".av-aviso") && qa(".av-dist").length);
        ok(!!q(".av-overlay"), "tocar el botón abre la hoja");
        ok(JSON.parse(sessionStorage.getItem("shalom_pila_navegacion") || "[]").some((n) => n.tipo === "avisos"), "la hoja es un nivel de la pila de Atrás de Android");
        const titulos = qa(".av-seccion-titulo").map((e) => e.textContent.trim());
        ok(titulos[0] === "Avisar por WhatsApp" && titulos[1] === "Distribuidoras: solo escríbeles", "dos secciones con sus títulos", titulos);
        const pend = qa(".av-aviso:not(.av-hecho)");
        ok(pend.length === 2, "2 avisos pendientes", pend.length);
        ok(/Carnes Primium/.test(pend[0].textContent) && /A · \$1,161/.test(pend[0].textContent), "tarjeta: nombre y clase · valor esperado", pend[0].textContent.replace(/\s+/g, " "));
        ok(/miércoles 28 de octubre/.test(pend[0].textContent) && /en 2 días/.test(pend[0].textContent), "tarjeta: fecha y 'en 2 días'");
        ok(/\+507 6678-1234/.test(pend[0].textContent), "tarjeta: teléfono normalizado legible");
        ok(!!pend[0].querySelector(".av-mensaje"), "tarjeta: vista previa del mensaje");
        ok(qa(".av-aviso.av-hecho").length === 1 && /Avisado/.test(texto(".av-aviso.av-hecho")), "el ya avisado va aparte con su insignia");
        // distribuidoras
        const dist = qa(".av-dist");
        ok(dist.length === 2, "2 distribuidoras", dist.length);
        ok(/MANLEY GROUP S\.A/.test(dist[0].textContent) && /hace 38 días/.test(dist[0].textContent) && /\$3,630/.test(dist[0].textContent), "distribuidora: nombre, hace N días y monto del último pedido", dist[0].textContent.replace(/\s+/g, " "));
        ok(!!dist[0].querySelector(".av-btn-wa") && /Escribir por WhatsApp/.test(dist[0].textContent), "botón 'Escribir por WhatsApp'");
        ok(!dist[1].querySelector(".av-btn-wa") && /Sin teléfono/.test(dist[1].textContent), "sin teléfono: no hay botón, avisa que se pida a oficina");
        ok(/Sin pedidos todavía/.test(dist[1].textContent), "sin pedidos: lo dice");
        // el contenido se ve completo en tema claro: usa variables, sin colores fijos oscuros
        // cerrar: contador y pila
        click(q(".av-back"));
        await esperar(() => !q(".av-overlay"), 1500);
        ok(!q(".av-overlay"), "la flecha cierra la hoja");
        ok(!JSON.parse(sessionStorage.getItem("shalom_pila_navegacion") || "[]").some((n) => n.tipo === "avisos"), "al cerrar sale de la pila");
        m.destruir();
    };

    escenarios.avisos_whatsapp = async function () {
        console.log("\n[Avisos] botón de WhatsApp: abre la URL y marca como avisado");
        const abridor = abridorFalso();
        try {
            const avisos = [avisoDe(11, "Carnes Primium"), avisoDe(12, "Otro Cliente")];
            const m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub(avisos));
            await esperar(() => q(".avisos-btn"));
            ok(texto(".avisos-btn-cuenta") === "2", "contador inicial = 2");
            click(q(".avisos-btn"));
            await esperar(() => qa(".av-aviso").length === 2);
            click(qa(".av-aviso .av-btn-wa")[0]);
            ok(abridor.llamadas.length === 1, "se abrió una sola ventana", abridor.llamadas.length);
            ok(abridor.llamadas[0] && abridor.llamadas[0][0] === avisos[0].url, "abre exactamente la URL wa.me armada por el servidor", abridor.llamadas[0]);
            ok(abridor.llamadas[0] && abridor.llamadas[0][1] === "_blank", "en otra pestaña (_blank)");
            await sleep(50);
            const marcas = m.log.filter((c) => c.method === "shalom_marcar_avisado");
            ok(marcas.length === 1 && JSON.stringify(marcas[0].args) === "[[11]]", "llama a shalom_marcar_avisado con [[order_id]]", marcas.map((c) => c.args));
            ok(qa(".av-aviso:not(.av-hecho)").length === 1 && qa(".av-aviso.av-hecho").length === 1, "la tarjeta pasa a 'Ya avisados' al instante");
            // 'Escribir de nuevo': abre otra vez pero NO vuelve a marcar
            click(q(".av-aviso.av-hecho .av-btn-secundario"));
            await sleep(30);
            ok(abridor.llamadas.length === 2 && abridor.llamadas[1][0] === avisos[0].url, "'Escribir de nuevo' abre el enlace otra vez");
            ok(m.log.filter((c) => c.method === "shalom_marcar_avisado").length === 1, "…sin volver a marcar");
            // distribuidora: abre la URL y no marca nada
            click(q(".av-dist .av-btn-wa"));
            ok(abridor.llamadas.length === 3 && abridor.llamadas[2][0] === DISTRIBUIDORAS[0].url, "distribuidora: abre su enlace de WhatsApp");
            await sleep(30);
            ok(m.log.filter((c) => c.method === "shalom_marcar_avisado").length === 1, "distribuidora: no marca ningún aviso");
            // al cerrar, el contador del botón se actualiza (1 pendiente)
            click(q(".av-back"));
            await esperar(() => !q(".av-overlay"), 1500);
            await esperar(() => texto(".avisos-btn-cuenta") === "1", 1500);
            ok(texto(".avisos-btn-cuenta") === "1", "el contador baja a 1 al volver", texto(".avisos-btn-cuenta"));
            m.destruir();

            // el servidor falla al marcar: se avisa y la tarjeta vuelve a pendiente
            const avisos2 = [avisoDe(21, "Cliente Falla")];
            const m2 = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub(avisos2, {"fsm.person.shalom_marcar_avisado": () => { throw new Error("sin red"); }}));
            await esperar(() => q(".avisos-btn"));
            click(q(".avisos-btn"));
            await esperar(() => qa(".av-aviso").length === 1);
            click(q(".av-aviso .av-btn-wa"));
            await sleep(80);
            ok(abridor.llamadas.length === 4, "aun con el servidor caído, WhatsApp se abre (el mensaje es lo importante)");
            ok(qa(".av-aviso:not(.av-hecho)").length === 1, "si marcar falla, la tarjeta vuelve a pendiente");
            ok(m2.notas.some((n) => /No se pudo marcar/.test(n.msg)), "y se avisa al vendedor", m2.notas);
            m2.destruir();
        } finally {
            abridor.restaurar();
        }
    };

    escenarios.avisos_vacio_y_errores = async function () {
        console.log("\n[Avisos] sin avisos, con errores, y sin servidor");
        // sin avisos pero con distribuidoras: el botón sale (sin contador) y se puede abrir
        let m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub([]));
        await esperar(() => q(".avisos-btn"));
        ok(!!q(".avisos-btn") && !q(".avisos-btn-cuenta"), "sin avisos: el botón no muestra contador");
        click(q(".avisos-btn"));
        await esperar(() => q(".av-sin-avisos"));
        ok(/No hay avisos/.test(texto(".av-sin-avisos") || ""), "mensaje de lista vacía");
        ok(qa(".av-dist").length === 2, "las distribuidoras se ven aunque no haya avisos");
        m.destruir();

        // distribuidoras falla: los avisos se ven igual
        m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub([avisoDe(1, "Uno")], {"fsm.person.shalom_distribuidoras": () => { throw new Error("boom"); }}));
        await esperar(() => q(".avisos-btn"));
        click(q(".avisos-btn"));
        await esperar(() => q(".av-aviso"));
        ok(qa(".av-aviso").length === 1 && /No se pudieron cargar las distribuidoras/.test(texto(".av-seccion:nth-of-type(2) .av-empty") || texto(".av-body") || ""), "si las distribuidoras fallan, los avisos se ven y se explica el error");
        m.destruir();

        // el servidor no tiene los métodos (versión vieja): el hub funciona sin botón
        m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, {
            "fsm.person.shalom_mis_rutas_programadas": [SCHED_HUB],
            "shalom.estrategia.shalom_estrategias_vigentes": {empujar: [], no_ofrecer: [], productos: {}},
            "shalom.juego.evento.shalom_mi_progreso": false,
        });
        await sleep(150);
        ok(!q(".avisos-btn") && qa(".route-card, .rutas-mapa").length >= 0 && !!q(".shalom-screen"), "si falla shalom_avisos_proximos, el hub sigue sin el botón");
        m.destruir();
    };

    // =====================================================================
    // Casilla "Es distribuidora" del formulario de cliente
    // =====================================================================
    function handlersForm(extra = {}) {
        return Object.assign({
            "fsm.person.shalom_mis_rutas": [{id: 3, name: "Ruta Norte"}],
            "fsm.location.shalom_puede_marcar_distribuidora": true,
            "fsm.location.read": () => [{id: 7, name: "Manley", phone: "233-4455", street: "calle 1", street2: "", partner_id: [1, "p"], fsm_route_id: false, partner_latitude: 8.9, partner_longitude: -79.5, x_es_distribuidora: false}],
            "res.partner.read": () => [{vat: "", mobile: "6678-1234", email: "", image_1920: false, x_nombre_contacto: ""}],
            "fsm.location.searchRead": [],
        }, extra);
    }

    escenarios.cliente_distribuidora = async function () {
        console.log("\n[ClienteForm] casilla 'Es distribuidora' (solo el dueño)");
        let guardado = 0;
        // 1) el dueño: casilla visible, la marca y guarda
        let m = await montar(bundle.ClienteForm, {modo: "editar", locationId: 7, onGuardado: () => { guardado++; }, onCancelar() {}}, handlersForm());
        const escrituras = [];
        m.comp.orm.write = (modelo, ids, vals) => { escrituras.push({modelo, ids, vals}); return Promise.resolve(true); };
        await esperar(() => !m.comp.state.cargando && q(".clf-dist-check"));
        ok(!!q(".clf-dist-check"), "el dueño ve la casilla");
        ok(/Es distribuidora/.test(texto(".clf-dist-check")) && /solo se le escribe, no se visita/.test(texto(".clf-dist-check")), "texto: 'Es distribuidora (solo se le escribe, no se visita)'", texto(".clf-dist-check"));
        ok(q(".clf-dist-input").checked === false, "arranca desmarcada (el cliente no lo es)");
        const leida = m.log.find((c) => c.method === "read" && c.model === "fsm.location");
        ok(leida && leida.args[1].includes("x_es_distribuidora"), "el campo se lee junto con la ficha", leida && leida.args[1]);
        click(q(".clf-dist-input"));
        await sleep(20);
        ok(m.comp.state.esDistribuidora === true && q(".clf-dist-input").checked === true, "tocar la marca");
        click(qa(".clf-foot button")[1]);
        await esperar(() => escrituras.length >= 1, 1500);
        const wLoc = escrituras.find((e) => e.modelo === "fsm.location");
        ok(wLoc && wLoc.vals.x_es_distribuidora === true, "al guardar escribe x_es_distribuidora=true en fsm.location", wLoc && wLoc.vals);
        await esperar(() => guardado === 1, 1500);
        ok(guardado === 1, "guardar cierra el formulario");
        m.destruir();

        // 2) sin cambios: no manda el campo
        const sin = [];
        m = await montar(bundle.ClienteForm, {modo: "editar", locationId: 7, onGuardado() {}, onCancelar() {}}, handlersForm());
        m.comp.orm.write = (modelo, ids, vals) => { sin.push({modelo, vals}); return Promise.resolve(true); };
        await esperar(() => !m.comp.state.cargando && q(".clf-dist-check"));
        click(qa(".clf-foot button")[1]);
        await esperar(() => sin.length >= 1, 1500);
        ok(sin.length >= 1 && !("x_es_distribuidora" in sin.find((e) => e.modelo === "fsm.location").vals), "si no la toca, no manda el campo (el servidor no lo ve)", sin);
        m.destruir();

        // 3) ya es distribuidora: sale marcada y se puede quitar
        const quitar = [];
        m = await montar(bundle.ClienteForm, {modo: "editar", locationId: 7, onGuardado() {}, onCancelar() {}}, handlersForm({
            "fsm.location.read": () => [{id: 7, name: "Manley", phone: "", street: "", street2: "", partner_id: [1, "p"], fsm_route_id: false, partner_latitude: 0, partner_longitude: 0, x_es_distribuidora: true}],
        }));
        m.comp.orm.write = (modelo, ids, vals) => { quitar.push({modelo, vals}); return Promise.resolve(true); };
        await esperar(() => !m.comp.state.cargando && q(".clf-dist-check"));
        ok(q(".clf-dist-input").checked === true, "una distribuidora llega marcada");
        click(q(".clf-dist-input"));
        click(qa(".clf-foot button")[1]);
        await esperar(() => quitar.length >= 1, 1500);
        ok(quitar.find((e) => e.modelo === "fsm.location").vals.x_es_distribuidora === false, "desmarcarla escribe x_es_distribuidora=false");
        m.destruir();

        // 4) un vendedor (el servidor dice que no puede): sin casilla y nunca manda el campo
        const vend = [];
        m = await montar(bundle.ClienteForm, {modo: "editar", locationId: 7, onGuardado() {}, onCancelar() {}}, handlersForm({"fsm.location.shalom_puede_marcar_distribuidora": false}));
        m.comp.orm.write = (modelo, ids, vals) => { vend.push({modelo, vals}); return Promise.resolve(true); };
        await esperar(() => !m.comp.state.cargando);
        ok(!q(".clf-dist-check"), "un vendedor no ve la casilla");
        click(qa(".clf-foot button")[1]);
        await esperar(() => vend.length >= 1, 1500);
        ok(!("x_es_distribuidora" in vend.find((e) => e.modelo === "fsm.location").vals), "y su guardado no incluye el campo");
        m.destruir();

        // 5) la pregunta de permiso falla (servidor viejo): sin casilla, el formulario funciona
        m = await montar(bundle.ClienteForm, {modo: "editar", locationId: 7, onGuardado() {}, onCancelar() {}}, handlersForm({"fsm.location.shalom_puede_marcar_distribuidora": () => { throw new Error("no existe"); }}));
        await esperar(() => !m.comp.state.cargando);
        ok(!q(".clf-dist-check") && !!q("#shalom-cf-name"), "si falla la pregunta de permiso, el formulario sale sin la casilla");
        m.destruir();

        // 6) alta rápida (modo crear): sin casilla
        m = await montar(bundle.ClienteForm, {modo: "crear", locationId: false, onGuardado() {}, onCancelar() {}}, handlersForm());
        await esperar(() => !m.comp.state.cargando && q("#shalom-cf-name"));
        ok(!q(".clf-dist-check"), "en 'Cliente nuevo' no hay casilla");
        ok(!m.log.some((c) => c.method === "shalom_puede_marcar_distribuidora"), "ni se pregunta el permiso");
        m.destruir();
    };

    // =====================================================================
    // Modo conducción
    // =====================================================================
    const SCHED_DET = {id: 1, route_id: 3, route_name: "Ruta Norte", date_start: "2026-10-26", date_end: "2026-10-30", estado: "en_curso", cantidad_clientes: 2, mi_persona_id: 9, tiene_cartera: false};
    function handlersDetalle() {
        const ordenes = [
            {id: 11, location_id: [101, "Cli A"], x_cliente_orden_ruta: 1, stage_name: "Pendiente", x_cliente_lat: 8.9, x_cliente_lng: -79.5, x_cartera_person_id: false, x_cartera_fecha: false, x_cartera_orden: 0, x_cartera_reserva: false},
            {id: 12, location_id: [102, "Cli B"], x_cliente_orden_ruta: 2, stage_name: "Pendiente", x_cliente_lat: 8.9, x_cliente_lng: -79.5, x_cartera_person_id: false, x_cartera_fecha: false, x_cartera_orden: 0, x_cartera_reserva: false},
        ];
        return Object.assign(handlersForm(), {
            "fsm.order.searchRead": ordenes,
            "fsm.location.read": (a) => a[0].map((id) => ({id, name: "x", phone: "", mobile: "", street: "calle", street2: "", x_venta_mas_alta: 50, partner_id: [1, "p"], fsm_route_id: false, partner_latitude: 8.9, partner_longitude: -79.5, x_es_distribuidora: false})),
            "fsm.order.shalom_perfiles_ruta": {101: {clase: "A", esperado: 1500, tipico: 300, record: 500}, 102: {clase: "B", esperado: 300, tipico: 100, record: 150}},
            "fsm.route.read": [{id: 3, x_ruta_trazado: false}],
            "fsm.order.shalom_marcar_catalogo_abierto": {es_principal: true},
        });
    }
    // La vigilancia de GPS se prueba con lecturas simuladas: m/s = km/h / 3.6
    const KMH = (v) => v / 3.6;

    escenarios.conduccion_reglas = async function () {
        console.log("\n[Conducción] reglas puras (conduccion_utils)");
        const c = bundle;
        let e = c.estadoConduccionInicial();
        const t0 = 1_000_000;
        ok(c.VELOCIDAD_ACTIVA_KMH === 15 && c.VELOCIDAD_QUIETO_KMH === 5 && c.ESPERA_QUIETO_MS === 5000, "umbrales: 15 km/h activa, 5 km/h quieto, 5 s");
        e = c.avanzarConduccion(e, 14.9, t0);
        ok(!e.enMovimiento, "14.9 km/h no activa");
        e = c.avanzarConduccion(e, 15.1, t0 + 1000);
        ok(e.enMovimiento, "15.1 km/h activa");
        // 5-15: se mantiene y reinicia la cuenta de quieto
        e = c.avanzarConduccion(e, 3, t0 + 2000);
        ok(e.enMovimiento && e.quietoDesde === t0 + 2000, "bajo 5 km/h empieza la cuenta de quieto");
        e = c.avanzarConduccion(e, 8, t0 + 3000);
        ok(e.enMovimiento && e.quietoDesde === null, "entre 5 y 15 km/h se mantiene y reinicia la cuenta");
        e = c.avanzarConduccion(e, 2, t0 + 4000);
        e = c.avanzarConduccion(e, null, t0 + 8999);
        ok(e.enMovimiento, "a los 4.999 s quieto todavía sigue");
        e = c.avanzarConduccion(e, null, t0 + 9000);
        ok(!e.enMovimiento, "a los 5 s quieto se quita");
        // lecturas rápidas lo vuelven a activar
        e = c.avanzarConduccion(e, 40, t0 + 10000);
        ok(e.enMovimiento, "vuelve a activarse");
        // sin lecturas: falla abierto
        e = c.avanzarConduccion(e, null, t0 + 10000 + 19000);
        ok(e.enMovimiento, "19 s sin lecturas: todavía");
        e = c.avanzarConduccion(e, null, t0 + 10000 + 21000);
        ok(!e.enMovimiento, "más de 20 s sin lecturas: se suelta (sin GPS no bloquea)");
        // velocidad de la lectura
        ok(Math.abs(c.velocidadDeLectura({coords: {speed: 10}}) - 36) < 1e-9, "coords.speed 10 m/s = 36 km/h");
        ok(c.velocidadDeLectura({coords: {speed: null}}) === null && c.velocidadDeLectura({coords: {speed: NaN}}) === null && c.velocidadDeLectura({coords: {}}) === null && c.velocidadDeLectura({coords: {speed: -1}}) === null && c.velocidadDeLectura(null) === null, "speed nula/NaN/ausente/negativa = sin dato");
        ok(c.velocidadDeLectura({coords: {speed: 0}}) === 0, "speed 0 es un dato válido (quieto)");
        // estimada entre dos lecturas: ~111 m en 10 s ≈ 40 km/h
        const a = {lat: 8.98, lng: -79.52, ts: 0, accuracy: 5};
        const b = {lat: 8.98 + 0.001, lng: -79.52, ts: 10000, accuracy: 5};
        const v = c.velocidadEstimadaKmh(a, b);
        ok(v > 38 && v < 42, "estimada: ~111 m en 10 s ≈ 40 km/h", v);
        ok(c.velocidadEstimadaKmh(a, {...b, ts: 1000}) === null, "menos de 3 s entre lecturas: no se estima");
        ok(c.velocidadEstimadaKmh(a, {...b, ts: 40000}) === null, "más de 30 s: no se estima");
        ok(c.velocidadEstimadaKmh(a, {...b, accuracy: 300}) === null, "precisión de 300 m: no se estima");
        ok(c.velocidadEstimadaKmh({...a, accuracy: 30}, {lat: 8.98 + 0.0001, lng: -79.52, ts: 10000, accuracy: 30}) === 0, "un salto de 11 m con precisión de 30 m es ruido: quieto");
        // copiloto: se recuerda y caduca
        localStorage.clear();
        ok(c.leerCopiloto() === false, "por defecto no va de copiloto");
        c.guardarCopiloto(true, 1000);
        ok(localStorage.getItem("shalom_copiloto") !== null, "se guarda en localStorage (shalom_copiloto)");
        ok(c.leerCopiloto(1000 + 60_000) === true, "se recuerda");
        ok(c.leerCopiloto(1000 + 13 * 3600 * 1000) === false, "caduca a las 12 horas");
        c.guardarCopiloto(false);
        ok(c.leerCopiloto() === false && localStorage.getItem("shalom_copiloto") === null, "apagarlo lo borra");
        localStorage.setItem("shalom_copiloto", "{basura");
        ok(c.leerCopiloto() === false, "dato corrupto = no copiloto (sin romper)");
        localStorage.clear();
    };

    escenarios.conduccion_overlay = async function () {
        console.log("\n[Conducción] overlay sobre la lista: aparece a >15 km/h, se quita tras 5 s <5 km/h");
        const gps = gpsFalso();
        const m = await montar(bundle.RutaDetalle, {schedule: SCHED_DET, onVolver() {}}, handlersDetalle());
        await esperar(() => !m.comp.state.cargando && qa(".stop-card").length === 2);
        ok(qa(".stop-card").length === 2 && !q(".cond-overlay"), "al abrir la ruta no hay overlay");
        ok(gps.activos() === 1, "RutaDetalle vigila el GPS mientras está en pantalla (1 watch)", gps.activos());
        // quieto / lento: nada
        gps.emitir({speed: KMH(3)});
        await sleep(30);
        ok(!q(".cond-overlay"), "3 km/h: nada");
        gps.emitir({speed: KMH(14)});
        await sleep(30);
        ok(!q(".cond-overlay"), "14 km/h: nada");
        // rápido: aparece
        gps.emitir({speed: KMH(32)});
        await esperar(() => q(".cond-overlay"), 500);
        ok(!!q(".cond-overlay"), "a 32 km/h aparece el overlay");
        ok(/Vas en movimiento/.test(texto(".cond-overlay")) && /la pantalla espera/i.test(texto(".cond-overlay")), "texto: 'Vas en movimiento — la pantalla espera'", texto(".cond-overlay"));
        ok(texto(".cond-velocidad") === "32", "muestra la velocidad", texto(".cond-velocidad"));
        ok(qa(".stop-card").length === 2 && !!q(".cond-overlay"), "cubre la lista (la lista sigue montada debajo)");
        ok(!!q(".cond-copiloto"), "trae el interruptor 'Voy de copiloto'");
        // baja a <5 km/h: sigue 3 s, se quita pasados 5 s
        const t0 = Date.now();
        let quitado = null;
        while (Date.now() - t0 < 8000) {
            gps.emitir({speed: KMH(1)});
            await sleep(250);
            if (!q(".cond-overlay")) { quitado = Date.now() - t0; break; }
            if (Date.now() - t0 > 3000 && Date.now() - t0 < 3300) {
                ok(!!q(".cond-overlay"), "a los 3 s lento todavía sigue (espera ~5 s)");
            }
        }
        ok(quitado !== null && quitado >= 4700 && quitado <= 6500, "se quita solo tras ~5 s por debajo de 5 km/h", quitado);
        // un tramo de 5-15 km/h reinicia la cuenta: arranca de nuevo, baja, sube a 8 antes de los 5 s
        gps.emitir({speed: KMH(40)});
        await esperar(() => q(".cond-overlay"), 500);
        ok(!!q(".cond-overlay"), "vuelve a aparecer al arrancar otra vez");
        gps.emitir({speed: KMH(2)});
        await sleep(2500);
        gps.emitir({speed: KMH(8)}); // 5-15: reinicia la cuenta
        await sleep(3500);           // 6 s desde el primer lento, pero la cuenta se reinició
        gps.emitir({speed: KMH(2)});
        await sleep(100);
        ok(!!q(".cond-overlay"), "un tramo entre 5 y 15 km/h reinicia la espera (no se quita a los 6 s)");
        // sin más lecturas, el temporizador lo quita 5 s después del último lento
        await esperar(() => !q(".cond-overlay"), 7000);
        ok(!q(".cond-overlay"), "y se quita 5 s después, aunque ya no lleguen lecturas");
        m.destruir();
        ok(gps.activos() === 0 && gps.retirados.length === gps.altas, "al salir de RutaDetalle se suelta todo el GPS (0 watchers activos)", {activos: gps.activos(), altas: gps.altas, retirados: gps.retirados.length});
        gps.quitar();
    };

    escenarios.conduccion_estimada = async function () {
        console.log("\n[Conducción] velocidad estimada si coords.speed viene nula");
        const gps = gpsFalso();
        const m = await montar(bundle.RutaDetalle, {schedule: SCHED_DET, onVolver() {}}, handlersDetalle());
        await esperar(() => !m.comp.state.cargando);
        // primera lectura (sin base): no se puede estimar
        gps.emitir({speed: null, lat: 8.98, lng: -79.52, accuracy: 5});
        await sleep(20);
        ok(!q(".cond-overlay"), "una sola lectura sin velocidad: nada");
        // lecturas cada ~1 s que avanzan 11 m (40 km/h): hace falta una base de >= 3 s
        const t0 = Date.now();
        let lat = 8.98;
        let aparecio = false;
        while (Date.now() - t0 < 6000) {
            lat += 0.0001; // ~11 m
            gps.emitir({speed: null, lat, lng: -79.52, accuracy: 5});
            await sleep(1000);
            if (q(".cond-overlay")) { aparecio = true; break; }
        }
        ok(aparecio, "con speed nula y avance real (~40 km/h) el overlay aparece", Date.now() - t0);
        ok(parseInt(texto(".cond-velocidad"), 10) > 30, "muestra la velocidad estimada", texto(".cond-velocidad"));
        m.destruir();
        // ruido de GPS quieto (saltos de 5 m con precisión 20 m, speed nula): nada
        const m2 = await montar(bundle.RutaDetalle, {schedule: SCHED_DET, onVolver() {}}, handlersDetalle());
        await esperar(() => !m2.comp.state.cargando);
        const t1 = Date.now();
        let falso = false;
        let i = 0;
        while (Date.now() - t1 < 5000) {
            i++;
            gps.emitir({speed: null, lat: 8.98 + (i % 2) * 0.00004, lng: -79.52, accuracy: 20});
            await sleep(500);
            if (q(".cond-overlay")) { falso = true; break; }
        }
        ok(!falso, "el ruido normal del GPS parado no dispara el overlay");
        m2.destruir();
        gps.quitar();
    };

    escenarios.conduccion_copiloto = async function () {
        console.log("\n[Conducción] 'Voy de copiloto'");
        let gps = gpsFalso();
        let m = await montar(bundle.RutaDetalle, {schedule: SCHED_DET, onVolver() {}}, handlersDetalle());
        await esperar(() => !m.comp.state.cargando);
        gps.emitir({speed: KMH(50)});
        await esperar(() => q(".cond-overlay"), 500);
        ok(!!q(".cond-overlay"), "en movimiento aparece");
        click(q(".cond-copiloto"));
        await sleep(30);
        ok(!q(".cond-overlay"), "tocar 'Voy de copiloto' quita el overlay");
        ok(localStorage.getItem("shalom_copiloto") !== null, "se recuerda en localStorage");
        ok(gps.activos() === 0, "con copiloto no se vigila el GPS (0 watchers)", gps.activos());
        gps.emitir({speed: KMH(80)});
        await sleep(50);
        ok(!q(".cond-overlay"), "con copiloto, a 80 km/h no aparece");
        m.destruir();

        // la próxima vez que se abre la ruta sigue de copiloto (recordado)
        gps = gpsFalso();
        const claveOriginal = window.Storage.prototype.clear;
        window.Storage.prototype.clear = function () { if (this !== localStorage) claveOriginal.call(this); };
        try {
            m = await montar(bundle.RutaDetalle, {schedule: SCHED_DET, onVolver() {}}, handlersDetalle());
        } finally {
            window.Storage.prototype.clear = claveOriginal;
        }
        await esperar(() => !m.comp.state.cargando);
        ok(m.comp.conduccion.copiloto === true, "al reabrir la ruta sigue 'de copiloto'");
        ok(gps.activos() === 0, "…sin vigilar el GPS");
        gps.emitir({speed: KMH(60)});
        await sleep(50);
        ok(!q(".cond-overlay"), "…y a 60 km/h no aparece");
        // se puede volver a activar la protección
        m.comp.conduccion.setCopiloto(false);
        await sleep(30);
        ok(gps.activos() === 1 && localStorage.getItem("shalom_copiloto") === null, "apagar el interruptor vuelve a vigilar y borra el recuerdo");
        gps.emitir({speed: KMH(60)});
        await esperar(() => q(".cond-overlay"), 500);
        ok(!!q(".cond-overlay"), "y vuelve a aparecer en movimiento");
        m.destruir();
        gps.quitar();
    };

    escenarios.conduccion_seguridad = async function () {
        console.log("\n[Conducción] SEGURIDAD: nunca sobre la navegación en vivo ni el mapa; sin GPS no hace nada");
        let gps = gpsFalso();
        let m = await montar(bundle.RutaDetalle, {schedule: SCHED_DET, onVolver() {}}, handlersDetalle());
        await esperar(() => !m.comp.state.cargando);
        // 1) navegando (Trazar ruta aquí): jamás
        gps.emitir({speed: KMH(60)});
        await esperar(() => q(".cond-overlay"), 500);
        ok(!!q(".cond-overlay"), "(control) en la lista y en movimiento SÍ aparece");
        m.comp.state.navegando = true;
        await sleep(50);
        ok(!q(".cond-overlay"), "en cuanto empieza la navegación en vivo, el overlay se va");
        for (let i = 0; i < 4; i++) { gps.emitir({speed: KMH(90)}); await sleep(30); }
        ok(!q(".cond-overlay") && m.comp.mostrarConduccion === false, "navegando a 90 km/h: NUNCA aparece");
        // navegando también con el mapa abierto y con una hoja abierta encima
        m.comp.dibujarMapa = function () {};
        m.comp.state.tab = "mapa";
        await sleep(50);
        gps.emitir({speed: KMH(90)});
        await sleep(30);
        ok(!q(".cond-overlay"), "navegando en la pestaña Mapa: nunca aparece");
        m.comp.state.edicionLocationId = 101;       // una hoja abierta encima (ficha de cliente)
        await sleep(60);
        gps.emitir({speed: KMH(90)});
        await sleep(30);
        ok(!q(".cond-overlay") && m.comp.mostrarConduccion === false, "navegando con una hoja abierta: tampoco");
        m.comp.state.edicionLocationId = null;
        // 2) mapa solo (sin navegar, sin hojas): el mapa no se tapa
        m.comp.state.navegando = false;
        await sleep(50);
        gps.emitir({speed: KMH(90)});
        await sleep(30);
        ok(m.comp.state.tab === "mapa" && !q(".cond-overlay") && m.comp.mostrarConduccion === false, "pestaña Mapa sin hojas: el mapa nunca se tapa");
        // 3) la lista vuelve a taparse
        m.comp.state.tab = "lista";
        await esperar(() => q(".cond-overlay"), 500);
        ok(!!q(".cond-overlay"), "de vuelta en la Lista, en movimiento: se tapa");
        // 4) una hoja (ficha de cliente) abierta desde el mapa en movimiento: se tapa
        m.comp.state.tab = "mapa";
        await sleep(50);
        ok(!q(".cond-overlay"), "(Mapa de nuevo: sin overlay)");
        m.comp.state.edicionLocationId = 101;
        await esperar(() => q(".cond-overlay"), 500);
        ok(!!q(".cond-overlay"), "hoja abierta (ficha) en movimiento, aun en el Mapa: se tapa");
        m.comp.state.edicionLocationId = null;
        m.destruir();

        // 5) sin permiso de GPS: nada, sin errores
        gps.quitar();
        gps = gpsFalso();
        m = await montar(bundle.RutaDetalle, {schedule: SCHED_DET, onVolver() {}}, handlersDetalle());
        await esperar(() => !m.comp.state.cargando);
        gps.error();
        await sleep(50);
        ok(!q(".cond-overlay") && m.errores.length === 0, "permiso de GPS denegado: no pasa nada", m.errores);
        m.destruir();

        // 6) navegador sin geolocalización: la ruta funciona igual
        gps.quitar();
        m = await montar(bundle.RutaDetalle, {schedule: SCHED_DET, onVolver() {}}, handlersDetalle());
        await esperar(() => !m.comp.state.cargando);
        ok(qa(".stop-card").length === 2 && !q(".cond-overlay") && m.errores.length === 0, "sin navigator.geolocation: se ve la lista, sin overlay ni errores");
        m.destruir();

        // 7) sin lecturas aunque haya permiso: nada
        gps = gpsFalso();
        m = await montar(bundle.RutaDetalle, {schedule: SCHED_DET, onVolver() {}}, handlersDetalle());
        await esperar(() => !m.comp.state.cargando);
        await sleep(1200);
        ok(!q(".cond-overlay"), "con permiso pero sin ninguna lectura: nada");
        m.destruir();
        gps.quitar();
    };
};
