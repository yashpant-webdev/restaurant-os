-- Payment service schema. Money is BIGINT paise. Nothing here is ever deleted by the app.

CREATE TABLE payments (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL,
  outlet_id             uuid NOT NULL,
  order_id              uuid NOT NULL,
  method                text NOT NULL CHECK (method IN ('CASH','UPI','CARD','WALLET','PAYMENT_LINK')),
  currency              char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  amount_paise          bigint NOT NULL CHECK (amount_paise > 0),
  status                text NOT NULL CHECK (status IN ('PENDING','CAPTURED','FAILED','CANCELLED')),
  captured_paise        bigint NOT NULL DEFAULT 0,
  -- refunds that are pending OR succeeded: used to stop refunding more than was captured
  refund_reserved_paise bigint NOT NULL DEFAULT 0,
  -- refunds that actually succeeded: what the customer got back
  refunded_paise        bigint NOT NULL DEFAULT 0,
  gateway               text NOT NULL CHECK (gateway IN ('cash','razorpay','fake')),
  gateway_order_id      text UNIQUE,
  gateway_payment_id    text UNIQUE,
  failure_reason        text,
  flag                  text,   -- set when a human must look (AMOUNT_MISMATCH, DUPLICATE_CAPTURE)
  state_version         integer NOT NULL DEFAULT 1,
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT captured_iff_status CHECK ((status = 'CAPTURED') = (captured_paise > 0)),
  CONSTRAINT captured_le_amount CHECK (captured_paise <= amount_paise),
  CONSTRAINT refunds_within_capture CHECK (0 <= refunded_paise AND refunded_paise <= refund_reserved_paise AND refund_reserved_paise <= captured_paise)
);
CREATE INDEX payments_pending_idx ON payments (created_at) WHERE status = 'PENDING';
CREATE INDEX payments_order_idx ON payments (tenant_id, order_id);

CREATE TABLE refunds (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  payment_id        uuid NOT NULL REFERENCES payments(id),
  amount_paise      bigint NOT NULL CHECK (amount_paise > 0),
  status            text NOT NULL CHECK (status IN ('PENDING','SUCCEEDED','FAILED')),
  reason            text NOT NULL,
  idempotency_key   text NOT NULL,
  gateway_refund_id text UNIQUE,
  failure_reason    text,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX refunds_pending_idx ON refunds (created_at) WHERE status = 'PENDING';

-- Append-only audit trail of every state change, with who did it.
CREATE TABLE payment_audit (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  payment_id  uuid NOT NULL,
  action      text NOT NULL,
  from_status text,
  to_status   text,
  actor       text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER payment_audit_append_only BEFORE UPDATE OR DELETE ON payment_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every gateway webhook is stored before processing, deduplicated by the gateway's event id.
CREATE TABLE webhook_events (
  event_id     text PRIMARY KEY,
  gateway      text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text
);
CREATE INDEX webhook_events_unprocessed_idx ON webhook_events (received_at) WHERE processed_at IS NULL;

CREATE TABLE outbox (
  id              bigserial PRIMARY KEY,
  event_id        uuid NOT NULL UNIQUE,
  topic           text NOT NULL,
  key             text NOT NULL,
  tenant_id       uuid NOT NULL,
  envelope        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE inbox (
  consumer     text NOT NULL,
  event_id     uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE dead_letters (
  id         bigserial PRIMARY KEY,
  consumer   text NOT NULL,
  topic      text NOT NULL,
  event_id   text,
  envelope   jsonb,
  error      text NOT NULL,
  attempts   integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tenant isolation enforced by Postgres itself.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments','refunds','payment_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Least privilege: no DELETE for anyone; webhooks and relay only for the worker role.
GRANT SELECT, INSERT, UPDATE ON payments, refunds TO payment_app, payment_worker;
GRANT SELECT, INSERT ON payment_audit TO payment_app, payment_worker;
GRANT USAGE ON SEQUENCE payment_audit_id_seq, outbox_id_seq, dead_letters_id_seq TO payment_app, payment_worker;
GRANT INSERT ON outbox TO payment_app;
GRANT SELECT, INSERT, UPDATE ON outbox TO payment_worker;
GRANT SELECT, INSERT ON inbox, dead_letters TO payment_app, payment_worker;
GRANT SELECT, INSERT, UPDATE ON webhook_events TO payment_worker;
