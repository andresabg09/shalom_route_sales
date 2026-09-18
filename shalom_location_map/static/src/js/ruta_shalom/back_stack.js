/** @odoo-module **/

/**
 * Historial de navegación propio de "Ruta Shalom" -- para que el
 * botón/gesto Atrás de Android cierre un nivel de la app (pestaña,
 * ruta, hoja de visita, catálogo/carrito, ficha de cliente) a la vez,
 * en vez de salir del módulo entero o saltar directo al hub.
 *
 * SEGUNDO rediseño de este mecanismo (ver git log para el primero,
 * basado en una "pila" en memoria + un listener de popstate propio).
 * Ese primer diseño funcionaba bien en su propia lógica (confirmado
 * con un diagnóstico en pantalla: contaba los niveles abiertos
 * correctamente), pero se descubrió en producción que NO ALCANZA:
 * Odoo mismo, al recibir CUALQUIER evento popstate -- incluso uno con
 * la misma URL, como el que generábamos nosotros -- decide recargar
 * la acción del cliente (ShalomRutaApp) desde cero, sin esperar a que
 * el código de esta app termine de reaccionar. No importa qué tan
 * rápido reaccionemos nosotros: la instancia vieja (con toda la
 * lógica en memoria ya corrida) queda huérfana, y lo que se ve en
 * pantalla es la instancia NUEVA, que arranca en su estado inicial
 * (el hub). Por eso "←"/backdrop (que nunca tocan el historial del
 * navegador) siempre funcionaron perfecto, y cualquier Atrás real
 * (botón, gesto, navegador) rompía todo, sin importar cuántos niveles
 * hubiera abiertos.
 *
 * Este diseño ya NO intenta interceptar ni "ganarle" a Odoo -- deja
 * que recargue lo que quiera, y en cambio se apoya en dos cosas que
 * SÍ sobreviven ese recargado:
 *
 * - `history.state` -- lo mantiene el navegador mismo, no nuestro
 *   código. Cada vez que se abre un nivel, se empuja una entrada real
 *   al historial (history.pushState) etiquetada con la PROFUNDIDAD
 *   resultante ({shalomProfundidad: N}). Cerrar un nivel desde su
 *   propio control (no por Atrás) usa history.replaceState (NO
 *   pushState) con la profundidad ya restada -- así no crece el
 *   historial real por cada apertura/cierre por UI, solo se corrige
 *   la etiqueta de la entrada actual.
 * - sessionStorage -- guarda el CONTENIDO de cada nivel (qué ruta, qué
 *   visita, etc.), como una lista ordenada. Sobrevive tanto un
 *   recargado de Odoo como un doAction() real hacia afuera de la app
 *   (Historial, Examinar cotización, el redirect de Revisar
 *   cotización) y la vuelta -- así este MISMO mecanismo cubre también
 *   ese caso, sin necesitar un marcador aparte (lo que antes hacía
 *   retorno_navegacion.js, ahora innecesario y eliminado).
 *
 * Cada vez que ShalomRutaApp arranca -- sin importar POR QUÉ (Atrás
 * real, Odoo recargando solo, volver de Ventas, entrar de nuevo desde
 * el menú) -- lee leerPilaActual(): la profundidad real la dice
 * `history.state` (que el navegador siempre tiene bien puesto, pase
 * lo que pase con nuestro código), y con eso se trunca la lista
 * guardada a esa profundidad exacta. Ya no hace falta "interceptar"
 * el Atrás ni pelear con Odoo -- cada vez que recarga, se reconstruye
 * la pantalla correcta a partir de esos datos.
 *
 * Reconstrucción en cascada: ShalomRutaApp interpreta el nivel 0 (o el
 * último nivel de tipo "ruta"/"tab" de la lista, ver app.js) para
 * saber la pantalla superior, y pasa el RESTO de la lista hacia abajo
 * como prop (a RutaDetalle, que a su vez pasa lo que sobre a
 * VisitSheet, que a su vez pasa lo que sobre a OrderScreen) -- cada
 * componente solo mira el primer elemento de lo que le llega para
 * decidir si abrir su propio nivel hijo, mismo patrón en cada uno.
 *
 * Los niveles de "ficha de cliente" (ClienteForm, se abre desde 4
 * lugares distintos) participan del conteo de profundidad (empujan y
 * cierran su propio nivel) pero NO se reconstruyen solos tras un
 * recargado -- no hace falta: cualquier recargado que ocurra MIENTRAS
 * ClienteForm está abierto es, por definición, la consecuencia del
 * mismo Atrás que lo está cerrando, nunca algo que haya que "reabrir".
 * Por el mismo motivo, el aviso de "salir sin guardar" de ClienteForm
 * ya no puede interceptar el Atrás real (no hay forma de "cancelar"
 * una navegación real del navegador) -- mismo criterio ya aceptado
 * para el carrito de OrderScreen: se pierde el cambio sin aviso si se
 * sale por Atrás en vez del control propio.
 *
 * CASO APARTE -- "Historial"/"Examinar cotización"/el redirect de
 * "Revisar cotización" (los tres hacen un doAction() real hacia AFUERA
 * del módulo, a Ventas, con target "current"): acá `history.state` deja
 * de ser confiable. Odoo arma su PROPIO objeto de estado para esa nueva
 * acción -- no conserva `shalomProfundidad`, lo pisa -- así que cuando
 * se vuelve con Atrás, la entrada a la que se cae ya no trae nuestra
 * marca (confirmado en producción: sin este marcador aparte, ese Atrás
 * caía siempre en el hub, aunque la pila guardada en sessionStorage
 * seguía teniendo la visita/ruta bien registradas -- SOLO la lectura de
 * la profundidad fallaba). marcarRetorno()/el chequeo en
 * leerPilaActual() de más abajo resuelven justo ese caso: un marcador
 * chico y aparte en sessionStorage (que Odoo no toca para nada) con la
 * profundidad de ANTES de salir, consumido una sola vez al volver a
 * montar. El resto del mecanismo (pila con el contenido de cada nivel,
 * reconstrucción en cascada) es el mismo -- esto solo tapa el agujero
 * de esa lectura puntual de profundidad.
 */

const CLAVE_PILA = "shalom_pila_navegacion";

function leerPilaCruda() {
    try {
        const crudo = sessionStorage.getItem(CLAVE_PILA);
        const pila = crudo ? JSON.parse(crudo) : [];
        return Array.isArray(pila) ? pila : [];
    } catch (error) {
        // sessionStorage puede fallar (modo privado, cuota, etc.) --
        // se sigue funcionando sin memoria de navegación, no bloquea
        // nada más.
        return [];
    }
}

function guardarPilaCruda(pila) {
    try {
        sessionStorage.setItem(CLAVE_PILA, JSON.stringify(pila));
    } catch (error) {
        // ver leerPilaCruda
    }
}

/**
 * Abrir un nivel: agrega `descriptor` (objeto plano, serializable --
 * ver los distintos {tipo: "..."} usados en app.js/ruta_detalle.js/
 * visit_sheet.js/order_screen.js/clientes.js/cliente_form.js) al
 * final de la lista guardada, y empuja una entrada REAL al historial
 * del navegador etiquetada con la profundidad resultante -- es lo que
 * le da al Atrás de Android algo que consumir para volver acá.
 */
export function abrirNivel(descriptor) {
    const pila = leerPilaCruda();
    pila.push(descriptor);
    guardarPilaCruda(pila);
    try {
        history.pushState({shalomProfundidad: pila.length}, "", window.location.href);
    } catch (error) {
        // pushState no debería fallar en la práctica, pero por las
        // dudas no se deja sin capturar -- peor es un error sin
        // manejar que perder la sincronía del historial.
    }
    // Devuelve la profundidad resultante -- la usan callers como
    // app.js:abrirRuta() para recordar "a qué profundidad truncar" si
    // más adelante hace falta cerrar este nivel y todo lo que se haya
    // abierto encima de un solo golpe (ver cerrarNivelesHasta()).
    return pila.length;
}

/**
 * Cerrar el nivel de arriba desde SU PROPIO control ("←", backdrop,
 * arrastrar la hoja, Cancelar/Guardar) -- nunca desde el Atrás real
 * (ese no pasa por acá, se resuelve solo al recargar, ver
 * leerPilaActual()). Saca el último elemento de la lista guardada y
 * usa replaceState (NO pushState): no debe crecer el historial real
 * por cada apertura/cierre hecho con los controles propios de la app,
 * solo corrige la etiqueta de profundidad de la entrada actual.
 */
export function cerrarNivel() {
    const pila = leerPilaCruda();
    pila.pop();
    guardarPilaCruda(pila);
    try {
        history.replaceState({shalomProfundidad: pila.length}, "", window.location.href);
    } catch (error) {
        // ver abrirNivel
    }
}

/**
 * Cierra de un solo golpe TODOS los niveles guardados por encima de
 * `profundidad` (0 = vaciar del todo). Hace falta para controles de UI
 * que saltan varios niveles a la vez en una sola acción -- por ejemplo
 * el "←" de RutaDetalle (app.js:volverARutas()): esa topbar se muestra
 * siempre, así que se puede tocar aunque haya una visita/catálogo/
 * carrito abiertos encima, y en ese caso cerrarNivel() (un solo pop) no
 * alcanza -- dejaría la pila guardada (y por lo tanto history.state, en
 * la próxima llamada) con más niveles de los que en realidad se ven en
 * pantalla, así que el próximo Atrás REAL reaparecería en un nivel
 * intermedio ya cerrado en vez de salir del módulo.
 *
 * Igual que cerrarNivel(), usa replaceState (nunca pushState): cerrar
 * niveles desde un control propio de la app nunca debe hacer crecer el
 * historial real del navegador, solo corregir la etiqueta de
 * profundidad de la entrada actual.
 */
export function cerrarNivelesHasta(profundidad) {
    const pila = leerPilaCruda();
    const objetivo = Math.max(0, Math.min(profundidad, pila.length));
    pila.length = objetivo;
    guardarPilaCruda(pila);
    try {
        history.replaceState({shalomProfundidad: pila.length}, "", window.location.href);
    } catch (error) {
        // ver abrirNivel
    }
}

const CLAVE_RETORNO = "shalom_retorno_profundidad";
const RETORNO_TTL_MS = 15 * 60 * 1000; // 15 min -- mismo criterio que usaba retorno_navegacion.js

/**
 * Llamar justo ANTES de un doAction() real hacia AFUERA del módulo
 * (Historial, Examinar cotización, el redirect de Revisar cotización) --
 * ver el bloque "CASO APARTE" del comentario grande de arriba para el
 * motivo. Guarda la profundidad ACTUAL (antes de salir) en un marcador
 * aparte de sessionStorage, con timestamp para que una marca vieja
 * nunca quede pisando una vuelta futura.
 */
export function marcarRetorno() {
    try {
        const profundidad = leerPilaCruda().length;
        sessionStorage.setItem(
            CLAVE_RETORNO,
            JSON.stringify({profundidad, ts: Date.now()})
        );
    } catch (error) {
        // ver leerPilaCruda -- sin marcador, simplemente no se restaura
        // (cae al hub, comportamiento de siempre).
    }
}

/** Lee y SIEMPRE borra el marcador de marcarRetorno() -- una marca
 * vieja/corrupta nunca debe quedar pisando la próxima entrada. Devuelve
 * la profundidad guardada, o null si no hay nada, está corrupta, le
 * falta el campo, o pasaron más de RETORNO_TTL_MS. */
function leerYLimpiarRetorno() {
    try {
        const crudo = sessionStorage.getItem(CLAVE_RETORNO);
        sessionStorage.removeItem(CLAVE_RETORNO);
        if (!crudo) {
            return null;
        }
        const marca = JSON.parse(crudo);
        if (!marca || typeof marca.profundidad !== "number") {
            return null;
        }
        if (Date.now() - marca.ts > RETORNO_TTL_MS) {
            return null;
        }
        return marca.profundidad;
    } catch (error) {
        return null;
    }
}

/**
 * Se llama UNA sola vez, en ShalomRutaApp.setup() -- antes de armar el
 * estado inicial, para que la reconstrucción salga bien en el primer
 * render (sin un flash del hub antes de la pantalla real). Lee la
 * profundidad real actual de `history.state` (sobrevive cualquier
 * recargado de Odoo, sea por lo que sea) y devuelve la lista guardada
 * TRUNCADA a esa profundidad -- lista para que ShalomRutaApp
 * reconstruya la pantalla exacta a partir de ahí. Si la profundidad es
 * 0 (entrada real de Odoo sin nuestra marca -- primera vez que se
 * entra al módulo, o se entró de nuevo desde el menú) devuelve una
 * lista vacía: arranca en el hub, que es lo correcto ahí.
 *
 * Excepción: si hay un marcador de marcarRetorno() fresco (ver el
 * bloque "CASO APARTE" arriba), se usa SU profundidad en vez de la de
 * `history.state` -- que en ese caso puntual ya no es confiable, la
 * pisó el propio router de Odoo al navegar a Ventas y volver -- y de
 * paso se repara la entrada actual con replaceState para que los
 * PRÓXIMOS Atrás (ya sin marcador) vuelvan a poder confiar en
 * `history.state` normalmente.
 */
export function leerPilaActual() {
    let profundidad = 0;
    try {
        profundidad = (window.history.state && window.history.state.shalomProfundidad) || 0;
    } catch (error) {
        profundidad = 0;
    }
    const profundidadRetorno = leerYLimpiarRetorno();
    if (profundidadRetorno !== null) {
        profundidad = profundidadRetorno;
        try {
            history.replaceState({shalomProfundidad: profundidad}, "", window.location.href);
        } catch (error) {
            // ver abrirNivel
        }
    }
    const pila = leerPilaCruda().slice(0, profundidad);
    guardarPilaCruda(pila); // trunca también lo guardado, por si había de más
    return pila;
}
