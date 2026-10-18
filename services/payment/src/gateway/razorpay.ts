import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Logger, ResilientHttpClient } from '@ros/common';
import {
  GatewayOrder,
  GatewayPaymentInfo,
  GatewayRefundInfo,
  GatewayRejectedError,
  PaymentGateway,
  WebhookEvent,
} from './gateway';

export function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time comparison so attackers can't guess a signature byte by byte from response timing. */
export function safeEqualHex(expectedHex: string, actual: string): boolean {
  if (!/^[0-9a-f]+$/i.test(actual)) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(actual, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const PaymentEntity = z.object({
  id: z.string(),
  order_id: z.string().nullable(),
  amount: z.number().int().nonnegative(),
  currency: z.string(),
  status: z.enum(['created', 'authorized', 'captured', 'refunded', 'failed']),
  error_description: z.string().nullable().optional(),
});
const RefundEntity = z.object({
  id: z.string(),
  amount: z.number().int().nonnegative(),
  status: z.enum(['pending', 'processed', 'failed']),
  notes: z.union([z.record(z.string()), z.array(z.unknown())]).optional(),
});
const WebhookBody = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({ entity: PaymentEntity }).optional(),
    refund: z.object({ entity: RefundEntity }).optional(),
  }),
});

function refundIdFromNotes(notes: unknown): string | undefined {
  if (notes && !Array.isArray(notes) && typeof (notes as Record<string, unknown>).refund_id === 'string') {
    return (notes as Record<string, string>).refund_id;
  }
  return undefined;
}

/** Parses Razorpay's webhook wire format. Shared by the real and fake gateways. */
export function parseRazorpayWebhook(body: unknown): WebhookEvent {
  const parsed = WebhookBody.safeParse(body);
  if (!parsed.success) return { kind: 'ignored', type: 'malformed' };
  const { event, payload } = parsed.data;
  const p = payload.payment?.entity;
  const r = payload.refund?.entity;
  switch (event) {
    case 'payment.captured':
    case 'order.paid':
      if (!p?.order_id || p.status !== 'captured') return { kind: 'ignored', type: event };
      return { kind: 'payment.captured', gatewayOrderId: p.order_id, gatewayPaymentId: p.id, amountPaise: p.amount, currency: p.currency };
    case 'payment.failed':
      if (!p?.order_id) return { kind: 'ignored', type: event };
      return { kind: 'payment.failed', gatewayOrderId: p.order_id, gatewayPaymentId: p.id, reason: p.error_description ?? 'failed' };
    case 'refund.processed':
    case 'refund.failed':
      if (!r) return { kind: 'ignored', type: event };
      return { kind: event, gatewayRefundId: r.id, refundId: refundIdFromNotes(r.notes), amountPaise: r.amount };
    default:
      return { kind: 'ignored', type: event };
  }
}

/**
 * Razorpay adapter (https://razorpay.com/docs/api/). Only calls that are safe
 * to repeat (GETs) are retried automatically; creating orders and refunds is
 * never blindly retried, because a timeout does not mean it didn't happen.
 * Those cases are resolved by the reconciler, which asks Razorpay what happened.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;
  private readonly http: ResilientHttpClient;

  constructor(
    private readonly cfg: { keyId: string; keySecret: string; webhookSecret: string; baseUrl?: string },
    log: Logger,
  ) {
    const basic = Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64');
    this.http = new ResilientHttpClient(cfg.baseUrl ?? 'https://api.razorpay.com', log, {
      name: 'razorpay',
      timeoutMs: 8_000,
      retries: 3,
      defaultHeaders: { authorization: `Basic ${basic}` },
    });
  }

  get publicKeyId(): string {
    return this.cfg.keyId;
  }

  private check<T>(res: { status: number; body: unknown }, schema: z.ZodType<T>): T {
    if (res.status >= 400) {
      const desc = (res.body as { error?: { description?: string } })?.error?.description ?? `HTTP ${res.status}`;
      throw new GatewayRejectedError(desc, { status: res.status });
    }
    return schema.parse(res.body);
  }

  async createOrder(input: { paymentId: string; amountPaise: number; notes: Record<string, string> }): Promise<GatewayOrder> {
    const res = await this.http.request('POST', '/v1/orders', {
      idempotent: false,
      body: { amount: input.amountPaise, currency: 'INR', receipt: input.paymentId, notes: input.notes },
    });
    const order = this.check(res, z.object({ id: z.string(), amount: z.number() }));
    if (order.amount !== input.amountPaise) throw new GatewayRejectedError('gateway order amount mismatch');
    return { gatewayOrderId: order.id };
  }

  async listOrderPayments(gatewayOrderId: string): Promise<GatewayPaymentInfo[]> {
    const res = await this.http.request('GET', `/v1/orders/${encodeURIComponent(gatewayOrderId)}/payments`, { idempotent: true });
    const body = this.check(res, z.object({ items: z.array(PaymentEntity) }));
    return body.items.map((p) => ({ gatewayPaymentId: p.id, amountPaise: p.amount, currency: p.currency, status: p.status }));
  }

  async refund(input: { gatewayPaymentId: string; amountPaise: number; refundId: string }): Promise<GatewayRefundInfo> {
    const res = await this.http.request('POST', `/v1/payments/${encodeURIComponent(input.gatewayPaymentId)}/refund`, {
      idempotent: false,
      body: { amount: input.amountPaise, speed: 'normal', receipt: input.refundId, notes: { refund_id: input.refundId } },
    });
    const r = this.check(res, RefundEntity);
    return { gatewayRefundId: r.id, status: r.status, amountPaise: r.amount, refundId: refundIdFromNotes(r.notes) };
  }

  async listRefunds(gatewayPaymentId: string): Promise<GatewayRefundInfo[]> {
    const res = await this.http.request('GET', `/v1/payments/${encodeURIComponent(gatewayPaymentId)}/refunds`, { idempotent: true });
    const body = this.check(res, z.object({ items: z.array(RefundEntity) }));
    return body.items.map((r) => ({ gatewayRefundId: r.id, status: r.status, amountPaise: r.amount, refundId: refundIdFromNotes(r.notes) }));
  }

  verifyCheckoutSignature(gatewayOrderId: string, gatewayPaymentId: string, signature: string): boolean {
    return safeEqualHex(hmacHex(this.cfg.keySecret, `${gatewayOrderId}|${gatewayPaymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return safeEqualHex(hmacHex(this.cfg.webhookSecret, rawBody), signature);
  }

  parseWebhook(body: unknown): WebhookEvent {
    return parseRazorpayWebhook(body);
  }
}
