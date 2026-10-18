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
    /** Recipe (food) cost per portion, for menu engineering and P&L. */
    costPaise: z.number().int().min(0).max(10_000_000).optional(),
    category: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export const AttachCustomerInput = z
  .object({
    phone: z.string().regex(/^[6-9][0-9]{9}$/, 'must be a 10-digit Indian mobile number'),
    name: z.string().trim().min(1).max(80).optional(),
    marketingConsent: z.boolean().default(false),
  })
  .strict();

const LineInput = z.object({ itemId: z.string().uuid(), quantity: z.number().int().min(1).max(999) }).strict();

export const CreateOrderInput = z
  .object({
    /** Generated on the POS device (UUIDv7), so an offline device can retry without creating duplicates. */
    id: z.string().uuid(),
    outletId: z.string().uuid(),
    channel: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']),
    tableRef: z.string().trim().min(1).max(20).optional(),
    guests: z.number().int().min(1).max(50).optional(),
    lines: z.array(LineInput).min(1).max(200),
  })
  .strict()
  .refine((o) => o.channel !== 'DINE_IN' || !!o.tableRef, { message: 'tableRef is required for dine-in', path: ['tableRef'] });

/** A further round of items for a running table tab. kotId comes from the captain's device. */
export const AddItemsInput = z
  .object({
    kotId: z.string().uuid(),
    lines: z.array(LineInput).min(1).max(100),
  })
  .strict();

export const CreateTableInput = z
  .object({
    outletId: z.string().uuid(),
    label: z.string().trim().min(1).max(20),
    seats: z.number().int().min(1).max(30),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
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
  guests: number | null;
  kot_count: number;
  bill_requested_at: Date | null;
  customer_phone: string | null;
  customer_name: string | null;
  marketing_consent: boolean;
  created_by: string;
  created_at: Date;
  settled_at: Date | null;
}

type PricedLine = { itemId: string; quantity: number; item: { name: string; price_paise: number; gst_rate_bp: number; cost_paise: number | null }; lineSubtotal: number; lineTax: number };

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

const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

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
        tx.query(`INSERT INTO menu_items (id, tenant_id, outlet_id, name, price_paise, gst_rate_bp, cost_paise, category) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
          id, p.tenantId, input.outletId, input.name, input.pricePaise, input.gstRateBp, input.costPaise ?? null, input.category ?? null,
        ]),
      { tenantId: p.tenantId },
    );
    return { id, ...input };
  }

  // ------------------------------------------------------------- orders

  /**
   * Opens an order (for dine-in: a running tab on a table). Prices come from the
   * menu on the server; the client sends only item ids and quantities. The
   * first round of items becomes KOT #1 and is sent to the kitchen via an event.
   */
  async createOrder(p: Principal, input: z.infer<typeof CreateOrderInput>) {
    assertOutletAccess(p, input.outletId);
    const requestHash = hashOf([input.outletId, input.channel, input.tableRef ?? null, input.guests ?? null, input.lines]);

    let created: boolean;
    try {
      created = await this.db.tx(
        async (tx) => {
          const existing = await this.findOrder(tx, input.id);
          if (existing) {
            if (existing.request_hash !== requestHash) throw new ConflictError('IDEMPOTENCY_MISMATCH', 'Order id already used with different content');
            return false;
          }
          const priced = await this.priceLines(tx, input.outletId, input.lines);
          const { rowCount } = await tx.query(
            `INSERT INTO orders (id, tenant_id, outlet_id, channel, table_ref, guests, status, request_hash,
                                 subtotal_paise, cgst_paise, sgst_paise, round_off_paise, total_paise, kot_count, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, 'OPEN', $7, 0, 0, 0, 0, 0, 1, $8) ON CONFLICT (id) DO NOTHING`,
            [input.id, p.tenantId, input.outletId, input.channel, input.tableRef ?? null, input.guests ?? null, requestHash, p.userId],
          );
          if (!rowCount) throw new ConflictError('ORDER_ID_TAKEN', 'Concurrent request with the same order id; retry');
          await this.insertKot(tx, p, { id: input.id, outlet_id: input.outletId, table_ref: input.tableRef ?? null }, newId(), 1, priced, requestHash);
          await this.recomputeTotals(tx, input.id);
          return true;
        },
        { tenantId: p.tenantId },
      );
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'one_open_order_per_table') {
        const [open] = await this.db.tx(
          async (tx) =>
            (await tx.query<{ id: string }>(`SELECT id FROM orders WHERE outlet_id = $1 AND table_ref = $2 AND status = 'OPEN'`, [input.outletId, input.tableRef])).rows,
          { tenantId: p.tenantId },
        );
        throw new ConflictError('TABLE_OCCUPIED', `Table ${input.tableRef} already has an open order`, { orderId: open?.id });
      }
      throw err;
    }
    this.relay.nudge();
    return { created, order: await this.getOrder(p, input.id) };
  }

  /** Captain adds another round of items to a running tab (a new KOT). Blocked once payment has started. */
  async addItems(p: Principal, orderId: string, input: z.infer<typeof AddItemsInput>) {
    const requestHash = hashOf([orderId, input.lines]);
    await this.db.tx(
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        assertOutletAccess(p, order.outlet_id);
        const { rows: prior } = await tx.query<{ order_id: string; request_hash: string }>('SELECT order_id, request_hash FROM kots WHERE id = $1', [input.kotId]);
        if (prior[0]) {
          if (prior[0].order_id !== orderId || prior[0].request_hash !== requestHash) throw new ConflictError('IDEMPOTENCY_MISMATCH', 'kotId already used with different items');
          return; // resend of the same KOT: nothing new goes to the kitchen
        }
        if (order.status !== 'OPEN') throw new ConflictError('ORDER_NOT_OPEN', `Order is ${order.status}`);
        const { rows: busy } = await tx.query(`SELECT 1 FROM order_payments WHERE order_id = $1 AND status IN ('PENDING','CAPTURED') LIMIT 1`, [orderId]);
        if (busy.length) throw new ConflictError('BILL_LOCKED', 'Payment has started on this bill; finish or cancel it before adding items');
        const priced = await this.priceLines(tx, order.outlet_id, input.lines);
        const kotNo = order.kot_count + 1;
        await this.insertKot(tx, p, order, input.kotId, kotNo, priced, requestHash);
        await tx.query('UPDATE orders SET kot_count = $2, bill_requested_at = NULL, updated_at = now() WHERE id = $1', [orderId, kotNo]);
        await this.recomputeTotals(tx, orderId);
      },
      { tenantId: p.tenantId },
    );
    this.relay.nudge();
    return this.getOrder(p, orderId);
  }

  /** Captain asks the cashier to prepare the bill; the table shows "bill requested" on the floor. */
  async requestBill(p: Principal, orderId: string) {
    await this.db.tx(
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        assertOutletAccess(p, order.outlet_id);
        if (order.status !== 'OPEN') throw new ConflictError('ORDER_NOT_OPEN', `Order is ${order.status}`);
        await tx.query('UPDATE orders SET bill_requested_at = COALESCE(bill_requested_at, now()), updated_at = now() WHERE id = $1', [orderId]);
      },
      { tenantId: p.tenantId },
    );
    return this.getOrder(p, orderId);
  }

  /** Captain or cashier records the guest's mobile number (for the bill on WhatsApp, loyalty and CRM). */
  async attachCustomer(p: Principal, orderId: string, input: z.infer<typeof AttachCustomerInput>) {
    await this.db.tx(
      async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        assertOutletAccess(p, order.outlet_id);
        if (order.status !== 'OPEN') throw new ConflictError('ORDER_NOT_OPEN', `Order is ${order.status}`);
        await tx.query('UPDATE orders SET customer_phone = $2, customer_name = $3, marketing_consent = $4, updated_at = now() WHERE id = $1', [
          orderId, input.phone, input.name ?? null, input.marketingConsent,
        ]);
      },
      { tenantId: p.tenantId },
    );
    return this.getOrder(p, orderId);
  }

  private async priceLines(tx: Tx, outletId: string, lines: { itemId: string; quantity: number }[]): Promise<PricedLine[]> {
    const ids = [...new Set(lines.map((l) => l.itemId))];
    const { rows: items } = await tx.query<{ id: string; name: string; price_paise: number; gst_rate_bp: number; cost_paise: number | null }>(
      `SELECT id, name, price_paise, gst_rate_bp, cost_paise FROM menu_items WHERE id = ANY($1::uuid[]) AND outlet_id = $2 AND is_active`,
      [ids, outletId],
    );
    const byId = new Map(items.map((i) => [i.id, i]));
    const missing = ids.filter((i) => !byId.has(i));
    if (missing.length) throw new ValidationError('Unknown or inactive menu items', { itemIds: missing });
    return lines.map((l) => {
      const item = byId.get(l.itemId)!;
      const lineSubtotal = safeMultiply(item.price_paise, l.quantity);
      return { ...l, item, lineSubtotal, lineTax: percentOf(lineSubtotal, item.gst_rate_bp) };
    });
  }

  private async insertKot(tx: Tx, p: Principal, order: { id: string; outlet_id: string; table_ref: string | null }, kotId: string, kotNo: number, lines: PricedLine[], requestHash: string) {
    await tx.query(`INSERT INTO kots (id, tenant_id, order_id, kot_no, request_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [
      kotId, p.tenantId, order.id, kotNo, requestHash, p.userId,
    ]);
    for (const l of lines) {
      await tx.query(
        `INSERT INTO order_lines (id, tenant_id, order_id, item_id, name, unit_price_paise, quantity, gst_rate_bp, line_subtotal_paise, line_tax_paise, kot_no, unit_cost_paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [newId(), p.tenantId, order.id, l.itemId, l.item.name, l.item.price_paise, l.quantity, l.item.gst_rate_bp, l.lineSubtotal, l.lineTax, kotNo, l.item.cost_paise],
      );
    }
    await enqueueEvent(tx, Topics.KotCreated, p.tenantId, order.id, {
      kotId,
      orderId: order.id,
      outletId: order.outlet_id,
      tableRef: order.table_ref,
      kotNo,
      lines: lines.map((l) => ({ itemId: l.itemId, name: l.item.name, quantity: l.quantity })),
      createdBy: p.userId,
    });
  }

  /** Bill totals are always recomputed from the stored lines, never patched incrementally. */
  private async recomputeTotals(tx: Tx, orderId: string) {
    const { rows } = await tx.query<{ subtotal: number; tax: number }>(
      `SELECT COALESCE(SUM(line_subtotal_paise), 0)::bigint AS subtotal, COALESCE(SUM(line_tax_paise), 0)::bigint AS tax FROM order_lines WHERE order_id = $1`,
      [orderId],
    );
    const { subtotal, tax } = rows[0]!;
    const { cgstPaise, sgstPaise } = splitGst(tax);
    const { roundedPaise, roundOffPaise } = roundToRupee(safeAdd(subtotal, cgstPaise, sgstPaise));
    await tx.query(
      `UPDATE orders SET subtotal_paise = $2, cgst_paise = $3, sgst_paise = $4, round_off_paise = $5, total_paise = $6, updated_at = now() WHERE id = $1`,
      [orderId, subtotal, cgstPaise, sgstPaise, roundOffPaise, roundedPaise],
    );
  }

  // ------------------------------------------------------------- tables & floor

  async createTable(p: Principal, input: z.infer<typeof CreateTableInput>) {
    assertOutletAccess(p, input.outletId);
    const id = newId();
    try {
      await this.db.tx(
        (tx) =>
          tx.query(`INSERT INTO dining_tables (id, tenant_id, outlet_id, label, seats, sort_order) VALUES ($1, $2, $3, $4, $5, $6)`, [
            id, p.tenantId, input.outletId, input.label, input.seats, input.sortOrder ?? 0,
          ]),
        { tenantId: p.tenantId },
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictError('TABLE_EXISTS', `Table ${input.label} already exists`);
      throw err;
    }
    return { id, ...input };
  }

  /**
   * Everything a captain or cashier needs on the floor screen in one call:
   * each table with its status, running amount, guests, time open and items.
   */
  async getFloor(p: Principal, outletId: string) {
    assertOutletAccess(p, outletId);
    return this.db.tx(
      async (tx) => {
        const { rows: tables } = await tx.query<{ label: string; seats: number }>(
          'SELECT label, seats FROM dining_tables WHERE outlet_id = $1 AND is_active ORDER BY sort_order, label',
          [outletId],
        );
        const { rows: open } = await tx.query<OrderRow & { committed: number; paying: boolean }>(
          `SELECT o.*,
                  COALESCE((SELECT SUM(CASE WHEN op.status = 'CAPTURED' THEN op.captured_paise - op.refunded_paise
                                            WHEN op.status = 'PENDING' THEN op.amount_paise ELSE 0 END)
                            FROM order_payments op WHERE op.order_id = o.id), 0)::bigint AS committed,
                  EXISTS (SELECT 1 FROM order_payments op WHERE op.order_id = o.id AND op.status = 'PENDING') AS paying
             FROM orders o WHERE o.outlet_id = $1 AND o.status = 'OPEN' AND o.table_ref IS NOT NULL`,
          [outletId],
        );
        const ids = open.map((o) => o.id);
        const { rows: items } = await tx.query<{ order_id: string; name: string; quantity: number }>(
          `SELECT order_id, name, SUM(quantity)::int AS quantity FROM order_lines WHERE order_id = ANY($1::uuid[])
            GROUP BY order_id, name ORDER BY MIN(kot_no), MIN(id::text)`,
          [ids],
        );
        const { rows: today } = await tx.query<{ count: number; total: number }>(
          `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_paise), 0)::bigint AS total FROM orders
            WHERE outlet_id = $1 AND status = 'SETTLED'
              AND settled_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`,
          [outletId],
        );
        const byTable = new Map(open.map((o) => [o.table_ref!, o]));
        const floor = tables.map((t) => {
          const o = byTable.get(t.label);
          const status = !o ? 'FREE' : o.paying ? 'PAYING' : o.bill_requested_at ? 'BILL_REQUESTED' : 'OCCUPIED';
          return {
            label: t.label,
            seats: t.seats,
            status,
            order: o && {
              id: o.id,
              guests: o.guests,
              totalPaise: o.total_paise,
              duePaise: Math.max(0, o.total_paise - o.committed),
              kotCount: o.kot_count,
              openedAt: o.created_at,
              billRequestedAt: o.bill_requested_at,
              items: items.filter((i) => i.order_id === o.id).map((i) => ({ name: i.name, quantity: i.quantity })),
            },
          };
        });
        return {
          tables: floor,
          summary: {
            free: floor.filter((t) => t.status === 'FREE').length,
            occupied: floor.filter((t) => t.status !== 'FREE').length,
            billRequested: floor.filter((t) => t.status === 'BILL_REQUESTED').length,
            runningPaise: open.reduce((s, o) => s + o.total_paise, 0),
            settledTodayCount: today[0]!.count,
            settledTodayPaise: today[0]!.total,
          },
        };
      },
      { tenantId: p.tenantId },
    );
  }

  /** Recent kitchen tickets for the kitchen display. */
  async listKots(p: Principal, outletId: string) {
    assertOutletAccess(p, outletId);
    return this.db.tx(
      async (tx) =>
        (
          await tx.query(
            `SELECT k.id, k.kot_no AS "kotNo", k.created_at AS "createdAt", k.created_by AS "createdBy", o.table_ref AS "tableRef", o.id AS "orderId",
                    json_agg(json_build_object('name', l.name, 'quantity', l.quantity) ORDER BY l.id) AS lines
               FROM kots k JOIN orders o ON o.id = k.order_id
               JOIN order_lines l ON l.order_id = k.order_id AND l.kot_no = k.kot_no
              WHERE o.outlet_id = $1
              GROUP BY k.id, o.table_ref, o.id ORDER BY k.created_at DESC LIMIT 30`,
            [outletId],
          )
        ).rows,
      { tenantId: p.tenantId },
    );
  }

  async getOrder(p: Principal, id: string) {
    return this.db.tx(
      async (tx) => {
        const order = await this.findOrder(tx, id);
        if (!order) throw new NotFoundError('Order');
        assertOutletAccess(p, order.outlet_id);
        const { rows: lines } = await tx.query('SELECT item_id, name, unit_price_paise, quantity, gst_rate_bp, line_subtotal_paise, line_tax_paise, kot_no FROM order_lines WHERE order_id = $1 ORDER BY kot_no, id', [id]);
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
        channel: order.channel as 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY',
        tableRef: order.table_ref,
        guests: order.guests,
        openedAt: order.created_at.toISOString(),
        createdBy: order.created_by,
        customer: order.customer_phone ? { phone: order.customer_phone, name: order.customer_name, marketingConsent: order.marketing_consent } : null,
        lines: (
          await tx.query<{ item_id: string; name: string; quantity: number; gst_rate_bp: number; line_subtotal_paise: number; line_tax_paise: number; unit_cost_paise: number | null }>(
            'SELECT item_id, name, quantity, gst_rate_bp, line_subtotal_paise, line_tax_paise, unit_cost_paise FROM order_lines WHERE order_id = $1 ORDER BY kot_no, id',
            [orderId],
          )
        ).rows.map((l) => ({
          itemId: l.item_id,
          name: l.name,
          quantity: l.quantity,
          gstRateBp: l.gst_rate_bp,
          netPaise: l.line_subtotal_paise,
          taxPaise: l.line_tax_paise,
          costPaise: l.unit_cost_paise === null ? null : l.unit_cost_paise * l.quantity,
        })),
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
      guests: o.guests,
      customer: o.customer_phone ? { phone: o.customer_phone, name: o.customer_name, marketingConsent: o.marketing_consent } : null,
      kotCount: o.kot_count,
      billRequestedAt: o.bill_requested_at,
      openedAt: o.created_at,
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
