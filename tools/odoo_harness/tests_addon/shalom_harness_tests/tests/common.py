# -*- coding: utf-8 -*-
"""Datos SINTÉTICOS compartidos por todos los tests (se revierten al
terminar cada clase: TransactionCase)."""
from datetime import date, datetime, timedelta

from odoo import fields
from odoo.tests.common import TransactionCase

HOY = fields.Date.context_today


class ShalomCommon(TransactionCase):
    """Escenario:

    - Compañía 1 (principal) con almacén WH (Dianke) y compañía 2
      "Greenpeak" con almacén ALBRK (Nevada). Los vendedores SOLO tienen
      la compañía 1.
    - Productos con stock distinto en cada almacén y standard_price.
    - Usuarios: vendedor A (dueño de la ruta), vendedor B, vendedor C
      (fsm_user + ventas "ver todos los documentos") y un gerente
      (fsm_manager). `vendedor_min` = solo fsm_user; `vendedor_own` =
      fsm_user + ventas "solo mis documentos": para comprobar permisos.
    - Ruta R1 con 20 clientes (fsm.location) con historial de ventas
      para tener clases A / A2 / B / B2 / C / NUEVO + 1 distribuidora.
    - Ciclo (fsm.route.schedule) con una visita abierta por cliente.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        env = cls.env
        cls.company1 = env.ref("base.main_company")
        cls.company2 = env["res.company"].create({"name": "Greenpeak (prueba)"})
        # --- almacenes -------------------------------------------------
        cls.wh_dianke = env["stock.warehouse"].search(
            [("code", "=", "WH"), ("company_id", "=", cls.company1.id)], limit=1
        )
        cls.wh_nevada = env["stock.warehouse"].create(
            {"name": "Bodega Greenpeak", "code": "ALBRK", "company_id": cls.company2.id}
        )
        # --- productos -------------------------------------------------
        def producto(nombre, precio, costo, sale_ok=True):
            return env["product.product"].create(
                {
                    "name": nombre,
                    "type": "consu",
                    "is_storable": True,
                    "list_price": precio,
                    "standard_price": costo,
                    "sale_ok": sale_ok,
                    "taxes_id": [(5, 0, 0)],
                    "company_id": False,
                }
            )

        cls.p_tinte = producto("Tinte 100", 100.0, 60.0)      # margen 40%
        cls.p_oxi = producto("Oxigenta 50", 50.0, 45.0)       # margen 10%
        cls.p_crema = producto("Crema 200", 200.0, 120.0)     # margen 40%
        cls.p_barato = producto("Esmalte 20", 20.0, 5.0)      # margen 75%
        cls.p_nosale = producto("Descontinuado", 10.0, 1.0, sale_ok=False)
        Quant = env["stock.quant"].sudo()
        stock = {
            cls.wh_dianke: {cls.p_tinte: 10, cls.p_oxi: 0, cls.p_crema: 5, cls.p_barato: 100},
            cls.wh_nevada: {cls.p_tinte: 3, cls.p_oxi: 40, cls.p_crema: 0, cls.p_barato: 7},
        }
        for wh, prods in stock.items():
            for prod, qty in prods.items():
                if qty:
                    Quant._update_available_quantity(prod, wh.lot_stock_id, qty)
        # --- usuarios y vendedores ------------------------------------
        g_user = env.ref("base.group_user")
        g_fsm_user = env.ref("fieldservice.group_fsm_user")
        g_fsm_mgr = env.ref("fieldservice.group_fsm_manager")
        # "Ver todos los documentos" (implica vendedor): así el vendedor ve
        # TODAS las ventas del cliente, como asume el módulo.
        g_sales = env.ref("sales_team.group_sale_salesman_all_leads")
        # Vendedor "solo sus documentos" (regla personal de ventas)
        g_sales_own = env.ref("sales_team.group_sale_salesman")

        def usuario(login, grupos):
            return env["res.users"].with_context(no_reset_password=True).create(
                {
                    "name": login,
                    "login": login,
                    "email": login + "@prueba.test",
                    "company_id": cls.company1.id,
                    "company_ids": [(6, 0, [cls.company1.id])],
                    "groups_id": [(6, 0, [g.id for g in grupos])],
                }
            )

        cls.u_a = usuario("vendedor_a", [g_user, g_fsm_user, g_sales])
        cls.u_b = usuario("vendedor_b", [g_user, g_fsm_user, g_sales])
        cls.u_c = usuario("vendedor_c", [g_user, g_fsm_user, g_sales])
        cls.u_min = usuario("vendedor_min", [g_user, g_fsm_user])
        cls.u_own = usuario("vendedor_own", [g_user, g_fsm_user, g_sales_own])
        cls.u_mgr = usuario("gerente", [g_user, g_fsm_mgr, g_sales])

        def persona(nombre, user):
            return env["fsm.person"].create({"name": nombre, "user_id": user.id})

        cls.per_a = persona("Persona A", cls.u_a)
        cls.per_b = persona("Persona B", cls.u_b)
        cls.per_c = persona("Persona C", cls.u_c)
        cls.per_min = persona("Persona Min", cls.u_min)
        cls.per_own = persona("Persona Own", cls.u_own)
        cls.per_mgr = persona("Persona Gerente", cls.u_mgr)
        # --- ruta y clientes ------------------------------------------
        cls.ruta = env["fsm.route"].create({"name": "R1 prueba", "fsm_person_id": cls.per_a.id})
        cls.dueno = env["res.partner"].create({"name": "Dueño genérico"})
        cls.clientes = {}
        # (clave, clase esperada, descripción de pedidos)
        # pedidos: lista de (días atrás, [(producto, cantidad), ...])
        P = cls
        plan = []
        # 5 clientes A: ticket alto (>=150) y margen alto (>=20%)
        for i in range(1, 6):
            plan.append((f"A{i}", False, [
                (30, [(P.p_tinte, 15)]),            # 1500
                (60, [(P.p_tinte, 12)]),            # 1200
                (90, [(P.p_crema, 8)]),             # 1600
            ]))
        # 3 clientes A2: ticket alto pero margen bajo (<20%)
        for i in range(1, 4):
            plan.append((f"A2_{i}", False, [
                (20, [(P.p_oxi, 20)]),              # 1000 @10%
                (50, [(P.p_oxi, 16)]),              # 800
            ]))
        # 4 clientes B: ticket < 150, margen alto
        for i in range(1, 5):
            plan.append((f"B{i}", False, [
                (10, [(P.p_barato, 5)]),            # 100 @75%
                (40, [(P.p_barato, 4)]),            # 80
            ]))
        # 2 clientes B2: ticket < 150, margen bajo
        for i in range(1, 3):
            plan.append((f"B2_{i}", False, [
                (15, [(P.p_oxi, 2)]),               # 100 @10%
            ]))
        # 2 clientes C (dormidos: última compra > 180 días)
        for i in range(1, 3):
            plan.append((f"C{i}", False, [
                (300, [(P.p_tinte, 10)]),
                (400, [(P.p_tinte, 8)]),
            ]))
        # 2 clientes NUEVO (sin pedidos)
        for i in range(1, 3):
            plan.append((f"N{i}", False, []))
        # 1 distribuidora con compras enormes
        plan.append(("DIST", True, [(5, [(P.p_crema, 40)])]))
        # cliente "RELLENO": récord 2000 (10 x tinte 200?) y un pedido de relleno
        plan.append(("RELLENO", False, [
            (20, [(P.p_crema, 10)]),                # 2000 (récord)
            (40, [(P.p_crema, 9)]),                 # 1800
            (60, [(P.p_barato, 5)]),                # 100 (< 15% de 2000 = 300 => relleno)
        ]))
        orden = 0
        for clave, distribuidora, pedidos in plan:
            orden += 1
            loc = env["fsm.location"].create(
                {
                    "name": f"Cliente {clave}",
                    "fsm_route_id": cls.ruta.id,
                    "x_orden_ruta": orden,
                    "x_es_distribuidora": distribuidora,
                    "partner_latitude": 8.9 + orden / 1000.0,
                    "partner_longitude": -79.5 + orden / 1000.0,
                }
            )
            cls.clientes[clave] = loc
            for dias, lineas in pedidos:
                cls._crear_venta(loc.partner_id, dias, lineas)
        # --- ciclo con visitas abiertas -------------------------------
        hoy = HOY(env["fsm.route"])
        cls.hoy = hoy
        cls.ciclo = env["fsm.route.schedule"].create(
            {
                "route_id": cls.ruta.id,
                "date_start": hoy,
                "date_end": hoy + timedelta(days=6),
            }
        )
        cls.ciclo.action_generar_visitas()
        cls.visitas = {
            clave: env["fsm.order"].search(
                [("location_id", "=", loc.id), ("x_route_schedule_id", "=", cls.ciclo.id)]
            )
            for clave, loc in cls.clientes.items()
        }

    # ------------------------------------------------------------------
    @classmethod
    def _crear_venta(cls, partner, dias_atras, lineas, estado="sale"):
        """sale.order sintética con state forzado (sin pasar por
        action_confirm, para no mover el stock de los almacenes)."""
        fecha = datetime.now() - timedelta(days=dias_atras)
        orden = cls.env["sale.order"].create(
            {
                "partner_id": partner.id,
                "date_order": fecha,
                "order_line": [
                    (0, 0, {"product_id": p.id, "product_uom_qty": q}) for p, q in lineas
                ],
            }
        )
        orden.write({"state": estado})
        return orden

    def lineas(self, *pares):
        """[(producto, qty)] -> formato de la app."""
        return [{"product_id": p.id, "qty": q, "es_recompensa": False, "regla_id": False} for p, q in pares]
