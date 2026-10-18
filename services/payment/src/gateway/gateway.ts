/**
 * Payment gateway port. Business logic depends only on this interface, so the
 * gateway (Razorpay today, Cashfree/PhonePe tomorrow) can be swapped, and tests
 * run against a faithful fake instead of the real network.
 */
export interface GatewayOrder {
  gatewayOrderId: string;
}

export interface GatewayPaymentInfo {
  gatewayPaymentId: string;
  amountPaise: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
}

export type GatewayRefundStatus = 'pending' | 'processed' | 'failed';

export interface GatewayRefundInfo {
  gatewayRefundId: string;
  status: GatewayRefundStatus;
  amountPaise: number;
  refundId?: string; // our id, echoed back from notes
}

/** Normalised webhook event, independent of the gateway's wire format. */
export type WebhookEvent =
  | { kind: 'payment.captured'; gatewayOrderId: string; gatewayPaymentId: string; amountPaise: number; currency: string }
  | { kind: 'payment.failed'; gatewayOrderId: string; gatewayPaymentId: string; reason: string }
  | { kind: 'refund.processed' | 'refund.failed'; gatewayRefundId: string; refundId?: string; amountPaise: number }
  | { kind: 'ignored'; type: string };

export interface PaymentGateway {
  readonly name: 'razorpay' | 'fake';
  /** Public key for the client checkout widget. Never the secret. */
  readonly publicKeyId: string;
  createOrder(input: { paymentId: string; amountPaise: number; notes: Record<string, string> }): Promise<GatewayOrder>;
  listOrderPayments(gatewayOrderId: string): Promise<GatewayPaymentInfo[]>;
  refund(input: { gatewayPaymentId: string; amountPaise: number; refundId: string }): Promise<GatewayRefundInfo>;
  listRefunds(gatewayPaymentId: string): Promise<GatewayRefundInfo[]>;
  verifyCheckoutSignature(gatewayOrderId: string, gatewayPaymentId: string, signature: string): boolean;
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
  parseWebhook(body: unknown): WebhookEvent;
}

/** The gateway rejected the request outright (bad input, payment not refundable...). Not retryable. */
export class GatewayRejectedError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
  }
}
