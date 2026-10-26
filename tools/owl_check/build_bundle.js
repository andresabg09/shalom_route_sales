#!/usr/bin/env node
/* Empaqueta los componentes Owl del módulo en un solo CJS para Node,
 * con stubs mínimos de @web/* y @odoo/owl -> owl.js real.
 * Uso: node build_bundle.js [SALIDA]   (defecto /tmp/owl_check/bundle.cjs) */
const path = require("path");
const esbuild = require(require.resolve("esbuild", {paths: ["/tmp/owl_check", __dirname]}));
const MOD = process.env.SHALOM_MOD || path.resolve(__dirname, "../../shalom_location_map");
const JS = path.join(MOD, "static/src/js/ruta_shalom");
const S = (f) => path.join(__dirname, "stubs", f);
const alias = {
    "@odoo/owl": S("owl_shim.js"),
    "@web/core/utils/hooks": S("hooks.js"),
    "@web/core/registry": S("registry.js"),
    "@web/core/datetime/datetime_input": S("datetime_input.js"),
    "@web/core/network/rpc": S("rpc.js"),
    "@web/core/assets": S("assets.js"),
};
const entry = ["order_screen", "rutas_hub", "ruta_detalle", "visit_sheet", "admin_gestion", "app"]
    .map((m) => `export * from ${JSON.stringify(path.join(JS, m + ".js"))};`).join("\n");
esbuild.build({
    stdin: {contents: entry, resolveDir: JS, loader: "js"},
    bundle: true, format: "cjs", platform: "node", logLevel: "warning",
    outfile: process.argv[2] || "/tmp/owl_check/bundle.cjs",
    plugins: [{name: "alias", setup(b) {
        b.onResolve({filter: /^(@odoo\/owl|@web\/.*)$/}, (a) => ({path: alias[a.path]}));
    }}],
}).then(() => console.log("bundle OK")).catch(() => process.exit(1));
