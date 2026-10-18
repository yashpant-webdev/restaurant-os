-- Dine-in floor: tables, running tabs and kitchen order tickets (KOTs).

CREATE TABLE dining_tables (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  outlet_id  uuid NOT NULL,
  label      text NOT NULL CHECK (length(label) BETWEEN 1 AND 20),
  seats      integer NOT NULL CHECK (seats BETWEEN 1 AND 30),
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, outlet_id, label)
);

ALTER TABLE orders
  ADD COLUMN guests integer CHECK (guests BETWEEN 1 AND 50),
  ADD COLUMN kot_count integer NOT NULL DEFAULT 1,
  ADD COLUMN bill_requested_at timestamptz;

-- A table can only have one running tab at a time (two captains can't open the same table).
CREATE UNIQUE INDEX one_open_order_per_table ON orders (tenant_id, outlet_id, table_ref)
  WHERE status = 'OPEN' AND table_ref IS NOT NULL;

-- Each round of items sent to the kitchen. The id comes from the captain's
-- device, so resending after a network drop never duplicates food.
CREATE TABLE kots (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  order_id     uuid NOT NULL REFERENCES orders(id),
  kot_no       integer NOT NULL,
  request_hash text NOT NULL,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, kot_no)
);

ALTER TABLE order_lines
  ADD COLUMN kot_no integer NOT NULL DEFAULT 1,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dining_tables','kots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON dining_tables, kots TO order_app, order_worker;
