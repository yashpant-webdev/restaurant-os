-- Order/POS service schema (catalog + orders + billing in one deployable for Phase 1).

CREATE TABLE menu_items (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  outlet_id    uuid NOT NULL,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  price_paise  bigint NOT NULL CHECK (price_paise >= 0),
  gst_rate_bp  integer NOT NULL CHECK (gst_rate_bp IN (0, 500, 1200, 1800, 2800)),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX menu_items_outlet_idx ON menu_items (tenant_id, outlet_id);

CREATE TABLE orders (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  outlet_id      uuid NOT NULL,
  channel        text NOT NULL CHECK (channel IN ('DINE_IN','TAKEAWAY','DELIVERY')),
  table_ref      text,
  status         text NOT NULL CHECK (status IN ('OPEN','SETTLED','CANCELLED')),
  request_hash   text NOT NULL,
  subtotal_paise bigint NOT NULL CHECK (subtotal_paise >= 0),
  cgst_paise     bigint NOT NULL CHECK (cgst_paise >= 0),
  sgst_paise     bigint NOT NULL CHECK (sgst_paise >= 0),
  round_off_paise integer NOT NULL CHECK (round_off_paise BETWEEN -50 AND 50),
  total_paise    bigint NOT NULL CHECK (total_paise >= 0),
  -- net money received (captured - refunded), maintained from payment events
  paid_paise     bigint NOT NULL DEFAULT 0,
  overpaid_paise bigint NOT NULL DEFAULT 0,
  invoice_no     text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz,
  CONSTRAINT total_consistent CHECK (total_paise = subtotal_paise + cgst_paise + sgst_paise + round_off_paise),
  CONSTRAINT invoice_when_settled CHECK ((status = 'SETTLED') = (invoice_no IS NOT NULL)),
  UNIQUE (tenant_id, outlet_id, invoice_no)
);

CREATE TABLE order_lines (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  order_id          uuid NOT NULL REFERENCES orders(id),
  item_id           uuid NOT NULL,
  name              text NOT NULL,
  unit_price_paise  bigint NOT NULL CHECK (unit_price_paise >= 0),
  quantity          integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  gst_rate_bp       integer NOT NULL,
  line_subtotal_paise bigint NOT NULL,
  line_tax_paise    bigint NOT NULL
);
CREATE INDEX order_lines_order_idx ON order_lines (order_id);

-- The order's view of each payment, kept in sync from payment events (snapshot + version).
CREATE TABLE order_payments (
  payment_id      uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  order_id        uuid NOT NULL REFERENCES orders(id),
  idempotency_key text NOT NULL,
  method          text NOT NULL,
  amount_paise    bigint NOT NULL CHECK (amount_paise > 0),
  status          text NOT NULL CHECK (status IN ('PENDING','CAPTURED','FAILED','CANCELLED')),
  captured_paise  bigint NOT NULL DEFAULT 0,
  refunded_paise  bigint NOT NULL DEFAULT 0,
  state_version   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX order_payments_order_idx ON order_payments (order_id);

-- Gapless invoice numbers per outlet per financial year (GST requirement).
CREATE TABLE invoice_counters (
  tenant_id uuid NOT NULL,
  outlet_id uuid NOT NULL,
  fy        text NOT NULL,
  next_no   bigint NOT NULL,
  PRIMARY KEY (tenant_id, outlet_id, fy)
);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY, event_id uuid NOT NULL UNIQUE, topic text NOT NULL, key text NOT NULL,
  tenant_id uuid NOT NULL, envelope jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE TABLE inbox (consumer text NOT NULL, event_id uuid NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer, event_id));
CREATE TABLE dead_letters (
  id bigserial PRIMARY KEY, consumer text NOT NULL, topic text NOT NULL, event_id text, envelope jsonb,
  error text NOT NULL, attempts integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['menu_items','orders','order_lines','order_payments','invoice_counters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON menu_items, orders, order_lines, order_payments, invoice_counters TO order_app, order_worker;
GRANT INSERT ON outbox TO order_app;
GRANT SELECT, INSERT, UPDATE ON outbox TO order_worker;
GRANT SELECT, INSERT ON inbox, dead_letters TO order_app, order_worker;
GRANT USAGE ON SEQUENCE outbox_id_seq, dead_letters_id_seq TO order_app, order_worker;
