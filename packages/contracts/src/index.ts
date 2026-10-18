import { z } from 'zod';

/**
 * Event contracts shared by every service. Producers and consumers both
 * validate against these schemas, so a malformed event is rejected at the
 * edge instead of crashing a consumer deep inside business logic.
 *
 * Rule: never change a field's meaning. Add a new optional field, or bump
 * `version` and publish both until all consumers have migrated.
 */

export const Paise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const EventEnvelope = z.object({
  eventId: z.string().uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  tenantId: z.string().uuid(),
  /** Partition key: all events for one aggregate go to one partition, in order. */
  key: z.string().min(1),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export const PaymentMethod = z.enum(['CASH', 'UPI', 'CARD', 'WALLET', 'PAYMENT_LINK']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const PaymentStatus = z.enum(['PENDING', 'CAPTURED', 'FAILED', 'CANCELLED']);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

/**
 * Every payment event carries the full current snapshot plus a monotonically
 * increasing `stateVersion`. Consumers apply a snapshot only if its version is
 * newer than what they hold, so duplicates and out-of-order delivery are safe.
 */
export const PaymentSnapshot = z.object({
  paymentId: z.string().uuid(),
  orderId: z.string().uuid(),
  outletId: z.string().uuid(),
  method: PaymentMethod,
  status: PaymentStatus,
  amountPaise: Paise,
  capturedPaise: Paise,
  refundedPaise: Paise,
  stateVersion: z.number().int().positive(),
});
export type PaymentSnapshot = z.infer<typeof PaymentSnapshot>;

export const PaymentCaptured = PaymentSnapshot.extend({ lateCapture: z.boolean() });
export const PaymentFailed = PaymentSnapshot.extend({ reason: z.string() });
export const PaymentCancelled = PaymentSnapshot;
export const PaymentRefunded = PaymentSnapshot.extend({
  refundId: z.string().uuid(),
  refundPaise: Paise,
});

export const OrderSettled = z.object({
  orderId: z.string().uuid(),
  outletId: z.string().uuid(),
  invoiceNo: z.string(),
  subtotalPaise: Paise,
  cgstPaise: Paise,
  sgstPaise: Paise,
  roundOffPaise: z.number().int(),
  totalPaise: Paise,
  paidPaise: Paise,
  payments: z.array(z.object({ paymentId: z.string().uuid(), method: PaymentMethod, netPaise: Paise })),
  settledAt: z.string().datetime(),
});

export const OrderOverpaid = z.object({
  orderId: z.string().uuid(),
  outletId: z.string().uuid(),
  totalPaise: Paise,
  paidPaise: Paise,
  excessPaise: Paise,
});

export const Topics = {
  PaymentCaptured: 'payment.captured',
  PaymentFailed: 'payment.failed',
  PaymentCancelled: 'payment.cancelled',
  PaymentRefunded: 'payment.refunded',
  OrderSettled: 'pos.order.settled',
  OrderOverpaid: 'pos.order.overpaid',
} as const;

export const EventSchemas = {
  [Topics.PaymentCaptured]: PaymentCaptured,
  [Topics.PaymentFailed]: PaymentFailed,
  [Topics.PaymentCancelled]: PaymentCancelled,
  [Topics.PaymentRefunded]: PaymentRefunded,
  [Topics.OrderSettled]: OrderSettled,
  [Topics.OrderOverpaid]: OrderOverpaid,
} as const;
export type Topic = keyof typeof EventSchemas;
export type EventPayload<T extends Topic> = z.infer<(typeof EventSchemas)[T]>;
