import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { EventPayload, PaymentMethod, PaymentSnapshot, Topics } from '@ros/contracts';
import {
  assertOutletAccess,
  ConflictError,
  Database,
  enqueueEvent,
  Logger,
  LOGGER,
  newId,
  NotFoundError,
  OutboxRelay,
  percentOf,
  Principal,
  roundToRupee,
  safeAdd,
  safeMultiply,
  splitGst,
  Tx,
  UnprocessableError,
  UpstreamError,
  ValidationError,
} from '@ros/common';
import { PaymentClient, PaymentRejected } from './payment-client';

export const APP_DB = Symbol('APP_DB');
export const RELAY = Symbol('RELAY');
export const PAYMENTS = Symbol('PAYMENTS');

export const CreateMenuItemInput = z
  .object({
    outletId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    pricePaise: z.number().int().min(0).max(10_000_000),
    gstRateBp: z.union([z.literal(0), z.literal(500), z.literal(1200), z.literal(1800), z.literal(2800)]),
  })
  .strict();

export const CreateOrderInput = z
  .object({
    /** Generated on the POS device (UUIDv7), so an offline device can retry without creating duplicates. */
    id: z.string().uuid(),
    outletId: z.string().uuid(),
    channel: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']),
    tableRef: z.string().trim().max(20).optional(),
    lines: z
      .array(z.object({ itemId: z.string().uuid(), quantity: z.number().int().min(1).max(999) }).strict())
      .min(1)
      .max(200),
  })
  .strict();

export const CheckoutInput = z
  .object({
    method: PaymentMethod,
    /** Omit to pay the full amount due. */
    amountPaise: z.number().int().positive().optional(),
  })
  .strict();

interface OrderRow {
  id: string;
  tenant_id: string;
  outlet_id: string;
  channel: string;
  table_ref: string | null;
  status: 'OPEN' | 'SETTLED' | 'CANCELLED';
  request_hash: string;
  subtotal_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  round_off_paise: number;
  total_paise: number;
  paid_paise: number;
  overpaid_paise: number;
  invoice_no: string | null;
  created_at: Date;
  settled_at: Date | null;
}

interface OrderPaymentRow {
  payment_id: string;
  order_id: string;
  idempotency_key: string;
  method: PaymentMethod;
  amount_paise: number;
  status: 'PENDING' | 'CAPTURED' | 'FAILED' | 'CANCELLED';
  captured_paise: number;
  refunded_paise: number;
  state_version: number;
}

/** Indian financial year label, e.g. 2026-10-18 → "2627". */
export function financialYear(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000); // IST
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(APP_DB) private readonly db: Database,
    @Inject(RELAY) private readonly relay: OutboxRelay,
    @Inject(PAYMENTS) private readonly payments: PaymentClient,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  // ------------------------------------------------------------- menu

  async createMenuItem(p: Principal, input: z.infer<typeof CreateMenuItemInput>) {
    assertOutletAccess(p, input.outletId);
    const id = newId();
    await this.db.tx(
      (tx) =>
        tx.query(`INSERT INTO menu_items (id, tenant_id, outlet_id, name, price_paise, gst_rate_bp) VALUES ($1, $2, $3, $4, $5, $6)`, [
          id, p.tenantId, input.outletId, input.name, input.pricePaise, input.gstRateBp,
        ]),
      { tenantId: p.tenantId },
    );
    return { id, ...input };
  }

  // ------------------------------------------------------------- orders

  /** Prices come from the menu on the server. The client sends only item ids and quantities. */
  async createOrder(p: Principal, input: z.infer<typeof CreateOrderInput>) {
    assertOutletAccess(p, input.outletId);
    const requestHash = createHash('sha256').update(JSON.stringify([input.outletId, input.channel, input.tableRef ?? null, input.lines])).digest('hex');

    const created = await this.db.tx(
      async (tx) => {
        const existing = await this.findOrder(tx, input.id);
        if (existing) {
          if (existing.request_hash !== requestHash) throw new ConflictError('IDEMPOTENCY_MISMATCH', 'Order id already used with different content');
          return false;
        }
        const ids = [...new Set(input.lines.map((l) => l.itemId))];
        const { rows: items } = await tx.query<{ id: string; name: string; price_paise: number; gst_rate_bp: number }>(
          `SELECT id, name, price_paise, gst_rate_bp FROM menu_items WHERE id = ANY($1::uuid[]) AND outlet_id = $2 AND is_active`,
          [ids, input.outletId],
        );
        const byId = new Map(items.map((i) => [i.id, i]));
        const missing = ids.filter((i) => !byId.has(i));
        if (missing.length) throw new ValidationError('Unknown or inactive menu items', { itemIds: missing });

        const lines = input.lines.map((l) => {
          const item = byId.get(l.itemId)!;
          const lineSubtotal = safeMultiply(item.price_paise, l.quantity);
          return { ...l, item, lineSubtotal, lineTax: percentOf(lineSubtotal, item.gst_rate_bp) };
        });
        const subtotal = safeAdd(...lines.map((l) => l.lineSubtotal));
        const { cgstPaise, sgstPaise } = splitGst(safeAdd(...lines.map((l) => l.lineTax)));
        const { roundedPaise, roundOffPaise } = roundToRupee(safeAdd(subtotal, cgstPaise, sgstPaise));

        const { rowCount } = await tx.query(
          `INSERT INTO orders (id, tenant_id, outlet_id, channel, table_ref, status, request_hash, subtotal_paise, cgst_paise, sgst_paise, round_off_paise, total_paise, created_by)
           VALUES ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
          [input.id, p.tenantId, input.outletId, input.channel, input.tableRef ?? null, requestHash, subtotal, cgstPaise, sgstPaise, roundOffPaise, roundedPaise, p.userId],
        );
        if (!rowCount) throw new ConflictError('ORDER_ID_TAKEN', 'Concurrent request with the same order id; retry');
        for (const l of lines) {
          await tx.query(
            `INSERT INTO order_lines (id, tenant_id, order_id, item_id, name, unit_price_paise, quantity, gst_rate_bp, line_subtotal_paise, line_tax_paise)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [newId(), p.tenantId, input.id, l.itemId, l.item.name, l.item.price_paise, l.quantity, l.item.gst_rate_bp, l.lineSubtotal, l.lineTax],
          );
        }
        return true;
      },
      { tenantId: p.tenantId },
    );
    return { created, order: await this.getOrder(p, input.id) };
  }

  async getOrder(p: Principal, id: string) {
    return this.db.tx(
      async (tx) => {
        const order = await this.findOrder(tx, id);
        if (!order) throw new NotFoundError('Order');
        assertOutletAccess(p, order.outlet_id);
        const { rows: lines } = await tx.query('SELECT item_id, name, unit_price_paise, quantity, gst_rate_bp, line_subtotal_paise, line_tax_paise FROM order_lines WHERE order_id = $1 ORDER BY id', [id]);
        const { rows: pays } = await tx.query<OrderPaymentRow>('SELECT * FROM order_payments WHERE order_id = $1 ORDER BY created_at', [id]);
        return this.view(order, lines, pays);
      },
      { tenantId: p.tenantId },
    );
  }

  async cancelOrder(p: Principal, id: string) {
    await this.db.tx(
      async (tx) => {
        const order = await this.lockOrder(tx, id);
        assertOutletAccess(p, order.outlet_id);
        if (order.status === 'CANCELLED') return;
        if (order.status !== 'OPEN') throw new ConflictError('NOT_CANCELLABLE', `Order is ${order.status}`);
        const { rows } = await tx.query(`SELECT 1 FROM order_payments WHERE order_id = $1 AND status IN ('PENDING','CAPTURED')`, [id]);
        if (rows.length) throw new ConflictError('HAS_PAYMENTS', 'Cancel or refund payments before cancelling the order');
        await tx.query(`UPDATE orders SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [id]);
      },
      { tenantId: p.tenantId },
    );
    return this.getOrder(p, id);
  }

  // ------------------------------------------------------------- payments

  /**
   * Starts a payment for an order. The order row is locked while the amount
   * due is computed, so two cashiers can't both collect the same balance.
   * The network call to the payment service happens AFTER that commit, and is
   * safe to repeat: the client resends the same Idempotency-Key, we reuse the
   * same payment id, and the payment service deduplicates.
   */
  async checkout(p: Principal, orderId: string, input: z.infer<typeof CheckoutInput>, idempotencyKey: string) {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) throw new ValidationError('Idempotency-Key header must be 8-100 chars [A-Za-z0-9_-]');

    const op = await this.db.tx(
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        assertOutletAccess(p, order.outlet_id);
        const { rows: prior } = await tx.query<OrderPaymentRow>('SELECT * FROM order_payments WHERE idempotency_key = $1', [idempotencyKey]);
        if (prior[0]) {
          if (prior[0].order_id !== orderId || prior[0].method !== input.method || (input.amountPaise !== undefined && input.amountPaise !== prior[0].amount_paise)) {
            throw new ConflictError('IDEMPOTENCY_MISMATCH', 'Idempotency-Key already used for a different payment');
          }
          return { row: prior[0], order };
        }
        if (order.status !== 'OPEN') throw new UnprocessableError('ORDER_NOT_OPEN', `Order is ${order.status}`);
        const due = await this.amountDue(tx, order);
        const amount = input.amountPaise ?? due;
        if (due <= 0) throw new UnprocessableError('NOTHING_DUE', 'Nothing left to pay (check pending payments)');
        if (amount > due) throw new UnprocessableError('AMOUNT_EXCEEDS_DUE', 'Amount is more than the balance due', { duePaise: due });
        const { rows } = await tx.query<OrderPaymentRow>(
          `INSERT INTO order_payments (payment_id, tenant_id, order_id, idempotency_key, method, amount_paise, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING') RETURNING *`,
          [newId(), p.tenantId, orderId, idempotencyKey, input.method, amount],
        );
        return { row: rows[0]!, order };
      },
      { tenantId: p.tenantId },
    );

    if (op.row.status === 'FAILED') throw new UnprocessableError('PAYMENT_FAILED', 'This payment attempt failed; start a new one with a new Idempotency-Key');

    try {
      const remote = await this.payments.create(p.tenantId, {
        id: op.row.payment_id,
        orderId,
        outletId: op.order.outlet_id,
        method: op.row.method,
        amountPaise: op.row.amount_paise,
      });
      return { paymentId: op.row.payment_id, status: remote.status, amountPaise: op.row.amount_paise, checkout: remote.checkout };
    } catch (err) {
      if (err instanceof PaymentRejected) {
        // Definitive "no": release the reserved amount so the order can be paid another way.
        await this.markAttemptFailed(p.tenantId, op.row.payment_id);
        throw new UnprocessableError('PAYMENT_REJECTED', 'Payment could not be started', (err.body as { error?: unknown })?.error);
      }
      // Unknown outcome: keep it PENDING. Retrying with the same Idempotency-Key is safe.
      this.log.warn({ err, paymentId: op.row.payment_id }, 'payment service unavailable during checkout');
      throw new UpstreamError('Payment service unavailable. Retry with the same Idempotency-Key.');
    }
  }

  async cancelPayment(p: Principal, orderId: string, paymentId: string) {
    const row = await this.db.tx(
      async (tx) => {
        const { rows } = await tx.query<OrderPaymentRow & { outlet_id: string }>(
          'SELECT op.*, o.outlet_id FROM order_payments op JOIN orders o ON o.id = op.order_id WHERE op.payment_id = $1 AND op.order_id = $2',
          [paymentId, orderId],
        );
        if (!rows[0]) throw new NotFoundError('Payment');
        assertOutletAccess(p, rows[0].outlet_id);
        return rows[0];
      },
      { tenantId: p.tenantId },
    );
    if (row.status !== 'PENDING') return { paymentId, status: row.status };
    try {
      const remote = await this.payments.cancel(p.tenantId, paymentId);
      return { paymentId, status: remote.status };
    } catch (err) {
      if (err instanceof PaymentRejected && err.status === 404) {
        // The payment service never received it: safe to drop our pending attempt.
        await this.markAttemptFailed(p.tenantId, paymentId);
        return { paymentId, status: 'FAILED' };
      }
      if (err instanceof PaymentRejected) throw new ConflictError('NOT_CANCELLABLE', 'Payment can no longer be cancelled', (err.body as { error?: unknown })?.error);
      throw new UpstreamError('Payment service unavailable; try again');
    }
  }

  private async markAttemptFailed(tenantId: string, paymentId: string) {
    await this.db.tx(
      (tx) => tx.query(`UPDATE order_payments SET status = 'FAILED', updated_at = now() WHERE payment_id = $1 AND status = 'PENDING' AND state_version = 0`, [paymentId]),
      { tenantId },
    );
  }

  // ------------------------------------------------------------- reflection of payment events

  /**
   * Applies a payment snapshot from the payment service. Runs inside the
   * consumer's transaction (with the inbox row), so it happens exactly once.
   * Older snapshots are ignored, so out-of-order delivery is harmless.
   */
  async applyPaymentSnapshot(tx: Tx, tenantId: string, snap: PaymentSnapshot): Promise<void> {
    const { rows } = await tx.query<OrderPaymentRow>('SELECT * FROM order_payments WHERE payment_id = $1 FOR UPDATE', [snap.paymentId]);
    const op = rows[0];
    if (!op) {
      this.log.warn({ paymentId: snap.paymentId }, 'payment event for unknown order payment ignored');
      return;
    }
    if (snap.stateVersion <= op.state_version) return; // stale or duplicate
    await tx.query(
      `UPDATE order_payments SET status = $2, captured_paise = $3, refunded_paise = $4, state_version = $5, updated_at = now() WHERE payment_id = $1`,
      [snap.paymentId, snap.status, snap.capturedPaise, snap.refundedPaise, snap.stateVersion],
    );
    await this.recomputeOrder(tx, tenantId, op.order_id);
  }

  private async recomputeOrder(tx: Tx, tenantId: string, orderId: string) {
    const order = await this.lockOrder(tx, orderId);
    const { rows: pays } = await tx.query<OrderPaymentRow>('SELECT * FROM order_payments WHERE order_id = $1', [orderId]);
    const captured = pays.filter((x) => x.status === 'CAPTURED');
    const paid = safeAdd(0, ...captured.map((x) => x.captured_paise - x.refunded_paise));
    // Money for a cancelled order is all excess; otherwise anything above the total.
    const excess = order.status === 'CANCELLED' ? paid : Math.max(0, paid - order.total_paise);

    let status = order.status;
    let invoiceNo = order.invoice_no;
    let settledAt = order.settled_at;
    if (order.status === 'OPEN' && paid >= order.total_paise) {
      status = 'SETTLED';
      settledAt = new Date();
      invoiceNo = await this.nextInvoiceNo(tx, tenantId, order.outlet_id, settledAt);
    }
    await tx.query(
      `UPDATE orders SET paid_paise = $2, overpaid_paise = $3, status = $4, invoice_no = $5, settled_at = $6, updated_at = now() WHERE id = $1`,
      [orderId, paid, excess, status, invoiceNo, settledAt],
    );

    if (status === 'SETTLED' && order.status === 'OPEN') {
      const payload: EventPayload<typeof Topics.OrderSettled> = {
        orderId,
        outletId: order.outlet_id,
        invoiceNo: invoiceNo!,
        subtotalPaise: order.subtotal_paise,
        cgstPaise: order.cgst_paise,
        sgstPaise: order.sgst_paise,
        roundOffPaise: order.round_off_paise,
        totalPaise: order.total_paise,
        paidPaise: paid,
        payments: captured.map((x) => ({ paymentId: x.payment_id, method: x.method, netPaise: x.captured_paise - x.refunded_paise })),
        settledAt: settledAt!.toISOString(),
      };
      await enqueueEvent(tx, Topics.OrderSettled, tenantId, orderId, payload);
    }
    if (excess > order.overpaid_paise) {
      this.log.error({ orderId, excess }, 'order overpaid; refund required');
      await enqueueEvent(tx, Topics.OrderOverpaid, tenantId, orderId, {
        orderId,
        outletId: order.outlet_id,
        totalPaise: order.total_paise,
        paidPaise: paid,
        excessPaise: excess,
      });
    }
    this.relay.nudge();
  }

  /** Gapless per outlet+FY: the counter row is locked by the UPDATE until this transaction commits. */
  private async nextInvoiceNo(tx: Tx, tenantId: string, outletId: string, at: Date): Promise<string> {
    const fy = financialYear(at);
    const { rows } = await tx.query<{ next_no: number }>(
      `INSERT INTO invoice_counters (tenant_id, outlet_id, fy, next_no) VALUES ($1, $2, $3, 2)
       ON CONFLICT (tenant_id, outlet_id, fy) DO UPDATE SET next_no = invoice_counters.next_no + 1
       RETURNING next_no - 1 AS next_no`,
      [tenantId, outletId, fy],
    );
    return `${fy}/${String(rows[0]!.next_no).padStart(6, '0')}`;
  }

  // ------------------------------------------------------------- helpers

  private async amountDue(tx: Tx, order: OrderRow): Promise<number> {
    const { rows } = await tx.query<{ committed: number }>(
      `SELECT COALESCE(SUM(CASE WHEN status = 'CAPTURED' THEN captured_paise - refunded_paise
                                WHEN status = 'PENDING' THEN amount_paise ELSE 0 END), 0)::bigint AS committed
         FROM order_payments WHERE order_id = $1`,
      [order.id],
    );
    return order.total_paise - rows[0]!.committed;
  }

  private async findOrder(tx: Tx, id: string): Promise<OrderRow | undefined> {
    return (await tx.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [id])).rows[0];
  }

  private async lockOrder(tx: Tx, id: string): Promise<OrderRow> {
    const row = (await tx.query<OrderRow>('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new NotFoundError('Order');
    return row;
  }

  private view(o: OrderRow, lines: unknown[], pays: OrderPaymentRow[]) {
    const committed = pays.reduce(
      (s, x) => s + (x.status === 'CAPTURED' ? x.captured_paise - x.refunded_paise : x.status === 'PENDING' ? x.amount_paise : 0),
      0,
    );
    return {
      id: o.id,
      outletId: o.outlet_id,
      channel: o.channel,
      tableRef: o.table_ref,
      status: o.status,
      invoiceNo: o.invoice_no,
      subtotalPaise: o.subtotal_paise,
      cgstPaise: o.cgst_paise,
      sgstPaise: o.sgst_paise,
      roundOffPaise: o.round_off_paise,
      totalPaise: o.total_paise,
      paidPaise: o.paid_paise,
      duePaise: o.status === 'OPEN' ? Math.max(0, o.total_paise - committed) : 0,
      overpaidPaise: o.overpaid_paise,
      settledAt: o.settled_at,
      lines,
      payments: pays.map((x) => ({
        paymentId: x.payment_id,
        method: x.method,
        status: x.status,
        amountPaise: x.amount_paise,
        capturedPaise: x.captured_paise,
        refundedPaise: x.refunded_paise,
      })),
    };
  }
}
