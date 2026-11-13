/** @odoo-module **/

import {Component, onMounted, onWillUnmount, useState} from "@odoo/owl";

/**
 * Recorrido guiado (mockup aprobado "Recorrido guiado"): oscurece la
 * pantalla, resalta un botón con un borde y muestra un globo con flechita
 * y un texto corto, paso por paso ("Saltar" / "Siguiente").
 *
 * - Cada vendedor ve cada recorrido UNA vez, solo; queda guardado en el
 *   servidor por vendedor (fsm.person.x_recorridos_vistos), así que si
 *   cambia de celular no le vuelve a salir. El botón ? lo repite.
 * - Un paso cuyo botón no está en pantalla (p. ej. no hay clientes sin
 *   ventas) se salta solo.
 * - Si algo falla (RPC, botón que no aparece), el recorrido se cierra:
 *   nunca atrapa al vendedor.
 */

// Promesa compartida por toda la sesión: una sola consulta al servidor.
let VISTOS = null;

function recorridosVistos(orm) {
    if (!VISTOS) {
        VISTOS = orm
            .call("fsm.person", "shalom_recorridos_vistos", [])
            .then((r) => ({disponible: !!(r && r.disponible), vistos: new Set((r && r.vistos) || [])}))
            .catch(() => {
                VISTOS = null;
                return {disponible: false, vistos: new Set()};
            });
    }
    return VISTOS;
}

/** ¿Hay que mostrar este recorrido solo (el vendedor todavía no lo vio)? */
export async function recorridoPendiente(orm, codigo) {
    const estado = await recorridosVistos(orm);
    return estado.disponible && !estado.vistos.has(codigo);
}

export function marcarRecorrido(orm, codigo) {
    recorridosVistos(orm).then((estado) => estado.vistos.add(codigo));
    orm.call("fsm.person", "shalom_marcar_recorrido", [codigo]).catch(() => {});
}

const PASO_AYUDA = {
    selector: ".recorrido-ayuda-btn",
    titulo: "¿Lo quieres ver otra vez?",
    texto: "Toca este botón cuando quieras para repetir esta ayuda.",
};

export const PASOS_RUTA = [
    {
        selector: ".sin-ventas-toggle",
        titulo: "Clientes sin ventas",
        texto:
            "Por defecto solo ves los clientes que ya te han comprado. Tócalo para ver también los que nunca han comprado; tócalo otra vez para ocultarlos.",
    },
    {
        selector: ".search-row .search-box-live",
        titulo: "Buscar un cliente",
        texto:
            "Escribe el nombre del cliente. Si está en esta ruta, aparece en la lista. Si está en otra ruta, te sale el botón «Cambiar a …» para ir directo a él, por ejemplo cuando te pide productos fuera de tu ruta.",
    },
    PASO_AYUDA,
];

export const PASOS_CATALOGO = [
    {
        selector: ".catalogo-anteriores",
        titulo: "Pedidos anteriores",
        texto:
            "Abre los últimos pedidos de este cliente. Lo que ya está en el carrito sale marcado, y con «Agregar los que faltan» sumas solo lo que se te olvidó, sin duplicar.",
    },
    {
        selector: ".catalog-list .product-thumb-wrap",
        titulo: "La foto del producto",
        texto:
            "Tócala para verla en grande. Ahí, con doble toque o pellizcando con dos dedos, haces zoom para mostrársela al cliente.",
    },
    {
        selector: ".catalogo-barra .stock-toggle-btn",
        titulo: "Con stock",
        texto:
            "Encendido, solo ves los productos con existencia disponible (más de cero). Apágalo para ver todo el catálogo, también lo agotado.",
    },
    {
        selector: ".vista-toggle",
        titulo: "Lista o cuadrícula",
        texto:
            "Cambia cómo ves los productos: en lista (más productos a la vez) o en cuadrícula (fotos más grandes). Tu celular recuerda lo que elijas.",
    },
    PASO_AYUDA,
];

export class RecorridoGuiado extends Component {
    static template = "shalom_location_map.RecorridoGuiado";
    static props = {
        pasos: Array,
        titulo: String,
        // Devuelve el elemento dentro del cual se buscan los botones.
        raiz: Function,
        onCerrar: Function,
    };

    setup() {
        this.state = useState({indice: 0, visibles: [], caja: null, globo: null, flecha: 16, arriba: false});
        this._medir = () => this.medir();
        onMounted(() => {
            this.state.visibles = this.props.pasos.filter((paso) => this._objetivo(paso));
            if (!this.state.visibles.length) {
                this.props.onCerrar();
                return;
            }
            window.addEventListener("resize", this._medir);
            window.addEventListener("scroll", this._medir, true);
            this.irA(0);
            // Seguro: si el globo no se pudo ubicar, se cierra solo (la
            // capa nunca puede quedar tapando la pantalla).
            this._seguro = setTimeout(() => {
                if (!this.state.globo) {
                    this.props.onCerrar();
                }
            }, 1500);
        });
        onWillUnmount(() => {
            clearTimeout(this._seguro);
            window.removeEventListener("resize", this._medir);
            window.removeEventListener("scroll", this._medir, true);
        });
    }

    get paso() {
        return this.state.visibles[this.state.indice] || null;
    }

    get esUltimo() {
        return this.state.indice >= this.state.visibles.length - 1;
    }

    _objetivo(paso) {
        const raiz = this.props.raiz();
        const el = raiz && paso ? raiz.querySelector(paso.selector) : null;
        return el && el.getClientRects().length ? el : null;
    }

    irA(indice) {
        this.state.indice = indice;
        const el = this._objetivo(this.paso);
        if (!el) {
            this.siguiente();
            return;
        }
        el.scrollIntoView({block: "nearest"});
        requestAnimationFrame(() => this.medir());
        // otra vez un instante después: por si la pantalla terminaba de
        // acomodarse (letras, cabecera abriéndose) al medir la primera vez
        setTimeout(() => this.medir(), 300);
    }

    /** Ubica el resaltado sobre el botón y el globo debajo (o encima, si
     * abajo no hay lugar), con la flechita apuntando al botón. */
    medir() {
        const el = this._objetivo(this.paso);
        if (!el) {
            return;
        }
        const r = el.getBoundingClientRect();
        const m = 6;
        const ancho = Math.min(window.innerWidth - 32, 400);
        const centro = r.left + r.width / 2;
        const left = Math.min(Math.max(16, centro - ancho / 2), window.innerWidth - 16 - ancho);
        const abajo = window.innerHeight - r.bottom;
        const arriba = abajo < 260 && r.top > abajo;
        this.state.caja = {left: r.left - m, top: r.top - m, w: r.width + 2 * m, h: r.height + 2 * m};
        this.state.globo = arriba
            ? {left, ancho, bottom: window.innerHeight - r.top + m + 14}
            : {left, ancho, top: r.bottom + m + 14};
        this.state.arriba = arriba;
        this.state.flecha = Math.min(Math.max(16, centro - left - 11), ancho - 38);
    }

    get estiloFoco() {
        const c = this.state.caja;
        return `left:${c.left}px;top:${c.top}px;width:${c.w}px;height:${c.h}px;`;
    }

    get estiloGlobo() {
        const g = this.state.globo;
        const vertical = g.top !== undefined ? `top:${g.top}px;` : `bottom:${g.bottom}px;`;
        return `left:${g.left}px;width:${g.ancho}px;${vertical}`;
    }

    siguiente() {
        if (this.esUltimo) {
            this.props.onCerrar();
            return;
        }
        this.irA(this.state.indice + 1);
    }

    saltar() {
        this.props.onCerrar();
    }
}
