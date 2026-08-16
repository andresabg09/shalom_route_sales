# License AGPL-3.0 or later (http://www.gnu.org/licenses/agpl).
{
    "name": "Shalom - Mapa en Ubicaciones de Servicio",
    "summary": "Agrega la vista de mapa (geoengine) al menú de Ubicaciones de Field Service, "
               "botón de GPS y orden/jornada de visita en las órdenes de servicio, "
               "y generación de visitas por ruta.",
    "version": "18.0.3.0.0",
    "category": "Field Service",
    "author": "AutomatePTY",
    "license": "AGPL-3",
    "depends": ["fieldservice", "fieldservice_geoengine", "fieldservice_route", "base_geoengine"],
    "data": [
        "security/ir.model.access.csv",
        "data/fsm_stage_colors.xml",
        "data/fsm_stage_no_quiso.xml",
        "views/fsm_location_action.xml",
        "views/fsm_location_geoengine_patch.xml",
        "views/fsm_location_orden_views.xml",
        "views/fsm_order_views.xml",
        "views/fsm_order_kanban.xml",
        "views/fsm_order_geoengine_patch.xml",
        "views/fsm_route_views.xml",
        "views/fsm_route_schedule_views.xml",
        "data/mapbox_raster_layer.xml",
        "data/migrar_orden_ruta.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "shalom_location_map/static/src/js/fsm_order_gps_button.js",
            "shalom_location_map/static/src/js/mapbox_background_layer.js",
            "shalom_location_map/static/src/js/resumen_compras_widget.js",
            "shalom_location_map/static/src/xml/resumen_compras_widget.xml",
            "shalom_location_map/static/src/js/mini_mapa_widget.js",
            "shalom_location_map/static/src/xml/mini_mapa_widget.xml",
        ],
    },
    "installable": True,
}
