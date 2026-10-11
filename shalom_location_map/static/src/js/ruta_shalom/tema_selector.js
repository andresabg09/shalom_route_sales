/** @odoo-module **/

import {Component, onMounted, useExternalListener, useRef, useState} from "@odoo/owl";

/**
 * Selector de tema de la app del vendedor / Administración: Claro (por
 * defecto), Dispositivo (sigue prefers-color-scheme del sistema) u
 * Oscuro. Vive en el encabezado de cada pantalla, arriba a la derecha.
 *
 * La elección se guarda POR DISPOSITIVO en localStorage (clave
 * "shalom_tema"), no en la base de datos -- decisión del usuario. El
 * tema se aplica poniendo data-shalom-tema en TODAS las raíces
 * .o_shalom_ruta_app que haya en el documento (la del shell del
 * vendedor y la de Administración); el SCSS decide la paleta según ese
 * atributo (ver el mixin shalom-paleta-oscura en ruta_shalom.scss).
 */

const CLAVE_TEMA = "shalom_tema";

export const TEMAS = [
    {valor: "claro", etiqueta: "Claro", icono: "fa-sun-o"},
    {valor: "dispositivo", etiqueta: "Dispositivo", icono: "fa-desktop"},
    {valor: "oscuro", etiqueta: "Oscuro", icono: "fa-moon-o"},
];

/** Tema guardado en este dispositivo; "claro" si no hay nada o si
 * localStorage falla (modo privado, almacenamiento bloqueado). */
export function leerTema() {
    try {
        const guardado = localStorage.getItem(CLAVE_TEMA);
        if (TEMAS.some((tema) => tema.valor === guardado)) {
            return guardado;
        }
    } catch {
        // Sin localStorage: se queda el tema claro por defecto.
    }
    return "claro";
}

export function guardarTema(valor) {
    try {
        localStorage.setItem(CLAVE_TEMA, valor);
    } catch {
        // Igual se aplica en esta sesión; solo no se recuerda.
    }
}

export function aplicarTema(valor) {
    document
        .querySelectorAll(".o_shalom_ruta_app")
        .forEach((raiz) => raiz.setAttribute("data-shalom-tema", valor));
}

export class TemaSelector extends Component {
    static template = "shalom_location_map.TemaSelector";
    static props = {};

    setup() {
        this.temas = TEMAS;
        this.raiz = useRef("raiz");
        this.state = useState({tema: leerTema(), abierto: false});
        // Cada pantalla monta su propio selector: aplicar al montar
        // asegura que la raíz tenga el atributo aunque el vendedor
        // nunca toque el botón.
        onMounted(() => aplicarTema(this.state.tema));
        // Cierra el menú al tocar fuera de él.
        useExternalListener(window, "click", (ev) => {
            if (this.state.abierto && this.raiz.el && !this.raiz.el.contains(ev.target)) {
                this.state.abierto = false;
            }
        });
    }

    get temaActual() {
        return TEMAS.find((tema) => tema.valor === this.state.tema) || TEMAS[0];
    }

    toggleMenu() {
        this.state.abierto = !this.state.abierto;
    }

    elegir(valor) {
        this.state.tema = valor;
        this.state.abierto = false;
        guardarTema(valor);
        aplicarTema(valor);
    }
}
