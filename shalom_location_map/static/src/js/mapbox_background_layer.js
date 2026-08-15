/** @odoo-module **/
/* global ol */

/**
 * Parche sobre GeoengineRenderer (base_geoengine) para:
 *   1. Quitar la capa OSM que el componente agrega SIEMPRE de forma
 *      hardcodeada al principio de createBackgroundLayers, independiente
 *      de la configuración de "backgrounds" -- esto hacía que OpenStreetMap
 *      apareciera igual aunque se configure otra capa base.
 *   2. Agregar un nuevo tipo de capa "xyz" al switch de
 *      createBackgroundLayers, para poder usar tiles de Mapbox (u otro
 *      proveedor compatible con URLs de patrón {z}/{x}/{y}) como capa
 *      base, sin tener que reescribir el archivo original del módulo
 *      OCA (así se preservan las actualizaciones futuras de ese módulo).
 *
 * Para activar Mapbox como capa base, hay que crear un registro en
 * geoengine.raster.layer con:
 *   - raster_type: no existe un valor "xyz" nativo en el selection de
 *     ese modelo todavía, así que este parche detecta la capa Mapbox
 *     por convención: un registro con raster_type="wmts" cuyo campo
 *     "server_type" sea exactamente "mapbox". El campo "url" debe
 *     contener el ID de estilo de Mapbox (ej. "mapbox/streets-v12").
 *   - El token de Mapbox se toma del propio navegador/cliente vía
 *     una llamada a un endpoint del servidor que lo expone de forma
 *     controlada (no se hardcodea en este JS ni se expone el
 *     MAPBOX_ACCESS_TOKEN del servidor directamente aquí).
 */
import {GeoengineRenderer} from "@base_geoengine/js/views/geoengine/geoengine_renderer/geoengine_renderer.esm";
import {patch} from "@web/core/utils/patch";
import {rpc} from "@web/core/network/rpc";

let mapboxTokenCache = null;

async function getMapboxToken() {
    if (mapboxTokenCache) {
        return mapboxTokenCache;
    }
    mapboxTokenCache = await rpc("/shalom_location_map/mapbox_public_token");
    return mapboxTokenCache;
}

patch(GeoengineRenderer.prototype, {
    createBackgroundLayers(backgrounds) {
        // No llamamos a super() porque queremos evitar el push
        // incondicional de OSM que hace la versión original. En vez de
        // eso, replicamos la misma lógica de mapeo, agregando el caso
        // "mapbox" (detectado por server_type === "mapbox" dentro de
        // un background de tipo wmts).
        const source = [];
        const mapboxBackground = backgrounds.find(
            (b) => b.raster_type === "wmts" && b.server_type === "mapbox"
        );

        if (mapboxBackground) {
            // Placeholder síncrono: la capa se reemplaza en cuanto
            // el token llegue de forma asíncrona (ver abajo).
            const mapboxLayer = new ol.layer.Tile({
                title: mapboxBackground.name || "Mapbox",
                visible: true,
                type: "base",
                opacity: mapboxBackground.opacity || 1,
                source: new ol.source.OSM(), // temporal, se reemplaza abajo
            });

            getMapboxToken().then((token) => {
                if (!token) {
                    return;
                }
                const styleId = mapboxBackground.url || "mapbox/streets-v12";
                mapboxLayer.setSource(
                    new ol.source.XYZ({
                        url:
                            `https://api.mapbox.com/styles/v1/${styleId}/tiles/` +
                            `256/{z}/{x}/{y}?access_token=${token}`,
                        crossOrigin: "anonymous",
                        tileSize: 256,
                    })
                );
            });

            source.push(mapboxLayer);
        } else {
            source.push(new ol.layer.Tile({source: new ol.source.OSM()}));
        }

        const backgroundLayers = backgrounds
            .filter((b) => b !== mapboxBackground)
            .map((background) => {
                switch (background.raster_type) {
                    case "osm": {
                        return new ol.layer.Tile({
                            title: background.name,
                            visible: !background.overlay,
                            type: "base",
                            opacity: background.opacity,
                            source: new ol.source.OSM(),
                        });
                    }
                    case "wmts": {
                        const {source_opt, tilegrid_opt, layer_opt} =
                            this.createOptions(background);
                        this.getUrl(background, source_opt);
                        if (background.format_suffix) {
                            source_opt.format = background.format_suffix;
                        }
                        if (background.request_encoding) {
                            source_opt.request_encoding =
                                background.request_encoding;
                        }
                        if (background.projection) {
                            source_opt.projection = ol.proj.get(
                                background.projection
                            );
                            if (source_opt.projection) {
                                const projectionExtent =
                                    source_opt.projection.getExtent();
                                tilegrid_opt.origin =
                                    ol.extent.getTopLeft(projectionExtent);
                            }
                        }
                        if (background.resolutions) {
                            tilegrid_opt.resolutions = background.resolutions
                                .split(",")
                                .map(Number);
                            const nbRes = tilegrid_opt.resolutions.length;
                            const matrixIds = new Array(nbRes);
                            for (let i = 0; i < nbRes; i++) {
                                matrixIds[i] = i;
                            }
                            tilegrid_opt.matrixIds = matrixIds;
                        }
                        if (background.max_extent) {
                            const extent = background.max_extent
                                .split(",")
                                .map(Number);
                            layer_opt.extent = extent;
                            tilegrid_opt.extent = extent;
                        }
                        if (background.params) {
                            source_opt.dimensions = JSON.parse(
                                background.params
                            );
                        }
                        source_opt.tileGrid = new ol.tilegrid.WMTS(
                            tilegrid_opt
                        );
                        layer_opt.source = new ol.source.WMTS(source_opt);
                        return new ol.layer.Tile(layer_opt);
                    }
                    case "d_wms": {
                        const source_opt_wms = {
                            params: JSON.parse(background.params_wms),
                            serverType: background.server_type,
                        };
                        const urls = background.url.split(",");
                        if (urls.length > 1) {
                            source_opt_wms.urls = urls;
                        } else {
                            source_opt_wms.url = urls[0];
                        }
                        return new ol.layer.Tile({
                            title: background.name,
                            visible: !background.overlay,
                            opacity: background.opacity,
                            source: new ol.source.TileWMS(source_opt_wms),
                        });
                    }
                    default: {
                        return undefined;
                    }
                }
            });
        return source.concat(backgroundLayers);
    },
});
