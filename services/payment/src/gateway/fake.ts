import { randomBytes } from 'node:crypto';
import { UpstreamError } from '@ros/common';
import {
  GatewayOrder,
  GatewayPaymentInfo,
  GatewayRefundInfo,
  GatewayRejectedError,
  PaymentGateway,
  WebhookEvent,
} from './gateway';
import { hmacHex, parseRazorpayWebhook, safeEqualHex } from './razorpay';

const rid = (prefix: string) => `${prefix}_${randomBytes(7).toString('hex')}`;

/**
 * In-memory gateway that behaves like Razorpay (same webhook format and
 * signatures) for local development and tests. It can simulate outages,
 * customer payments and duplicate webhooks. Never used in production (config refuses it).
 */
export class FakeGateway implements PaymentGateway {
  readonly name = 'fake' as const;
  readonly publicKeyId = 'rzp_test_fake';
  readonly orders = new Map<string, { amountPaise: number; payments: GatewayPaymentInfo[] }>();
  readonly refunds = new Map<string, (GatewayRefundInfo & { gatewayPaymentId: string })[]>();
  /** Set to make the next N calls fail as if the gateway were down or timing out. */
  failNextCalls = 0;
  /** Status returned for new refunds. */
  refundMode: 'processed' | 'pending' | 'reject' = 'processed';

  constructor(
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  private maybeFail() {
    if (this.failNextCalls > 0) {
      this.failNextCalls--;
      throw new UpstreamError('fake gateway unavailable');
    }
  }

  async createOrder(input: { paymentId: string; amountPaise: number }): Promise<GatewayOrder> {
    this.maybeFail();
    const id = rid('order');
    this.orders.set(id, { amountPaise: input.amountPaise, payments: [] });
    return { gatewayOrderId: id };
  }

  async listOrderPayments(gatewayOrderId: string): Promise<GatewayPaymentInfo[]> {
    this.maybeFail();
    return [...(this.orders.get(gatewayOrderId)?.payments ?? [])];
  }

  async refund(input: { gatewayPaymentId: string; amountPaise: number; refundId: string }): Promise<GatewayRefundInfo> {
    this.maybeFail();
    if (this.refundMode === 'reject') throw new GatewayRejectedError('refund rejected by gateway');
    const r = { gatewayRefundId: rid('rfnd'), status: this.refundMode, amountPaise: input.amountPaise, refundId: input.refundId, gatewayPaymentId: input.gatewayPaymentId };
    this.refunds.set(input.gatewayPaymentId, [...(this.refunds.get(input.gatewayPaymentId) ?? []), r]);
    return r;
  }

  async listRefunds(gatewayPaymentId: string): Promise<GatewayRefundInfo[]> {
    this.maybeFail();
    return [...(this.refunds.get(gatewayPaymentId) ?? [])];
  }

  verifyCheckoutSignature(gatewayOrderId: string, gatewayPaymentId: string, signature: string): boolean {
    return safeEqualHex(hmacHex(this.keySecret, `${gatewayOrderId}|${gatewayPaymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return safeEqualHex(hmacHex(this.webhookSecret, rawBody), signature);
  }

  parseWebhook(body: unknown): WebhookEvent {
    return parseRazorpayWebhook(body);
  }

  // ---- simulation helpers (tests / local dev) ----

  /** The customer pays. Returns what the checkout widget and the webhook would deliver. */
  simulateCustomerPayment(gatewayOrderId: string, opts: { amountPaise?: number; succeed?: boolean } = {}) {
    const order = this.orders.get(gatewayOrderId);
    if (!order) throw new Error('unknown gateway order');
    const payment: GatewayPaymentInfo = {
      gatewayPaymentId: rid('pay'),
      amountPaise: opts.amountPaise ?? order.amountPaise,
      currency: 'INR',
      status: opts.succeed === false ? 'failed' : 'captured',
    };
    order.payments.push(payment);
    const event = payment.status === 'captured' ? 'payment.captured' : 'payment.failed';
    const webhook = this.signedWebhook(event, {
      payment: {
        entity: {
          id: payment.gatewayPaymentId,
          order_id: gatewayOrderId,
          amount: payment.amountPaise,
          currency: 'INR',
          status: payment.status,
          error_description: payment.status === 'failed' ? 'Payment declined by bank' : null,
        },
      },
    });
    const checkoutSignature = hmacHex(this.keySecret, `${gatewayOrderId}|${payment.gatewayPaymentId}`);
    return { payment, webhook, checkoutSignature };
  }

  /** Builds a webhook exactly as Razorpay would: raw JSON body + HMAC signature + event id. */
  signedWebhook(event: string, payload: unknown) {
    const body = JSON.stringify({ entity: 'event', event, payload, created_at: Math.floor(Date.now() / 1000) });
    return { body, signature: hmacHex(this.webhookSecret, body), eventId: rid('evt') };
  }
}
