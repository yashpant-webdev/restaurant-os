-- Analytics read model. Filled ONLY from events (pos.order.settled, payment.refunded, ...),
-- never by querying other services' databases. Reporting load can't slow down billing.
-- Same shape as the future ClickHouse / lake "gold" tables.

CREATE TABLE fact_orders (
  order_id        uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  outlet_id       uuid NOT NULL,
  invoice_no      text NOT NULL,
  business_date   date NOT NULL,          -- IST calendar day of settlement
  settled_at      timestamptz NOT NULL,
  opened_at       timestamptz,
  channel         text,
  table_ref       text,
  guests          integer,
  created_by      text,
  subtotal_paise  bigint NOT NULL,
  cgst_paise      bigint NOT NULL,
  sgst_paise      bigint NOT NULL,
  round_off_paise integer NOT NULL,
  total_paise     bigint NOT NULL,
  customer_phone  text
);
CREATE INDEX fact_orders_day_idx ON fact_orders (tenant_id, outlet_id, business_date);

CREATE TABLE fact_order_lines (
  order_id      uuid NOT NULL REFERENCES fact_orders(order_id),
  line_no       integer NOT NULL,
  tenant_id     uuid NOT NULL,
  outlet_id     uuid NOT NULL,
  business_date date NOT NULL,
  item_id       uuid NOT NULL,
  name          text NOT NULL,
  quantity      integer NOT NULL,
  gst_rate_bp   integer NOT NULL,
  net_paise     bigint NOT NULL,
  tax_paise     bigint NOT NULL,
  cost_paise    bigint,
  PRIMARY KEY (order_id, line_no)
);
CREATE INDEX fact_order_lines_day_idx ON fact_order_lines (tenant_id, outlet_id, business_date);

CREATE TABLE fact_payments (
  payment_id    uuid PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES fact_orders(order_id),
  tenant_id     uuid NOT NULL,
  outlet_id     uuid NOT NULL,
  business_date date NOT NULL,
  method        text NOT NULL,
  net_paise     bigint NOT NULL
);

CREATE TABLE fact_refunds (
  refund_id     uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  outlet_id     uuid NOT NULL,
  payment_id    uuid NOT NULL,
  order_id      uuid NOT NULL,
  method        text NOT NULL,
  amount_paise  bigint NOT NULL,
  refunded_at   timestamptz NOT NULL,
  business_date date NOT NULL
);

-- CRM: one row per guest per tenant (all outlets), keyed by mobile number.
CREATE TABLE customers (
  tenant_id         uuid NOT NULL,
  phone             text NOT NULL,
  name              text,
  marketing_consent boolean NOT NULL DEFAULT false,
  first_visit       date NOT NULL,
  last_visit        date NOT NULL,
  visits            integer NOT NULL,
  spend_paise       bigint NOT NULL,
  PRIMARY KEY (tenant_id, phone)
);

CREATE TABLE alerts (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  outlet_id    uuid NOT NULL,
  kind         text NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('info','warning','serious','critical')),
  message      text NOT NULL,
  ref_id       text,
  amount_paise bigint,
  created_at   timestamptz NOT NULL
);
CREATE INDEX alerts_recent_idx ON alerts (tenant_id, outlet_id, created_at DESC);

-- Operating expenses entered by the owner (rent, salaries...). Needed for a real P&L.
CREATE TABLE expenses (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  outlet_id     uuid NOT NULL,
  business_date date NOT NULL,
  category      text NOT NULL CHECK (category IN ('RENT','SALARIES','UTILITIES','MARKETING','MAINTENANCE','OTHER')),
  amount_paise  bigint NOT NULL CHECK (amount_paise > 0),
  -- MONTHLY costs (rent, salaries) are spread evenly over the days of their month, so any
  -- date range shows its fair share (accrual), not a spike on the day the bill was paid.
  period        text NOT NULL DEFAULT 'ONE_TIME' CHECK (period IN ('ONE_TIME','MONTHLY')),
  note          text CHECK (length(note) <= 200),
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_day_idx ON expenses (tenant_id, outlet_id, business_date);

CREATE TABLE inbox (consumer text NOT NULL, event_id uuid NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer, event_id));
CREATE TABLE dead_letters (
  id bigserial PRIMARY KEY, consumer text NOT NULL, topic text NOT NULL, event_id text, envelope jsonb,
  error text NOT NULL, attempts integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fact_orders','fact_order_lines','fact_payments','fact_refunds','customers','alerts','expenses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON fact_orders, fact_order_lines, fact_payments, fact_refunds, customers, alerts, expenses TO analytics_app, analytics_worker;
GRANT SELECT, INSERT ON inbox, dead_letters TO analytics_app, analytics_worker;
GRANT USAGE ON SEQUENCE alerts_id_seq, dead_letters_id_seq TO analytics_app, analytics_worker;
