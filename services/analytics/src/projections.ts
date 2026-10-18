import { EventPayload, Topics } from '@ros/contracts';
import { Database, EventBus, formatInr, Logger, registerConsumer, Tx } from '@ros/common';

const IST_DATE = `(($1::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date`;

/**
 * Builds the analytics read model from domain events. Each handler runs in the
 * consumer's transaction together with its inbox row, so replays and duplicate
 * deliveries never double-count a sale. Inserts use ON CONFLICT DO NOTHING as
 * a second safety net (e.g. when history is re-imported).
 */
export async function registerProjections(bus: EventBus, db: Database, log: Logger): Promise<void> {
  await registerConsumer(bus, db, log, 'analytics', Topics.OrderSettled, (tx, p, env) => projectSettled(tx, env.tenantId, p));
  await registerConsumer(bus, db, log, 'analytics', Topics.PaymentRefunded, (tx, p, env) => projectRefund(tx, env.tenantId, p, env.occurredAt));
  await registerConsumer(bus, db, log, 'analytics', Topics.OrderOverpaid, async (tx, p, env) => {
    await alert(tx, env.tenantId, p.outletId, 'OVERPAID', 'critical', `Order overpaid by ${formatInr(p.excessPaise)}: refund the guest`, p.orderId, p.excessPaise, env.occurredAt);
  });
  await registerConsumer(bus, db, log, 'analytics', Topics.PaymentCaptured, async (tx, p, env) => {
    if (p.lateCapture) {
      await alert(tx, env.tenantId, p.outletId, 'LATE_CAPTURE', 'serious', `${p.method} ${formatInr(p.capturedPaise)} arrived after the payment was cancelled`, p.paymentId, p.capturedPaise, env.occurredAt);
    }
  });
}

async function projectSettled(tx: Tx, tenantId: string, p: EventPayload<typeof Topics.OrderSettled>) {
  const { rowCount } = await tx.query(
    `INSERT INTO fact_orders (order_id, tenant_id, outlet_id, invoice_no, business_date, settled_at, opened_at, channel, table_ref, guests,
                              created_by, subtotal_paise, cgst_paise, sgst_paise, round_off_paise, total_paise, customer_phone)
     VALUES ($2, $3, $4, $5, ${IST_DATE}, $1, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (order_id) DO NOTHING`,
    [
      p.settledAt, p.orderId, tenantId, p.outletId, p.invoiceNo, p.openedAt ?? null, p.channel ?? null, p.tableRef ?? null, p.guests ?? null,
      p.createdBy ?? null, p.subtotalPaise, p.cgstPaise, p.sgstPaise, p.roundOffPaise, p.totalPaise, p.customer?.phone ?? null,
    ],
  );
  if (!rowCount) return; // already projected

  let lineNo = 0;
  for (const l of p.lines ?? []) {
    await tx.query(
      `INSERT INTO fact_order_lines (order_id, line_no, tenant_id, outlet_id, business_date, item_id, name, quantity, gst_rate_bp, net_paise, tax_paise, cost_paise)
       VALUES ($2, $3, $4, $5, ${IST_DATE}, $6, $7, $8, $9, $10, $11, $12)`,
      [p.settledAt, p.orderId, ++lineNo, tenantId, p.outletId, l.itemId, l.name, l.quantity, l.gstRateBp, l.netPaise, l.taxPaise, l.costPaise],
    );
  }
  for (const pay of p.payments) {
    await tx.query(
      `INSERT INTO fact_payments (payment_id, order_id, tenant_id, outlet_id, business_date, method, net_paise)
       VALUES ($2, $3, $4, $5, ${IST_DATE}, $6, $7) ON CONFLICT (payment_id) DO NOTHING`,
      [p.settledAt, pay.paymentId, p.orderId, tenantId, p.outletId, pay.method, pay.netPaise],
    );
  }
  if (p.customer) {
    await tx.query(
      `INSERT INTO customers (tenant_id, phone, name, marketing_consent, first_visit, last_visit, visits, spend_paise)
       VALUES ($2, $3, $4, $5, ${IST_DATE}, ${IST_DATE}, 1, $6)
       ON CONFLICT (tenant_id, phone) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, customers.name),
         marketing_consent = EXCLUDED.marketing_consent,
         first_visit = LEAST(customers.first_visit, EXCLUDED.first_visit),
         last_visit = GREATEST(customers.last_visit, EXCLUDED.last_visit),
         visits = customers.visits + 1,
         spend_paise = customers.spend_paise + EXCLUDED.spend_paise`,
      [p.settledAt, tenantId, p.customer.phone, p.customer.name, p.customer.marketingConsent, p.totalPaise],
    );
  }
}

async function projectRefund(tx: Tx, tenantId: string, p: EventPayload<typeof Topics.PaymentRefunded>, at: string) {
  const { rowCount } = await tx.query(
    `INSERT INTO fact_refunds (refund_id, tenant_id, outlet_id, payment_id, order_id, method, amount_paise, refunded_at, business_date)
     VALUES ($2, $3, $4, $5, $6, $7, $8, $1, ${IST_DATE}) ON CONFLICT (refund_id) DO NOTHING`,
    [at, p.refundId, tenantId, p.outletId, p.paymentId, p.orderId, p.method, p.refundPaise],
  );
  if (!rowCount) return;
  const severity = p.refundPaise >= 100_000 ? 'serious' : p.refundPaise >= 50_000 ? 'warning' : 'info';
  await alert(tx, tenantId, p.outletId, 'REFUND', severity, `${p.method} refund of ${formatInr(p.refundPaise)}`, p.refundId, p.refundPaise, at);
}

async function alert(tx: Tx, tenantId: string, outletId: string, kind: string, severity: string, message: string, refId: string, amountPaise: number, at: string) {
  await tx.query(
    `INSERT INTO alerts (tenant_id, outlet_id, kind, severity, message, ref_id, amount_paise, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, outletId, kind, severity, message, refId, amountPaise, at],
  );
}
