/** @odoo-module **/

/**
 * Pila de navegación propia de "Ruta Shalom", para que el botón/gesto
 * Atrás de Android cierre un nivel de la app (pestaña, ruta, hoja de
 * visita, catálogo/carrito, ficha de cliente) a la vez, en vez de
 * salir del módulo entero -- pedido explícito del usuario.
 *
 * Ya se había intentado esto antes con history.pushState/popstate
 * propios y se sacó por completo (ver los comentarios grandes al
 * principio de order_screen.js y visit_sheet.js): el problema no era
 * usar el historial en sí, sino llamar a history.back() desde acá --
 * eso es una navegación real de ida y vuelta que compite con el router
 * propio del web client de Odoo 18 por el MISMO historial del
 * navegador (síntoma real reportado: un history.back() nuestro se
 * "comía" el doAction() que abría la cotización después de guardar el
 * borrador del carrito).
 *
 * Esta vez el mecanismo es distinto, pensado para no volver a chocar
 * con eso -- nunca se llama a history.back(), solo a
 * history.pushState(), siempre hacia ADELANTE:
 *
 * - Mientras no hay NADA nuestro abierto (pila vacía -- hub de Rutas)
 *   no se empuja ninguna entrada de más: así un Atrás de Android desde
 *   ahí sale del módulo al primer toque, en vez de necesitar uno de
 *   más "en vacío" para gastar una trampa que no hacía falta.
 * - Apenas se abre el PRIMER nivel (abrirNivel(), pila 0 -> 1) se
 *   empuja una única "entrada trampa", con la MISMA URL que ya había
 *   (no se toca el hash -- Odoo no ve ningún cambio de acción/vista
 *   con esto, así que su propio router no reacciona en absoluto).
 *   Niveles siguientes (2, 3, ...) NO empujan una trampa cada uno --
 *   una sola entrada alcanza, porque cada vez que el Atrás la consume
 *   se repone al toque (ver alPopstate) antes de resolver el nivel de
 *   arriba, así queda lista para el próximo Atrás sin importar cuántos
 *   niveles falten. Cerrar un nivel desde su propio control (no por
 *   Atrás) tampoco empuja ni saca nada del historial real -- no hay
 *   forma de "deshacer" un pushState sin una navegación real de por
 *   medio, así que la entrada trampa ya puesta se deja como está
 *   (huérfana hasta el próximo Atrás real, que la consume sin efecto
 *   si para entonces ya no queda nada nuestro abierto -- a lo sumo un
 *   Atrás de más "en vacío" una sola vez por sesión, nunca uno por
 *   cada apertura/cierre).
 * - Cuando el Atrás consume la trampa: si hay algo nuestro abierto, se
 *   repone la trampa y se resuelve el nivel de arriba llamando a su
 *   propia función de cierre -- la MISMA que ya usa ese nivel para
 *   cerrarse desde su propio control ("←", backdrop, arrastrar la
 *   hoja). Si no hay nada nuestro abierto, no se hace nada: el Atrás
 *   sigue su curso normal (puede ser el "de más" huérfano de arriba, o
 *   directo la entrada real de Odoo si nunca se abrió nada) y termina
 *   sacando al vendedor del módulo, que es lo correcto ahí.
 * - Cualquier doAction() real de Odoo hacia afuera de esta app (abrir
 *   una cotización, el historial de compras) reemplaza la acción
 *   actual y desmonta ShalomRutaApp entero -- su onWillUnmount llama a
 *   desinstalarBackStack(), así que no queda ESTE listener escuchando
 *   popstate mientras el vendedor navega por la pantalla nativa de
 *   Odoo a la que se haya ido.
 */

const pila = [];
let instalado = false;
let trampaPresente = false;

function pushTrampa() {
    trampaPresente = true;
    history.pushState({shalomTrampa: true}, "", window.location.href);
}

function alPopstate() {
    trampaPresente = false; // la que hubiera (si la había) se acaba de consumir
    if (!pila.length) {
        // Nivel raíz: se deja que el Atrás real del navegador siga su
        // curso (sale del módulo, o consume una trampa huérfana sin
        // efecto -- ver el comentario grande de arriba), es lo que
        // corresponde acá.
        return;
    }
    pushTrampa(); // la repone para el próximo Atrás, antes de resolver este nivel
    const cerrarNivelActual = pila.pop();
    cerrarNivelActual();
}

/**
 * Se llama una sola vez, al montar el shell de la app (ShalomRutaApp).
 * instalado evita duplicar el listener si por algún motivo se llegara
 * a llamar dos veces sin pasar por desinstalarBackStack() en el medio.
 */
export function instalarBackStack() {
    if (instalado) {
        return;
    }
    instalado = true;
    window.addEventListener("popstate", alPopstate);
}

/**
 * Se llama al desmontar ShalomRutaApp -- deja todo limpio para la
 * próxima vez que se entre al módulo, y sobre todo evita que este
 * listener siga vivo escuchando popstate mientras el vendedor navega
 * por la pantalla de Odoo a la que se haya ido (ver el comentario
 * grande de arriba).
 */
export function desinstalarBackStack() {
    instalado = false;
    trampaPresente = false;
    pila.length = 0;
    window.removeEventListener("popstate", alPopstate);
}

/**
 * Registra un nivel nuevo -- `cerrarFn` es la MISMA función que ese
 * nivel ya usa para cerrarse desde su propio control. Se llama al
 * ABRIR ese nivel (típicamente en setup(), justo cuando el componente
 * se monta -- ver el patrón ya aplicado en visit_sheet.js/
 * order_screen.js/cliente_form.js).
 */
export function abrirNivel(cerrarFn) {
    if (!pila.length && !trampaPresente) {
        pushTrampa();
    }
    pila.push(cerrarFn);
}

/**
 * Saca un nivel de la pila -- se llama al cerrar ese nivel por
 * cualquier vía que no sea el Atrás de Android (que ya lo saca solo en
 * alPopstate). Idempotente y por identidad de función (no asume que
 * sea el de arriba): un segundo llamado, o uno para un nivel que ya no
 * está, no hace nada -- así el mismo método de cierre de siempre puede
 * llamar a esto sin importar si el Atrás ya se adelantó.
 */
export function cerrarNivel(cerrarFn) {
    const idx = pila.lastIndexOf(cerrarFn);
    if (idx !== -1) {
        pila.splice(idx, 1);
    }
}
