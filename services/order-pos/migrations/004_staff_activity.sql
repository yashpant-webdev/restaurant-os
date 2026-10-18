-- Staff (captains, cashiers), which captain owns each order, and an activity log
-- that drives the live feed on the cashier screen.

CREATE TABLE staff (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  outlet_id      uuid NOT NULL,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  role           text NOT NULL CHECK (role IN ('CAPTAIN','CASHIER','MANAGER')),
  phone          text CHECK (phone ~ '^[6-9][0-9]{9}$'),
  is_active      boolean NOT NULL DEFAULT true,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  deactivated_by text
);
-- Two active staff at one outlet can't share a name (the floor shows names).
CREATE UNIQUE INDEX staff_active_name_uq ON staff (tenant_id, outlet_id, lower(name)) WHERE is_active;

ALTER TABLE orders
  ADD COLUMN captain_id uuid REFERENCES staff(id),
  ADD COLUMN captain_name text;
CREATE INDEX orders_open_captain_idx ON orders (captain_id) WHERE status = 'OPEN';

CREATE TABLE activity (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  outlet_id   uuid NOT NULL,
  kind        text NOT NULL,
  order_id    uuid,
  table_ref   text,
  captain_id  uuid,
  actor_id    text NOT NULL,
  actor_name  text NOT NULL,
  message     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_recent_idx ON activity (tenant_id, outlet_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff','activity'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON staff TO order_app, order_worker;
GRANT SELECT, INSERT ON activity TO order_app, order_worker;  -- the activity log is append-only
