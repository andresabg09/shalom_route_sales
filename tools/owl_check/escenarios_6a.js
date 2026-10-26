/*
 * Escenarios de la Fase 6A (tutorial, panel de juego, equipo, temporada).
 * Se cargan solos desde simular.js (escenarios_*.js). Uso:
 *   node simular.js tutorial_hub tutorial_saltar tutorial_ya_visto ...
 */
const fs = require("fs");
const path = require("path");

module.exports = (ctx) => {
    const {escenarios, bundle, montar, ok, q, qa, click, texto, esperar, sleep, window, localStorage, sessionStorage, MOD} = ctx;
    const E = "shalom.juego.evento";

    // El Map falso de simular.js no trae resize() y el escenario `admin` (de
    // otra fase) revienta el proceso entero antes de llegar a los demás.
    // Se agrega aquí, solo si falta, sin tocar simular.js.
    if (window.mapboxgl && window.mapboxgl.Map && !window.mapboxgl.Map.prototype.resize) {
        window.mapboxgl.Map.prototype.resize = function () {};
    }

    const hoy = new Date().toISOString().slice(0, 10);
    const sched = {
        id: 1, route_id: 3, route_name: "Ruta Norte", date_start: hoy, date_end: hoy, tiempo_estimado: 1,
        capacidad: 20, estado: "en_curso", cantidad_clientes: 10, es_visita_express: false, mi_persona_id: 9,
        tiene_cartera: false, centro_lat: 9.1, centro_lng: -79.4, pendientes_mios: 3, esperado_mio: 500,
    };
    const PROGRESO = {xp_total: 450, nivel: 2, nivel_nombre: "Explorador", xp_nivel: 300, xp_siguiente: 700, pedidos_mes: 4, ventas_mes: 1234.5, estrellas_mes: 7};
    const MISIONES = (hechas) => [
        {codigo: "primer_pedido", nombre: "Primer pedido", descripcion: "Toma tu primer pedido", xp: 100, meta: 1, progreso: hechas >= 1 ? 1 : 0, completo: hechas >= 1, bienvenida: true, fecha: false, hoy: false},
        {codigo: "quimico", nombre: "El Químico", descripcion: "Pon oxigenta en 3 pedidos que lleven tinte", xp: 200, meta: 3, progreso: 1, completo: false, bienvenida: true, fecha: false, hoy: false},
        {codigo: "ruta_sin_saltos", nombre: "Ruta sin saltos", descripcion: "Cierra 5 clientes seguidos de la misma ruta", xp: 300, meta: 5, progreso: 2, completo: false, bienvenida: true, fecha: false, hoy: false},
    ];
    const LOGROS = {
        logros: [
            ...MISIONES(1),
            {codigo: "oro", nombre: "Oro", descripcion: "Gana 3 estrellas (oro) en un pedido", xp: 150, meta: 1, progreso: 1, completo: true, bienvenida: false, fecha: hoy, hoy: true},
            {codigo: "nivel_2", nombre: "Nivel 2", descripcion: "Llegar al nivel 2 (600 XP)", xp: 50, meta: 600, progreso: 450, completo: false, bienvenida: false, fecha: false, hoy: false},
        ],
        completos: 2, total: 5, nuevos_mes: 2, nuevos_hoy: 1, xp_logros: 250,
    };
    LOGROS.logros[0].fecha = hoy;
    const EQUIPO = {
        mes: 11, mes_nombre: "Noviembre", anio: 2026, ventas: 41900, piso: 60000, meta: 80000, camion: null,
        dias_mes: 30, dia_actual: 16, dias_habiles_mes: 21, dias_habiles_pasados: 10, dias_habiles_restantes: 11,
        pct_piso: 69.8, pct_meta: 52.4, faltan_piso: 18100, faltan_meta: 38100, ritmo_piso: 1645.45, ritmo_meta: 3463.64,
        esperado_hoy: 28571.43, en_ritmo: true, piso_alcanzado: false, meta_alcanzada: false,
    };
    const hitos = (premios) => [300, 700, 1300, 2100, 3100, 4300, 5700, 7300, 9100, 11100, 13300, 16000].map((xp, i) => ({
        nivel: i + 1, xp, alcanzado: i < 2, actual: i === 2, premio: premios && premios[i + 1] ? premios[i + 1] : false,
    }));
    const TEMPORADA = (premios) => ({
        mes: 11, mes_nombre: "Noviembre", anio: 2026, xp_mes: 900, estrellas_mes: 5, pedidos_mes: 4, nivel_temporada: 2,
        niveles_total: 12, hitos: hitos(premios), proximo: {nivel: 3, xp: 1300, faltan: 400}, hay_premios: !!premios,
        dias_restantes_mes: 14, bono_quincena: {activo: true, multiplicador: 1.5, dias_restantes: 4},
    });

    /** Handlers del hub; `extra` pisa lo que haga falta. */
    function handlersHub(extra = {}) {
        return Object.assign({
            "fsm.person.shalom_mis_rutas_programadas": [sched],
            "shalom.estrategia.shalom_estrategias_vigentes": {empujar: [], no_ofrecer: [], productos: {}},
            [`${E}.shalom_mi_progreso`]: PROGRESO,
            [`${E}.shalom_mis_logros`]: LOGROS,
            [`${E}.shalom_tutorial_estado`]: {disponible: true, visto: false, mostrar: true, nombre: "Andrés Pérez"},
            [`${E}.shalom_tutorial_terminar`]: {disponible: true, visto: true, mostrar: false, nombre: "Andrés Pérez"},
            [`${E}.shalom_equipo_mes`]: EQUIPO,
            [`${E}.shalom_temporada`]: TEMPORADA(false),
        }, extra);
    }
    const llamadas = (m, metodo) => m.log.filter((c) => c.method === metodo);
    const boton = (txt, raiz = document.body) => qa("button", raiz).find((b) => b.textContent.replace(/\s+/g, " ").includes(txt));

    // =====================================================================
    escenarios.tutorial_hub = async function () {
        console.log("\n[Tutorial] bienvenida -> 3 pasos -> terminado con 3 misiones (dentro de Rutas)");
        const m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub({
            [`${E}.shalom_mis_logros`]: {...LOGROS, logros: MISIONES(1)},
        }));
        ok(await esperar(() => q(".tut-overlay"), 3000), "el tutorial aparece si el servidor dice mostrar=true");
        ok(llamadas(m, "shalom_tutorial_estado").length === 1, "una sola consulta de estado del tutorial");
        ok(/Tu ruta de siempre, ahora con estrellas\./.test(texto(".tut-titulo-grande")), "texto de bienvenida aprobado");
        ok(/Entraste como Andrés/.test(texto(".tut-usuario")), "saluda con el nombre de pila del vendedor", texto(".tut-usuario"));
        ok(!!q(".tut-saltar"), "'Saltar' visible en la bienvenida");
        ok(llamadas(m, "shalom_tutorial_terminar").length === 0, "todavía no se marcó como visto");

        click(boton("Empezar"));
        await esperar(() => q(".tut-coach-paso"), 1000);
        ok(/Paso 1 de 3/.test(texto(".tut-coach-paso")) && /Este es tu primer cliente/.test(texto(".tut-coach-titulo")), "paso 1 de 3 con su título");
        const escalera = qa(".tut-escalera-fila").map((f) => f.textContent.replace(/\s+/g, " ").trim());
        ok(escalera.length === 3 && /\$3,048/.test(escalera[0]) && /\$4,064/.test(escalera[1]) && /> \$4,396/.test(escalera[2]), "escalera de práctica 75% / 100% / récord", escalera);
        ok(!!q(".tut-saltar"), "'Saltar' visible en el paso 1");

        click(boton("Siguiente"));
        await esperar(() => /Paso 2 de 3/.test(texto(".tut-coach-paso")), 1000);
        ok(/Paso 2 de 3/.test(texto(".tut-coach-paso")), "paso 2 de 3");
        ok(texto(".tut-pedido-total") === "$3,900" && /Bronce listo\. Te faltan \$164 para la plata/.test(texto(".tut-pedido-mensaje")), "pedido de práctica $3,900: bronce, faltan $164", texto(".tut-pedido-mensaje"));
        ok(qa(".tut-pedido-estrellas .estrella-on").length === 1, "1 estrella encendida");
        click(boton("+ $500"));
        await sleep(20);
        ok(texto(".tut-pedido-total") === "$4,400" && qa(".tut-pedido-estrellas .estrella-on").length === 3 && /Oro/.test(texto(".tut-pedido-mensaje")), "+ $500 -> $4,400 supera el récord: 3 estrellas", texto(".tut-pedido-mensaje"));
        click(boton("Reiniciar"));
        await sleep(20);
        ok(texto(".tut-pedido-total") === "$3,900", "Reiniciar vuelve a $3,900");
        ok(!!q(".tut-saltar"), "'Saltar' visible en el paso 2");

        click(boton("Siguiente"));
        await esperar(() => /Paso 3 de 3/.test(texto(".tut-coach-paso")), 1000);
        ok(/Paso 3 de 3/.test(texto(".tut-coach-paso")) && !!q(".tut-llegue"), "paso 3 de 3 con el botón 'Llegué · Tomar pedido' resaltado");
        ok(llamadas(m, "shalom_tutorial_terminar").length === 0, "hasta el paso 3 todavía no se marca visto");
        click(boton("Entendido"));
        ok(await esperar(() => q(".tut-fin"), 2000), "pantalla 'Tutorial terminado'");
        ok(llamadas(m, "shalom_tutorial_terminar").length === 1 && llamadas(m, "shalom_tutorial_terminar")[0].args.length === 0, "'Entendido' llama shalom_tutorial_terminar() una vez");
        await esperar(() => llamadas(m, "shalom_mis_logros").length >= 2, 1500);
        await sleep(40);
        ok(qa(".tut-mision").length === 3, "3 misiones de bienvenida", qa(".tut-mision").length);
        ok(/1\/3/.test(texto(".tut-contador")), "contador 1/3 con la misión ya cumplida", texto(".tut-contador"));
        ok(qa(".tut-mision-hecha").length === 1, "una misión marcada como hecha");
        ok(/\+600 XP · Nivel 2/.test(texto(".tut-premio")), "premio '+600 XP · Nivel 2'", texto(".tut-premio"));
        ok(/El Químico/.test(texto(".tut-misiones")) && /Ruta sin saltos/.test(texto(".tut-misiones")), "nombres de las misiones");
        m.comp.cambiarVista("lista");
        await sleep(20);
        click(boton("Ir al mapa de rutas"));
        await sleep(40);
        ok(!q(".tut-overlay"), "'Ir al mapa de rutas' cierra el tutorial");
        ok(m.comp.state.vista === "mapa", "y deja la pestaña en la vista Mapa", m.comp.state.vista);
        ok(llamadas(m, "shalom_tutorial_terminar").length === 1, "no se vuelve a llamar terminar");
        ok(m.errores.length === 0, "sin rechazos no manejados", m.errores);
        m.destruir();
    };

    // =====================================================================
    escenarios.tutorial_saltar = async function () {
        console.log("\n[Tutorial] 'Saltar' desde la bienvenida y desde cada paso");
        for (const [donde, avanzar] of [["bienvenida", 0], ["paso 1", 1], ["paso 2", 2], ["paso 3", 3]]) {
            const m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub());
            await esperar(() => q(".tut-overlay"), 3000);
            for (let i = 0; i < avanzar; i++) {
                click(boton(i === 0 ? "Empezar" : "Siguiente"));
                await esperar(() => new RegExp(`Paso ${i + 1} de 3`).test(texto(".tut-coach-paso") || ""), 1000);
            }
            const saltar = q(".tut-saltar");
            ok(!!saltar && /Saltar|saltar/.test(saltar.textContent), `'Saltar' visible en ${donde}`);
            click(saltar);
            await esperar(() => !q(".tut-overlay"), 1500);
            ok(!q(".tut-overlay"), `Saltar en ${donde} cierra el tutorial`);
            ok(llamadas(m, "shalom_tutorial_terminar").length === 1, `Saltar en ${donde} llama shalom_tutorial_terminar una vez`);
            ok(!!q(".progreso-juego") && !!q(".segmented"), "la pestaña Rutas sigue ahí");
            m.destruir();
        }
    };

    // =====================================================================
    escenarios.tutorial_ya_visto = async function () {
        console.log("\n[Tutorial] solo se muestra si no se vio; se puede repasar desde el panel");
        const m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub({
            [`${E}.shalom_tutorial_estado`]: {disponible: true, visto: true, mostrar: false, nombre: "Andrés"},
        }));
        await esperar(() => q(".progreso-juego"), 2000);
        await sleep(60);
        ok(!q(".tut-overlay"), "con mostrar=false el tutorial NO aparece");
        ok(llamadas(m, "shalom_tutorial_terminar").length === 0, "y no se llama terminar");

        m.destruir();

        // sin fsm.person: tampoco
        const m2 = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub({
            [`${E}.shalom_tutorial_estado`]: {disponible: false, visto: true, mostrar: false, nombre: ""},
        }));
        await sleep(100);
        ok(!q(".tut-overlay"), "sin fsm.person vinculado no hay tutorial");
        m2.destruir();

        // repaso desde el panel
        const m3 = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub({
            [`${E}.shalom_tutorial_estado`]: {disponible: true, visto: true, mostrar: false, nombre: "Andrés"},
        }));
        await esperar(() => q(".progreso-juego"), 2000);
        click(q(".progreso-juego"));
        ok(await esperar(() => q(".jp-overlay"), 1500), "tocar la tarjeta de nivel abre el panel de juego");
        click(boton("Repasar el tutorial"));
        ok(await esperar(() => q(".tut-overlay") && !q(".jp-overlay"), 1500), "'Repasar el tutorial' cierra el panel y abre el tutorial");
        click(boton("Empezar"));
        await esperar(() => q(".tut-coach-paso"), 1000);
        ok(/Paso 1 de 3/.test(texto(".tut-coach-paso")), "el repaso arranca igual");
        click(q(".tut-saltar"));
        await esperar(() => !q(".tut-overlay"), 1500);
        ok(!q(".tut-overlay"), "Saltar cierra el repaso");
        ok(llamadas(m3, "shalom_tutorial_terminar").length === 0, "un repaso NO vuelve a marcar nada en el servidor");
        m3.destruir();
    };

    // =====================================================================
    escenarios.tutorial_rpc_falla = async function () {
        console.log("\n[Tutorial / Rutas] si las RPC del juego fallan, Rutas sigue funcionando");
        const boom = () => { throw new Error("servidor caído"); };
        const m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub({
            [`${E}.shalom_tutorial_estado`]: boom,
            [`${E}.shalom_mis_logros`]: boom,
            [`${E}.shalom_equipo_mes`]: boom,
            [`${E}.shalom_temporada`]: boom,
        }));
        // montar() limpia localStorage: la vista de lista se pide a mano
        m.comp.cambiarVista("lista");
        await esperar(() => qa(".route-card").length === 1, 2000);
        await sleep(80);
        ok(qa(".route-card").length === 1, "la lista de rutas se pinta aunque fallen las RPC del juego");
        ok(!q(".tut-overlay"), "sin estado del tutorial, no hay tutorial (no atrapa al vendedor)");
        ok(!!q(".progreso-juego"), "la tarjeta de nivel sigue (shalom_mi_progreso sí respondió)");
        ok(m.errores.length === 0, "sin rechazos no manejados", m.errores);
        // el panel con todo roto: cada pestaña muestra su aviso, no explota
        click(q(".progreso-juego"));
        await esperar(() => q(".jp-error"), 1500);
        ok(!!q(".jp-error") && !!boton("Reintentar"), "pestaña Logros: aviso con 'Reintentar'");
        click(qa(".jp-pestanas button")[1]);
        await esperar(() => q(".jp-error"), 1500);
        ok(!!q(".jp-error"), "pestaña Equipo: aviso con 'Reintentar'");
        click(qa(".jp-pestanas button")[2]);
        await esperar(() => q(".jp-error"), 1500);
        ok(!!q(".jp-error"), "pestaña Temporada: aviso con 'Reintentar'");
        click(q(".jp-cabecera .icon-btn"));
        await sleep(40);
        ok(!q(".jp-overlay") && qa(".route-card").length === 1, "se cierra el panel y Rutas sigue igual");
        m.destruir();

        // terminar() falla: el tutorial se cierra igual
        const m2 = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub({
            [`${E}.shalom_tutorial_terminar`]: boom,
        }));
        await esperar(() => q(".tut-overlay"), 2000);
        click(boton("Ya sé jugar"));
        await esperar(() => !q(".tut-overlay"), 1500);
        ok(!q(".tut-overlay"), "si shalom_tutorial_terminar falla, 'Saltar' cierra el tutorial igual");
        m2.destruir();
    };

    // =====================================================================
    escenarios.hub_logros_xp = async function () {
        console.log("\n[RutasHub] recoge los logros antes de leer el nivel");
        const m = await montar(bundle.RutasHub, {onAbrirRuta() {}}, handlersHub({
            [`${E}.shalom_tutorial_estado`]: {disponible: true, visto: true, mostrar: false, nombre: "A"},
        }));
        await esperar(() => q(".progreso-juego"), 2000);
        const orden = m.log.map((c) => c.method).filter((x) => x === "shalom_mis_logros" || x === "shalom_mi_progreso");
        ok(orden[0] === "shalom_mis_logros" && orden[1] === "shalom_mi_progreso", "primero shalom_mis_logros (otorga) y luego shalom_mi_progreso", orden);
        ok(/1 logro\(s\) hoy/.test(texto(".progreso-juego-link")), "la tarjeta avisa de los logros de hoy", texto(".progreso-juego-link"));
        ok(/Logros, equipo y temporada/.test(texto(".progreso-juego-link")), "invita a abrir el panel");
        m.destruir();
    };

    // =====================================================================
    escenarios.panel_pestanas = async function () {
        console.log("\n[JuegoPanel] Logros / Equipo / Temporada");
        let cerrado = 0, repaso = 0;
        const m = await montar(bundle.JuegoPanel, {onCerrar: () => cerrado++, onRepasarTutorial: () => repaso++}, handlersHub());
        await esperar(() => q(".jp-logro"), 2000);
        ok(qa(".jp-pestanas button").map((b) => b.textContent.trim()).join("|") === "Logros|Equipo|Temporada", "tres pestañas: Logros | Equipo | Temporada");
        ok(llamadas(m, "shalom_mis_logros").length === 1 && llamadas(m, "shalom_equipo_mes").length === 0, "al abrir solo carga Logros (las otras, al entrar)");
        ok(/2\s*de 5 logros/.test(texto(".jp-resumen-grande")), "resumen '2 de 5 logros'", texto(".jp-resumen-grande"));
        ok(/este mes: 2 nuevos/.test(texto(".jp-resumen-chico")) && /250 XP en logros/.test(texto(".jp-resumen-chico")), "este mes: 2 nuevos · 250 XP", texto(".jp-resumen-chico"));
        const nombres = qa(".jp-logro .jp-logro-texto b").map((b) => b.textContent);
        ok(nombres[0] === "Oro", "el logro ganado HOY va primero", nombres);
        ok(qa(".jp-logro-hecho").length === 2 && !!q(".jp-etiqueta-hoy"), "2 logros ganados y la etiqueta HOY");
        ok(qa(".jp-barra").length === 3, "los pendientes muestran barra de progreso (3)", qa(".jp-barra").length);
        ok(/1\/3/.test(texto(".jp-lista")) || /2\/5/.test(texto(".jp-lista")), "progreso numérico visible");
        ok(/450\/600/.test(texto(".jp-lista")), "el logro Nivel 2 muestra 450/600");
        click(boton("Repasar el tutorial"));
        ok(repaso === 1, "'Repasar el tutorial' avisa al padre");

        // Equipo (sin camión: no existe el parámetro)
        click(qa(".jp-pestanas button")[1]);
        await esperar(() => q(".jp-equipo-total"), 1500);
        ok(llamadas(m, "shalom_equipo_mes").length === 1 && llamadas(m, "shalom_equipo_mes")[0].args.length === 0, "shalom_equipo_mes() sin argumentos");
        ok(texto(".jp-equipo-total") === "$41,900", "ventas del equipo $41,900", texto(".jp-equipo-total"));
        ok(/faltan \$18,100 para el piso/.test(texto(".jp-equipo-faltan")), "faltan $18,100 para el piso");
        ok(/PISO \$60,000/.test(texto(".jp-meta-leyenda")) && /JEFE \$80,000/.test(texto(".jp-meta-leyenda")), "leyenda de piso y jefe final");
        ok(/Quedan 11 días hábiles/.test(texto(".jp-equipo-ritmo")) && /\$1,645 por día/.test(texto(".jp-equipo-ritmo")), "ritmo necesario por día hábil", texto(".jp-equipo-ritmo"));
        ok(!q(".jp-camion"), "SIN camión del día cuando el servidor no lo manda");
        ok(/no hay tabla de posiciones/.test(texto(".jp-nota")), "nota cooperativa: no hay tabla de posiciones");
        ok(!/posici[oó]n \d|ranking|#1|primer lugar/i.test(texto(".jp-cuerpo")), "no hay ranking ni posiciones");
        ok(/Piso del mes/.test(texto(".jp-cuerpo")) && /70%/.test(texto(".jp-cuerpo")) && /bloqueado/.test(texto(".jp-cuerpo")), "cofres: piso al 70% y jefe final bloqueado", texto(".jp-cuerpo"));

        // Temporada (sin premios definidos)
        click(qa(".jp-pestanas button")[2]);
        await esperar(() => q(".jp-hito"), 1500);
        ok(qa(".jp-hito").length === 12, "12 hitos de temporada");
        ok(/Nivel\s*2\s*de 12/.test(texto(".jp-temp-nivel")), "nivel de temporada 2 de 12", texto(".jp-temp-nivel"));
        ok(/900 XP de la temporada/.test(texto(".jp-temp-xp")), "XP de la temporada");
        ok(/Faltan 400 XP para el nivel 3/.test(texto(".jp-temp-proximo")), "faltan 400 XP para el nivel 3");
        ok(/× 1.5 XP/.test(texto(".jp-bono")) && /quedan 4 días/.test(texto(".jp-bono")), "bono de la primera quincena visible", texto(".jp-bono"));
        ok(qa(".jp-hito-listo").length === 2 && qa(".jp-hito-actual").length === 1, "2 hitos listos y 1 siguiente");
        ok(!/Marco|Cena|premio/i.test(texto(".jp-cuerpo")), "SIN premios definidos no se muestra ninguno");

        // volver a una pestaña ya cargada no repite la RPC
        click(qa(".jp-pestanas button")[0]);
        click(qa(".jp-pestanas button")[1]);
        await sleep(40);
        ok(llamadas(m, "shalom_mis_logros").length === 1 && llamadas(m, "shalom_equipo_mes").length === 1, "cada pestaña se carga una sola vez");
        click(q(".jp-cabecera .icon-btn"));
        ok(cerrado === 1, "← llama onCerrar");
        ok(m.errores.length === 0, "sin rechazos no manejados", m.errores);
        m.destruir();
    };

    // =====================================================================
    escenarios.panel_camion_y_premios = async function () {
        console.log("\n[JuegoPanel] camión del día solo si existe; premios solo si están definidos");
        const camion = {meta: 9000, vendido: 10500, pct: 116.7, lleno: true};
        const m = await montar(bundle.JuegoPanel, {onCerrar() {}, pestana: "equipo"}, handlersHub({
            [`${E}.shalom_equipo_mes`]: {...EQUIPO, camion, ventas: 62000, pct_piso: 103.3, faltan_piso: 0, piso_alcanzado: true, ritmo_piso: 0},
            [`${E}.shalom_temporada`]: TEMPORADA({3: "Cena para dos", 6: "Marco dorado"}),
        }));
        await esperar(() => q(".jp-equipo-total"), 1500);
        ok(!!q(".jp-camion"), "con camión en la respuesta, se muestra");
        ok(/\$10,500 de \$9,000/.test(texto(".jp-camion")) && /lleno/.test(texto(".jp-camion")), "camión: $10,500 de $9,000 · lleno", texto(".jp-camion"));
        ok(/Piso del mes asegurado/.test(texto(".jp-equipo-estado")) && qa(".jp-cofre-abierto").length === 1, "piso alcanzado: aviso y cofre abierto", texto(".jp-equipo-estado"));
        ok(/jefe final/.test(texto(".jp-equipo-faltan")), "ahora muestra lo que falta para el jefe final");
        click(qa(".jp-pestanas button")[2]);
        await esperar(() => q(".jp-hito"), 1500);
        const premios = qa(".jp-hito").filter((h) => /Cena para dos|Marco dorado/.test(h.textContent));
        ok(premios.length === 2, "con premios definidos, aparecen en su nivel", premios.length);
        ok(/Cena para dos/.test(qa(".jp-hito")[2].textContent), "el premio del nivel 3 está en la fila del nivel 3");
        m.destruir();

        // respuesta null: usuario sin fsm.person
        const m2 = await montar(bundle.JuegoPanel, {onCerrar() {}}, handlersHub({[`${E}.shalom_mis_logros`]: null}));
        await esperar(() => q(".jp-aviso"), 1500);
        ok(/no tiene un vendedor vinculado/.test(texto(".jp-aviso")), "respuesta null -> aviso de vendedor no vinculado");
        m2.destruir();

        // error y reintento
        let intento = 0;
        const m3 = await montar(bundle.JuegoPanel, {onCerrar() {}, pestana: "equipo"}, handlersHub({
            [`${E}.shalom_equipo_mes`]: () => { if (++intento === 1) throw new Error("falló"); return EQUIPO; },
        }));
        await esperar(() => q(".jp-error"), 1500);
        click(boton("Reintentar"));
        await esperar(() => q(".jp-equipo-total"), 1500);
        ok(intento === 2 && texto(".jp-equipo-total") === "$41,900", "Reintentar vuelve a llamar y muestra los datos");
        m3.destruir();
    };

    // =====================================================================
    escenarios.panel_atras = async function () {
        console.log("\n[JuegoPanel] Atrás de Android (back_stack.js)");
        window.history.replaceState(null, "", "/odoo/");
        const pila = () => JSON.parse(sessionStorage.getItem("shalom_pila_navegacion") || "[]");
        const m = await montar(bundle.JuegoPanel, {onCerrar() {}}, handlersHub());
        await esperar(() => q(".jp-logro"), 1500);
        ok(JSON.stringify(pila().map((n) => n.tipo)) === '["juego_panel"]' && window.history.state.shalomProfundidad === 1, "al abrir empuja su nivel en la pila", {pila: pila(), estado: window.history.state});
        m.destruir();
        ok(pila().length === 0 && window.history.state.shalomProfundidad === 0, "al desmontarse saca su nivel (profundidad 0)", {pila: pila(), estado: window.history.state});

        // App completa: abrir el panel y Atrás real -> vuelve a Rutas con el panel cerrado
        window.history.replaceState(null, "", "/odoo/");
        const h = handlersHub({[`${E}.shalom_tutorial_estado`]: {disponible: true, visto: true, mostrar: false, nombre: "A"}});
        let a = await montar(bundle.ShalomRutaApp, {}, h);
        await esperar(() => q(".progreso-juego"), 2000);
        click(q(".progreso-juego"));
        await esperar(() => q(".jp-overlay"), 1500);
        ok(JSON.stringify(pila().map((n) => n.tipo)) === '["juego_panel"]', "en la app completa la pila = [juego_panel]", pila());
        window.history.back();
        await sleep(80);
        a.destruir();                       // Odoo recarga la acción del cliente
        const limpiar = window.Storage.prototype.clear;
        window.Storage.prototype.clear = function () {};   // montar() limpiaría la pila que queremos conservar
        a = await montar(bundle.ShalomRutaApp, {}, h);
        window.Storage.prototype.clear = limpiar;
        await esperar(() => q(".progreso-juego"), 2000);
        await sleep(60);
        ok(!q(".jp-overlay") && !!q(".progreso-juego"), "tras el Atrás real: Rutas visible y el panel cerrado");
        ok(pila().length === 0, "y la pila queda vacía", pila());
        a.destruir();
    };

    // =====================================================================
    escenarios.social_css = async function () {
        console.log("\n[Estilos 6A] juego_social.scss: compila, solo variables --shalom-*, clases con regla, contraste");
        const sass = require(require.resolve("sass", {paths: ["/tmp/owl_check", __dirname]}));
        const dir = path.join(MOD, "static/src/scss");
        const social = sass.compile(path.join(dir, "juego_social.scss")).css;
        const base = sass.compile(path.join(dir, "ruta_shalom.scss")).css;
        ok(social.length > 500, "juego_social.scss compila");
        const fuente = fs.readFileSync(path.join(dir, "juego_social.scss"), "utf8").replace(/\/\/.*$/gm, "");
        ok(!/#[0-9a-fA-F]{3,8}\b/.test(fuente), "sin colores hexadecimales sueltos");
        ok(!/\brgba?\(|\bhsla?\(/.test(fuente), "sin colores rgb/hsl sueltos (todo por variables)");
        ok(/^\.o_shalom_ruta_app[^{]*\{/m.test(social), "las reglas salen bajo .o_shalom_ruta_app");
        const fuera = social.split("\n").filter((l) => /^[.#a-z][^{]*\{$/.test(l) && !l.startsWith(".o_shalom_ruta_app"));
        ok(fuera.length === 0, "ninguna regla fuera de .o_shalom_ruta_app", fuera.slice(0, 3));
        // variables usadas vs definidas
        const definidas = new Set([...base.matchAll(/(--shalom-[a-z0-9_-]+)\s*:/g)].map((x) => x[1]));
        const usadas = [...new Set([...social.matchAll(/var\((--[a-z0-9_-]+)/g)].map((x) => x[1]))];
        ok(usadas.every((v) => v.startsWith("--shalom-")), "solo variables --shalom-*", usadas.filter((v) => !v.startsWith("--shalom-")));
        ok(usadas.every((v) => definidas.has(v)), "todas las variables usadas están definidas en ruta_shalom.scss", usadas.filter((v) => !definidas.has(v)));
        // clases de las plantillas con regla
        const xml = ["tutorial.xml", "juego_panel.xml"].map((f) => fs.readFileSync(path.join(MOD, "static/src/xml/ruta_shalom", f), "utf8")).join("\n");
        const clases = new Set();
        for (const mm of xml.matchAll(/class="([^"]+)"/g)) mm[1].split(/\s+/).forEach((c) => /^(tut|jp)-/.test(c) && clases.add(c));
        for (const mm of xml.matchAll(/\{\{[^}]*\}\}|'(jp-[a-z-]+|tut-[a-z-]+)'/g)) { const c = mm[1]; if (c) clases.add(c); }
        for (const c of ["jp-logro-hecho", "jp-cofre-abierto", "jp-hito-listo", "jp-hito-actual", "tut-mision-hecha"]) clases.add(c);
        const sinRegla = [...clases].filter((c) => !new RegExp("\\." + c + "(?![a-z-])").test(social));
        ok(sinRegla.length === 0, `todas las clases tut-*/jp-* (${clases.size}) tienen regla`, sinRegla);
        // contraste (WCAG) de los pares que usa el diseño, claro y oscuro
        const bloques = {claro: {}, oscuro: {}};
        for (const mm of base.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            const sel = mm[1].trim();
            const vars = {};
            for (const v of mm[2].matchAll(/(--shalom-[a-z0-9_-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) vars[v[1]] = v[2];
            if (!Object.keys(vars).length) continue;
            if (sel === ".o_shalom_ruta_app") Object.assign(bloques.claro, vars);
            else if (/oscuro/.test(sel)) Object.assign(bloques.oscuro, vars);
        }
        const lum = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const razon = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, r) => r - p); return (x + 0.05) / (y + 0.05); };
        // [texto, fondo, mínimo]: 4.5 texto normal; 3 para los símbolos grandes (estrellas)
        const pares = [["ink", "bg", 4.5], ["ink", "surface", 4.5], ["ink-muted", "bg", 4.5], ["ink-muted", "surface", 4.5], ["ink-muted", "surface-2", 4.5],
            ["accent", "bg", 4.5], ["accent", "surface", 4.5], ["accent", "accent-soft", 4.5], ["accent-ink", "accent", 4.5], ["accent-ink", "completado", 4.5],
            ["ink", "accent-soft", 4.5], ["stock-success-ink", "stock-success-bg", 4.5], ["stock-warning-ink", "stock-warning-bg", 4.5],
            ["info", "info-soft", 4.5], ["alerta", "bg", 4.5], ["estrella-1", "surface", 3], ["estrella-2", "surface", 3], ["estrella-3", "surface", 3]];
        for (const tema of ["claro", "oscuro"]) {
            const v = Object.assign({}, bloques.claro, tema === "oscuro" ? bloques.oscuro : {});
            const malos = pares.filter(([a, b, min]) => !v["--shalom-" + a] || !v["--shalom-" + b] || razon(v["--shalom-" + a], v["--shalom-" + b]) < min)
                .map(([a, b, min]) => `${a}/${b}=${v["--shalom-" + a] && v["--shalom-" + b] ? razon(v["--shalom-" + a], v["--shalom-" + b]).toFixed(2) : "?"}<${min}`);
            ok(malos.length === 0, `contraste suficiente en tema ${tema} (${pares.length} pares)`, malos);
        }
    };
};
