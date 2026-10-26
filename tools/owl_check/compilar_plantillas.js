#!/usr/bin/env node
/*
 * Compila de verdad cada <t t-name=...> de los XML del módulo con el
 * compilador de Owl (dev: true) y reporta errores.
 *
 * Uso:  node compilar_plantillas.js [OWL_JS] [MODULO_DIR]
 *   OWL_JS     ruta a owl.js de Odoo 18 (defecto: /tmp/owl_check/owl_odoo18.js)
 *   MODULO_DIR ruta a shalom_location_map (defecto: ../../shalom_location_map)
 *
 * Requiere:  npm i jsdom   (en /tmp/owl_check o donde se ejecute)
 */
const fs = require("fs");
const path = require("path");
const OWL = process.argv[2] || "/tmp/owl_check/owl_odoo18.js";
const MOD = process.argv[3] || path.resolve(__dirname, "../../shalom_location_map");

const { JSDOM } = require(require.resolve("jsdom", { paths: ["/tmp/owl_check", __dirname] }));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
global.window = dom.window;
for (const k of Object.getOwnPropertyNames(dom.window)) {
    if (k in global) continue;
    try { global[k] = dom.window[k]; } catch (e) {}
}
global.requestAnimationFrame = (f) => setTimeout(f, 0);
const owl = require(OWL.endsWith(".js") ? path.resolve(OWL) : OWL);
const O = owl.owl || global.owl || owl;

function walk(d, out = []) {
    for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith(".xml") && p.includes(path.sep + "xml" + path.sep)) out.push(p);
    }
    return out;
}

let errores = 0;
for (const file of walk(path.join(MOD, "static/src/xml")).sort()) {
    const xml = fs.readFileSync(file, "utf8");
    const doc = new dom.window.DOMParser().parseFromString(xml, "text/xml");
    const pe = doc.querySelector("parsererror");
    if (pe) { console.log(`XML-PARSE-ERROR ${file}: ${pe.textContent.slice(0, 300)}`); errores++; continue; }
    const names = [...doc.querySelectorAll("[t-name]")].map((n) => n.getAttribute("t-name"));
    class Dummy extends O.Component { static template = "x"; }
    const app = new O.App(Dummy, { templates: xml, dev: true, warnIfNoStaticProps: false });
    for (const n of names) {
        try {
            const fn = app.getTemplate(n);
            if (typeof fn !== "function") throw new Error("getTemplate no devolvió función");
            console.log(`OK    ${path.relative(MOD, file)} :: ${n}`);
        } catch (e) {
            errores++;
            console.log(`ERROR ${path.relative(MOD, file)} :: ${n}\n      ${String(e.message).split("\n").slice(0, 6).join("\n      ")}`);
        }
    }
}
console.log(errores ? `\n${errores} plantilla(s) con error` : "\nTodas las plantillas compilan");
process.exit(errores ? 1 : 0);
