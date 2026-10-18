-- Which captain served each settled bill (for captain performance reports).
ALTER TABLE fact_orders ADD COLUMN captain_id uuid, ADD COLUMN captain_name text;
CREATE INDEX fact_orders_captain_idx ON fact_orders (tenant_id, outlet_id, captain_id, business_date);
