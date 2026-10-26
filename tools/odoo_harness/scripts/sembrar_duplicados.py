# Se ejecuta con `odoo shell` (ver run.sh --desde): crea un pedido y DOS
# eventos de juego con el mismo sale_id, como podría haber quedado en una
# base que corrió la Fase 3 antes de existir unique(sale_id).
partner = env["res.partner"].create({"name": "Cliente duplicados"})
sale = env["sale.order"].create({"partner_id": partner.id})
Evento = env["shalom.juego.evento"]
for xp in (10, 20):
    Evento.create({"sale_id": sale.id, "xp": xp, "total": 1.0})
env.cr.commit()
print("SEMBRADO: eventos con el mismo sale_id =", Evento.search_count([("sale_id", "=", sale.id)]))
