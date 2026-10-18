import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PaymentMethod, PaymentSnapshot, Topics } from '@ros/contracts';
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
  Principal,
  Tx,
  UnprocessableError,
  UpstreamError,
  ValidationError,
} from '@ros/common';
import { GatewayRejectedError, PaymentGateway } from './gateway/gateway';

export const APP_DB = Symbol('APP_DB');
export const WORKER_DB = Symbol('WORKER_DB');
export const GATEWAY = Symbol('GATEWAY');
export const RELAY = Symbol('RELAY');

export const CreatePaymentInput = z
  .object({
    id: z.string().uuid(),
    orderId: z.string().uuid(),
    outletId: z.string().uuid(),
    method: PaymentMethod,
    amountPaise: z.number().int().positive().max(10_000_000_00), // ₹1 crore ceiling per payment
  })
  .strict();
export type CreatePaymentInput = z.infer<typeof CreatePaymentInput>;

export const RefundInput = z
  .object({
    amountPaise: z.number().int().positive(),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const VerifyInput = z
  .object({
    gatewayOrderId: z.string().min(1).max(64),
    gatewayPaymentId: z.string().min(1).max(64),
    signature: z.string().min(1).max(256),
  })
  .strict();

export interface PaymentRow {
  id: string;
  tenant_id: string;
  outlet_id: string;
  order_id: string;
  method: PaymentMethod;
  amount_paise: number;
  status: 'PENDING' | 'CAPTURED' | 'FAILED' | 'CANCELLED';
  captured_paise: number;
  refund_reserved_paise: number;
  refunded_paise: number;
  gateway: 'cash' | 'razorpay' | 'fake';
  gateway_order_id: string | null;
  gateway_payment_id: string | null;
  failure_reason: string | null;
  flag: string | null;
  state_version: number;
  created_at: Date;
}

interface RefundRow {
  id: string;
  tenant_id: string;
  payment_id: string;
  amount_paise: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  idempotency_key: string;
  gateway_refund_id: string | null;
  created_at: Date;
}

const STAFF = ['owner', 'manager', 'cashier', 'captain', 'service'] as const;

/**
 * Payment state machine.
 *
 *   PENDING ──capture──▶ CAPTURED ──refund(s)──▶ (refunded_paise grows, status stays CAPTURED)
 *      │                    ▲
 *      ├──cancel──▶ CANCELLED ─┤  late capture: the gateway says money arrived after we gave up.
 *      └──expire──▶ FAILED ────┘  Money received always wins; the order side handles the overpayment.
 *
 * Every transition is a conditional UPDATE (`WHERE status = ...`) inside a
 * transaction that also writes the audit row and the outbox event, so
 * concurrent webhooks, retries and clicks can't double-apply anything.
 * Gateway network calls never happen while a DB transaction is open.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(APP_DB) private readonly db: Database,
    @Inject(WORKER_DB) private readonly workerDb: Database,
    @Inject(GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(RELAY) private readonly relay: OutboxRelay,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  // ---------------------------------------------------------------- create

  async create(p: Principal, input: CreatePaymentInput): Promise<{ created: boolean; payment: PaymentView }> {
    assertOutletAccess(p, input.outletId);
    const isCash = input.method === 'CASH';

    const { row, created } = await this.db.tx(
      async (tx) => {
        const existing = await this.findForUpdate(tx, input.id);
        if (existing) {
          this.assertSameRequest(existing, input);
          return { row: existing, created: false };
        }
        const { rows } = await tx.query<PaymentRow>(
          `INSERT INTO payments (id, tenant_id, outlet_id, order_id, method, amount_paise, status, captured_paise, gateway, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO NOTHING RETURNING *`,
          [
            input.id, p.tenantId, input.outletId, input.orderId, input.method, input.amountPaise,
            isCash ? 'CAPTURED' : 'PENDING', isCash ? input.amountPaise : 0, isCash ? 'cash' : this.gateway.name, p.userId,
          ],
        );
        if (!rows[0]) {
          // A concurrent request with the same id won the insert; treat as a replay.
          const raced = await this.findForUpdate(tx, input.id);
          if (!raced) throw new ConflictError('PAYMENT_ID_TAKEN', 'Payment id already used');
          this.assertSameRequest(raced, input);
          return { row: raced, created: false };
        }
        const row = rows[0];
        await this.audit(tx, row, 'CREATED', null, row.status, p.userId, { method: row.method, amountPaise: row.amount_paise });
        if (isCash) await this.emitCaptured(tx, row, false);
        return { row, created: true };
      },
      { tenantId: p.tenantId },
    );
    this.relay.nudge();

    // Gateway payments need a gateway order before the customer can pay.
    // Done after commit, and repeated safely when the client retries with the same id.
    if (row.status === 'PENDING' && !row.gateway_order_id) {
      return { created, payment: this.view(await this.attachGatewayOrder(p, row)) };
    }
    return { created, payment: this.view(row) };
  }

  private assertSameRequest(row: PaymentRow, input: CreatePaymentInput) {
    if (row.order_id !== input.orderId || row.outlet_id !== input.outletId || row.method !== input.method || row.amount_paise !== input.amountPaise) {
      throw new ConflictError('IDEMPOTENCY_MISMATCH', 'This payment id was already used with different details');
    }
  }

  private async attachGatewayOrder(p: Principal, row: PaymentRow): Promise<PaymentRow> {
    let gatewayOrderId: string;
    try {
      ({ gatewayOrderId } = await this.gateway.createOrder({
        paymentId: row.id,
        amountPaise: row.amount_paise,
        notes: { payment_id: row.id, tenant_id: row.tenant_id, order_id: row.order_id },
      }));
    } catch (err) {
      if (err instanceof GatewayRejectedError) {
        await this.fail(row.tenant_id, row.id, `GATEWAY_REJECTED: ${err.message}`, p.userId);
        throw new UnprocessableError('GATEWAY_REJECTED', 'Payment gateway rejected the payment', { reason: err.message });
      }
      // Outage/timeout: payment stays PENDING; the client may retry with the same id.
      throw new UpstreamError('Payment gateway is unavailable, please retry');
    }
    return this.db.tx(
      async (tx) => {
        const { rows } = await tx.query<PaymentRow>(
          `UPDATE payments SET gateway_order_id = $2, updated_at = now()
            WHERE id = $1 AND gateway_order_id IS NULL RETURNING *`,
          [row.id, gatewayOrderId],
        );
        if (rows[0]) {
          await this.audit(tx, rows[0], 'GATEWAY_ORDER_CREATED', 'PENDING', 'PENDING', p.userId, { gatewayOrderId });
          return rows[0];
        }
        // Another request attached an order first; use that one so the customer sees a single order.
        const current = await this.findForUpdate(tx, row.id);
        if (!current) throw new NotFoundError('Payment');
        return current;
      },
      { tenantId: row.tenant_id },
    );
  }

  // ---------------------------------------------------------------- read

  async get(p: Principal, id: string): Promise<PaymentView> {
    const row = await this.db.tx(async (tx) => this.find(tx, id), { tenantId: p.tenantId });
    if (!row) throw new NotFoundError('Payment');
    assertOutletAccess(p, row.outlet_id);
    return this.view(row);
  }

  // ---------------------------------------------------------------- capture

  /**
   * Client-side confirmation after the checkout widget closes. The signature
   * proves the ids came from Razorpay, but the AMOUNT is never taken from the
   * client: it is fetched from the gateway server-to-server.
   */
  async verify(p: Principal, id: string, input: z.infer<typeof VerifyInput>): Promise<PaymentView> {
    const row = await this.db.tx(async (tx) => this.find(tx, id), { tenantId: p.tenantId });
    if (!row) throw new NotFoundError('Payment');
    assertOutletAccess(p, row.outlet_id);
    if (row.gateway_order_id !== input.gatewayOrderId) throw new ValidationError('Gateway order does not belong to this payment');
    if (!this.gateway.verifyCheckoutSignature(input.gatewayOrderId, input.gatewayPaymentId, input.signature)) {
      this.log.warn({ paymentId: id, userId: p.userId }, 'invalid checkout signature');
      throw new ValidationError('Invalid payment signature');
    }
    await this.syncFromGateway(row.id, p.userId);
    return this.get(p, id);
  }

  /**
   * Single entry point for "the gateway says money was captured", used by
   * webhooks, client verification and the reconciler. Idempotent.
   */
  async applyCapture(e: { gatewayOrderId: string; gatewayPaymentId: string; amountPaise: number; currency: string }, actor: string): Promise<void> {
    await this.workerDb.tx(async (tx) => {
      const { rows } = await tx.query<PaymentRow>('SELECT * FROM payments WHERE gateway_order_id = $1 FOR UPDATE', [e.gatewayOrderId]);
      const row = rows[0];
      if (!row) throw new Error(`no payment for gateway order ${e.gatewayOrderId}`); // retried later
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [row.tenant_id]);

      if (row.status === 'CAPTURED') {
        if (row.gateway_payment_id === e.gatewayPaymentId) return; // duplicate notification
        // Customer paid twice against one gateway order: money must be returned.
        await this.flag(tx, row, 'DUPLICATE_CAPTURE', actor, { extraGatewayPaymentId: e.gatewayPaymentId, amountPaise: e.amountPaise });
        return;
      }
      if (e.currency !== 'INR' || e.amountPaise !== row.amount_paise) {
        await this.flag(tx, row, 'AMOUNT_MISMATCH', actor, { expected: row.amount_paise, received: e.amountPaise, currency: e.currency });
        return;
      }
      const late = row.status === 'CANCELLED' || row.status === 'FAILED';
      const { rows: updated } = await tx.query<PaymentRow>(
        `UPDATE payments SET status = 'CAPTURED', captured_paise = amount_paise, gateway_payment_id = $2,
                failure_reason = NULL, state_version = state_version + 1, updated_at = now()
          WHERE id = $1 AND status = $3 RETURNING *`,
        [row.id, e.gatewayPaymentId, row.status],
      );
      const next = updated[0]!;
      await this.audit(tx, next, late ? 'LATE_CAPTURE' : 'CAPTURED', row.status, 'CAPTURED', actor, { gatewayPaymentId: e.gatewayPaymentId });
      if (late) this.log.error({ paymentId: row.id }, 'payment captured after it was cancelled/failed; order will be flagged for refund');
      await this.emitCaptured(tx, next, late);
    });
    this.relay.nudge();
  }

  /** Asks the gateway for the truth about a pending payment and applies it. */
  async syncFromGateway(paymentId: string, actor: string, opts: { expireBefore?: Date } = {}): Promise<void> {
    const [row] = await this.workerDb.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [paymentId]);
    if (!row || row.gateway === 'cash') return;
    if (!row.gateway_order_id) {
      if (opts.expireBefore && row.status === 'PENDING' && row.created_at < opts.expireBefore) {
        await this.fail(row.tenant_id, row.id, 'GATEWAY_ORDER_NOT_CREATED', actor);
      }
      return;
    }
    const payments = await this.gateway.listOrderPayments(row.gateway_order_id);
    const captured = payments.filter((x) => x.status === 'captured');
    for (const c of captured) {
      await this.applyCapture({ gatewayOrderId: row.gateway_order_id, gatewayPaymentId: c.gatewayPaymentId, amountPaise: c.amountPaise, currency: c.currency }, actor);
    }
    if (!captured.length && opts.expireBefore && row.status === 'PENDING' && row.created_at < opts.expireBefore) {
      await this.fail(row.tenant_id, row.id, 'EXPIRED', actor);
    }
  }

  // ---------------------------------------------------------------- fail / cancel

  private async fail(tenantId: string, id: string, reason: string, actor: string): Promise<void> {
    await this.workerDb.tx(
      async (tx) => {
        const { rows } = await tx.query<PaymentRow>(
          `UPDATE payments SET status = 'FAILED', failure_reason = $2, state_version = state_version + 1, updated_at = now()
            WHERE id = $1 AND status = 'PENDING' RETURNING *`,
          [id, reason],
        );
        if (!rows[0]) return;
        await this.audit(tx, rows[0], 'FAILED', 'PENDING', 'FAILED', actor, { reason });
        await enqueueEvent(tx, Topics.PaymentFailed, tenantId, id, { ...this.snapshot(rows[0]), reason });
      },
      { tenantId },
    );
    this.relay.nudge();
  }

  /** Cashier abandons a pending payment (customer walked away, switched to cash...). */
  async cancel(p: Principal, id: string): Promise<PaymentView> {
    const before = await this.db.tx(async (tx) => this.find(tx, id), { tenantId: p.tenantId });
    if (!before) throw new NotFoundError('Payment');
    assertOutletAccess(p, before.outlet_id);
    if (before.status === 'CANCELLED') return this.view(before);
    if (before.status !== 'PENDING') throw new ConflictError('NOT_CANCELLABLE', `Payment is ${before.status}`);

    // Before giving up, make sure the customer has not actually paid in the meantime.
    if (before.gateway_order_id) {
      try {
        await this.syncFromGateway(id, p.userId);
      } catch (err) {
        throw new UpstreamError('Cannot confirm payment status with gateway; try again');
      }
    }
    const row = await this.db.tx(
      async (tx) => {
        const { rows } = await tx.query<PaymentRow>(
          `UPDATE payments SET status = 'CANCELLED', state_version = state_version + 1, updated_at = now()
            WHERE id = $1 AND status = 'PENDING' RETURNING *`,
          [id],
        );
        if (!rows[0]) {
          const now = await this.find(tx, id);
          if (now?.status === 'CANCELLED') return now;
          throw new ConflictError('NOT_CANCELLABLE', `Payment is ${now?.status}`);
        }
        await this.audit(tx, rows[0], 'CANCELLED', 'PENDING', 'CANCELLED', p.userId, {});
        await enqueueEvent(tx, Topics.PaymentCancelled, p.tenantId, id, this.snapshot(rows[0]));
        return rows[0];
      },
      { tenantId: p.tenantId },
    );
    this.relay.nudge();
    return this.view(row);
  }

  // ---------------------------------------------------------------- refunds

  async refund(p: Principal, paymentId: string, input: z.infer<typeof RefundInput>, idempotencyKey: string): Promise<RefundView> {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) throw new ValidationError('Idempotency-Key header must be 8-100 chars [A-Za-z0-9_-]');

    // Step 1 (one transaction): reserve the amount. The conditional UPDATE makes
    // it impossible for two concurrent refunds to exceed the captured amount.
    const step1 = await this.db.tx(
      async (tx) => {
        const { rows: prior } = await tx.query<RefundRow>('SELECT * FROM refunds WHERE idempotency_key = $1', [idempotencyKey]);
        if (prior[0]) {
          if (prior[0].payment_id !== paymentId || prior[0].amount_paise !== input.amountPaise) {
            throw new ConflictError('IDEMPOTENCY_MISMATCH', 'Idempotency-Key already used for a different refund');
          }
          return { refund: prior[0], payment: (await this.find(tx, paymentId))!, replay: true };
        }
        const payment = await this.findForUpdate(tx, paymentId);
        if (!payment) throw new NotFoundError('Payment');
        assertOutletAccess(p, payment.outlet_id);
        if (payment.status !== 'CAPTURED') throw new UnprocessableError('NOT_REFUNDABLE', `Payment is ${payment.status}`);
        const available = payment.captured_paise - payment.refund_reserved_paise;
        if (input.amountPaise > available) {
          throw new UnprocessableError('REFUND_EXCEEDS_CAPTURED', 'Refund is more than the refundable amount', { availablePaise: available });
        }
        const { rows } = await tx.query<PaymentRow>(
          `UPDATE payments SET refund_reserved_paise = refund_reserved_paise + $2, state_version = state_version + 1, updated_at = now()
            WHERE id = $1 AND refund_reserved_paise + $2 <= captured_paise RETURNING *`,
          [paymentId, input.amountPaise],
        );
        if (!rows[0]) throw new UnprocessableError('REFUND_EXCEEDS_CAPTURED', 'Refund is more than the refundable amount');
        const { rows: r } = await tx.query<RefundRow>(
          `INSERT INTO refunds (id, tenant_id, payment_id, amount_paise, status, reason, idempotency_key, created_by)
           VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7) RETURNING *`,
          [newId(), p.tenantId, paymentId, input.amountPaise, input.reason, idempotencyKey, p.userId],
        );
        await this.audit(tx, rows[0], 'REFUND_REQUESTED', 'CAPTURED', 'CAPTURED', p.userId, { refundId: r[0]!.id, amountPaise: input.amountPaise, reason: input.reason });
        return { refund: r[0]!, payment: rows[0], replay: false };
      },
      { tenantId: p.tenantId },
    );
    if (step1.replay || step1.refund.status !== 'PENDING') return this.refundView(step1.refund);

    const { refund, payment } = step1;
    if (payment.gateway === 'cash') {
      // Cash handed back at the counter: done immediately.
      return this.refundView(await this.completeRefund(refund.id, 'SUCCEEDED', p.userId, {}));
    }

    // Step 2: ask the gateway, outside any transaction.
    try {
      const res = await this.gateway.refund({ gatewayPaymentId: payment.gateway_payment_id!, amountPaise: refund.amount_paise, refundId: refund.id });
      if (res.status === 'processed') return this.refundView(await this.completeRefund(refund.id, 'SUCCEEDED', p.userId, { gatewayRefundId: res.gatewayRefundId }));
      if (res.status === 'failed') return this.refundView(await this.completeRefund(refund.id, 'FAILED', p.userId, { gatewayRefundId: res.gatewayRefundId, reason: 'gateway failed' }));
      await this.workerDb.query('UPDATE refunds SET gateway_refund_id = $2, updated_at = now() WHERE id = $1', [refund.id, res.gatewayRefundId]);
      return this.refundView({ ...refund, gateway_refund_id: res.gatewayRefundId }); // pending: webhook/reconciler will finish it
    } catch (err) {
      if (err instanceof GatewayRejectedError) {
        const failed = await this.completeRefund(refund.id, 'FAILED', p.userId, { reason: err.message });
        throw new UnprocessableError('REFUND_REJECTED', 'Gateway rejected the refund', { refundId: failed.id, reason: err.message });
      }
      // Unknown outcome (timeout). Keep it PENDING and let the reconciler find out; never re-send blindly.
      this.log.warn({ err, refundId: refund.id }, 'refund outcome unknown; reconciler will resolve');
      return this.refundView(refund);
    }
  }

  /** Finalises a pending refund exactly once. FAILED releases the reserved amount. */
  async completeRefund(
    refundId: string,
    outcome: 'SUCCEEDED' | 'FAILED',
    actor: string,
    info: { gatewayRefundId?: string; reason?: string },
  ): Promise<RefundRow> {
    const result = await this.workerDb.tx(async (tx) => {
      const { rows } = await tx.query<RefundRow>(
        `UPDATE refunds SET status = $2, gateway_refund_id = COALESCE($3, gateway_refund_id), failure_reason = $4, updated_at = now()
          WHERE id = $1 AND status = 'PENDING' RETURNING *`,
        [refundId, outcome, info.gatewayRefundId ?? null, info.reason ?? null],
      );
      const refund = rows[0];
      if (!refund) {
        const { rows: cur } = await tx.query<RefundRow>('SELECT * FROM refunds WHERE id = $1', [refundId]);
        if (!cur[0]) throw new NotFoundError('Refund');
        return cur[0]; // already finalised
      }
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [refund.tenant_id]);
      const sql =
        outcome === 'SUCCEEDED'
          ? `UPDATE payments SET refunded_paise = refunded_paise + $2, state_version = state_version + 1, updated_at = now() WHERE id = $1 RETURNING *`
          : `UPDATE payments SET refund_reserved_paise = refund_reserved_paise - $2, state_version = state_version + 1, updated_at = now() WHERE id = $1 RETURNING *`;
      const { rows: pay } = await tx.query<PaymentRow>(sql, [refund.payment_id, refund.amount_paise]);
      const payment = pay[0]!;
      await this.audit(tx, payment, outcome === 'SUCCEEDED' ? 'REFUND_SUCCEEDED' : 'REFUND_FAILED', 'CAPTURED', 'CAPTURED', actor, { refundId, ...info });
      if (outcome === 'SUCCEEDED') {
        await enqueueEvent(tx, Topics.PaymentRefunded, refund.tenant_id, payment.id, {
          ...this.snapshot(payment),
          refundId: refund.id,
          refundPaise: refund.amount_paise,
        });
      }
      return refund;
    });
    this.relay.nudge();
    return result;
  }

  async findRefundByGatewayOrOurId(gatewayRefundId: string, refundId?: string): Promise<RefundRow | undefined> {
    const rows = await this.workerDb.query<RefundRow>(
      'SELECT * FROM refunds WHERE gateway_refund_id = $1 OR id = $2::uuid LIMIT 1',
      [gatewayRefundId, refundId && /^[0-9a-f-]{36}$/i.test(refundId) ? refundId : null],
    );
    return rows[0];
  }

  /** Reconciler: resolves a refund whose outcome is unknown by asking the gateway. */
  async syncRefund(refundId: string, actor: string): Promise<void> {
    const [row] = await this.workerDb.query<RefundRow & { gateway_payment_id: string }>(
      `SELECT r.*, p.gateway_payment_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1 AND r.status = 'PENDING'`,
      [refundId],
    );
    if (!row) return;
    const remote = (await this.gateway.listRefunds(row.gateway_payment_id)).find(
      (r) => r.refundId === row.id || (row.gateway_refund_id && r.gatewayRefundId === row.gateway_refund_id),
    );
    if (!remote) {
      // The gateway never received it, so it is safe to release; staff can retry with a new key.
      await this.completeRefund(row.id, 'FAILED', actor, { reason: 'NOT_RECEIVED_BY_GATEWAY' });
    } else if (remote.status === 'processed') {
      await this.completeRefund(row.id, 'SUCCEEDED', actor, { gatewayRefundId: remote.gatewayRefundId });
    } else if (remote.status === 'failed') {
      await this.completeRefund(row.id, 'FAILED', actor, { gatewayRefundId: remote.gatewayRefundId, reason: 'gateway failed' });
    }
  }

  // ---------------------------------------------------------------- helpers

  private async find(tx: Tx, id: string): Promise<PaymentRow | undefined> {
    return (await tx.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [id])).rows[0];
  }
  private async findForUpdate(tx: Tx, id: string): Promise<PaymentRow | undefined> {
    return (await tx.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id])).rows[0];
  }

  private async flag(tx: Tx, row: PaymentRow, flag: string, actor: string, detail: object) {
    await tx.query('UPDATE payments SET flag = $2, updated_at = now() WHERE id = $1', [row.id, flag]);
    await this.audit(tx, row, `FLAG_${flag}`, row.status, row.status, actor, detail);
    this.log.error({ paymentId: row.id, flag, ...detail }, 'payment flagged for manual review');
  }

  private async audit(tx: Tx, row: PaymentRow, action: string, from: string | null, to: string | null, actor: string, detail: object) {
    await tx.query(
      `INSERT INTO payment_audit (tenant_id, payment_id, action, from_status, to_status, actor, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.tenant_id, row.id, action, from, to, actor, JSON.stringify(detail)],
    );
  }

  private async emitCaptured(tx: Tx, row: PaymentRow, lateCapture: boolean) {
    await enqueueEvent(tx, Topics.PaymentCaptured, row.tenant_id, row.id, { ...this.snapshot(row), lateCapture });
  }

  snapshot(row: PaymentRow): PaymentSnapshot {
    return {
      paymentId: row.id,
      orderId: row.order_id,
      outletId: row.outlet_id,
      method: row.method,
      status: row.status,
      amountPaise: row.amount_paise,
      capturedPaise: row.captured_paise,
      refundedPaise: row.refunded_paise,
      stateVersion: row.state_version,
    };
  }

  view(row: PaymentRow): PaymentView {
    return {
      id: row.id,
      orderId: row.order_id,
      outletId: row.outlet_id,
      method: row.method,
      status: row.status,
      amountPaise: row.amount_paise,
      capturedPaise: row.captured_paise,
      refundedPaise: row.refunded_paise,
      refundablePaise: row.captured_paise - row.refund_reserved_paise,
      flag: row.flag,
      failureReason: row.failure_reason,
      checkout:
        row.status === 'PENDING' && row.gateway_order_id
          ? { gateway: row.gateway, keyId: this.gateway.publicKeyId, gatewayOrderId: row.gateway_order_id, amountPaise: row.amount_paise, currency: 'INR' }
          : null,
    };
  }

  private refundView(r: RefundRow): RefundView {
    return { id: r.id, paymentId: r.payment_id, amountPaise: r.amount_paise, status: r.status };
  }
}

export interface PaymentView {
  id: string;
  orderId: string;
  outletId: string;
  method: PaymentMethod;
  status: PaymentRow['status'];
  amountPaise: number;
  capturedPaise: number;
  refundedPaise: number;
  refundablePaise: number;
  flag: string | null;
  failureReason: string | null;
  checkout: { gateway: string; keyId: string; gatewayOrderId: string; amountPaise: number; currency: 'INR' } | null;
}

export interface RefundView {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: RefundRow['status'];
}

export { STAFF };
