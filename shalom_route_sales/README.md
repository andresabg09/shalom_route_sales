# Shalom Route Sales

Odoo 18 module to manage street / door-to-door route sales.

## Concepts

- **Route** (`shalom.route.route`): a named route with an ordered list of
  customers, each assigned to a weekday (`shalom.route.line`).
- **Visit** (`shalom.route.visit`): the execution of a route on a specific
  date. Generated stops (`shalom.route.visit.line`) mirror that day's route
  lines and can be marked `sold` (linked to a `sale.order`) or `no_sale`.

## Typical flow

1. Configure a route and its weekly customer schedule under
   **Route Sales > Routes**.
2. Each day, create a **Visit** for the route and date, then click
   **Generate Stops** to pull in that weekday's customers.
3. In the field, mark each stop as sold (creates/opens a sale order) or
   no sale, then mark the visit **Done**.

## Dependencies

`base`, `mail`, `sale_management`.
