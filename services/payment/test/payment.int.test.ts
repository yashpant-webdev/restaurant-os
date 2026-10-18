import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { EventEnvelope } from '@ros/contracts';
import { Database, InMemoryEventBus, OutboxRelay } from '@ros/common';
import { call, freshServiceDb, log, newBus, relay as makeRelay, startApp, token, verifier, waitFor } from '../../../tests/support/harness';
import { PaymentModule } from '../src/app.module';
import { FakeGateway } from '../src/gateway/fake';
import { PaymentsService } from '../src/payments.service';

const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const OUTLET = randomUUID();

let app: INestApplication;
let url: string;
let appDb: Database;
let workerDb: Database;
let bus: InMemoryEventBus;
let relay: OutboxRelay;
let gateway: FakeGateway;
let events: EventEnvelope[];
let svcToken: string;
let managerToken: string;
let cashierToken: string;

beforeAll(async () => {
  ({ appDb, workerDb } = await freshServiceDb('payment'));
  bus = newBus();
  events = [];
  for (const t of ['payment.captured', 'payment.failed', 'payment.cancelled', 'payment.refunded']) {
    await bus.subscribe(t, 'test', async (e) => void events.push(e));
  }
  relay = makeRelay(workerDb, bus);
  relay.start();
  gateway = new FakeGateway('key-secret', 'webhook-secret');
  ({ app, url } = await startApp(
    PaymentModule.register({ log, appDb, workerDb, gateway, relay, verifier: verifier(), reconciler: { intervalMs: 0, pendingTimeoutMs: 60_000 }, rateLimitPerMinute: 10_000 }),
  ));
  svcToken = await token({ tid: TENANT, roles: ['service'], sub: 'svc:order-pos' });
  managerToken = await token({ tid: TENANT, roles: ['manager'] });
  cashierToken = await token({ tid: TENANT, roles: ['cashier'] });
});

afterAll(async () => {
  await app.close();
  await relay.stop();
  await appDb.close();
  await workerDb.close();
});

const newPayment = (over: Partial<{ method: string; amountPaise: number }> = {}) => ({
  id: randomUUID(),
  orderId: randomUUID(),
  outletId: OUTLET,
  method: 'CASH',
  amountPaise: 105_000,
  ...over,
});

async function eventsFor(paymentId: string, type: string, count = 1) {
  await waitFor(async () => events.filter((e) => e.key === paymentId && e.type === type).length >= count);
  return events.filter((e) => e.key === paymentId && e.type === type);
}

async function sendWebhook(w: { body: string; signature: string; eventId: string }) {
  return call(url, 'POST', '/webhooks/razorpay', { raw: w.body, headers: { 'x-razorpay-signature': w.signature, 'x-razorpay-event-id': w.eventId } });
}

describe('security', () => {
  it('rejects requests without a token, and with a forged or expired one', async () => {
    expect((await call(url, 'GET', `/payments/${randomUUID()}`)).status).toBe(401);
    expect((await call(url, 'GET', `/payments/${randomUUID()}`, { token: svcToken.slice(0, -4) + 'abcd' })).status).toBe(401);
    const expired = await token({ tid: TENANT, roles: ['manager'], expiresIn: '-1h' });
    expect((await call(url, 'GET', `/payments/${randomUUID()}`, { token: expired })).status).toBe(401);
  });

  it('only the order service may create payments', async () => {
    const res = await call(url, 'POST', '/payments', { token: cashierToken, body: newPayment() });
    expect(res.status).toBe(403);
  });

  it('isolates tenants at the database level (RLS)', async () => {
    const p = newPayment();
    expect((await call(url, 'POST', '/payments', { token: svcToken, body: p })).status).toBe(201);
    const otherTenant = await token({ tid: OTHER_TENANT, roles: ['owner'] });
    expect((await call(url, 'GET', `/payments/${p.id}`, { token: otherTenant })).status).toBe(404);
    // Even a raw query from the API role sees nothing without a tenant set.
    expect(await appDb.query('SELECT * FROM payments')).toHaveLength(0);
  });

  it('enforces outlet access', async () => {
    const p = newPayment();
    await call(url, 'POST', '/payments', { token: svcToken, body: p });
    const otherOutletUser = await token({ tid: TENANT, roles: ['manager'], outlets: [randomUUID()] });
    expect((await call(url, 'GET', `/payments/${p.id}`, { token: otherOutletUser })).status).toBe(403);
  });

  it('rejects unknown fields, malformed JSON and oversized bodies without crashing', async () => {
    expect((await call(url, 'POST', '/payments', { token: svcToken, body: { ...newPayment(), amountPaise: 10.5 } })).status).toBe(400);
    expect((await call(url, 'POST', '/payments', { token: svcToken, body: { ...newPayment(), hack: true } })).status).toBe(400);
    expect((await call(url, 'POST', '/payments', { token: svcToken, raw: '{"id": ' })).status).toBe(400);
    expect((await call(url, 'POST', '/payments', { token: svcToken, raw: JSON.stringify({ x: 'a'.repeat(200_000) }) })).status).toBe(413);
    expect((await call(url, 'GET', '/health/ready')).status).toBe(200);
  });

  it('audit trail cannot be modified, even by the worker role', async () => {
    await expect(workerDb.query(`UPDATE payment_audit SET actor = 'x'`)).rejects.toThrow(/append-only|permission denied/);
    await expect(workerDb.query(`DELETE FROM payments`)).rejects.toThrow(/permission denied/);
  });
});

describe('cash payments', () => {
  it('captures immediately, is idempotent on retry, and emits exactly one event', async () => {
    const p = newPayment();
    const first = await call(url, 'POST', '/payments', { token: svcToken, body: p });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'CAPTURED', capturedPaise: 105_000, refundablePaise: 105_000 });

    const replay = await call(url, 'POST', '/payments', { token: svcToken, body: p });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(p.id);

    const conflict = await call(url, 'POST', '/payments', { token: svcToken, body: { ...p, amountPaise: 1 } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_MISMATCH');

    await eventsFor(p.id, 'payment.captured');
    await bus.waitForIdle();
    expect(events.filter((e) => e.key === p.id)).toHaveLength(1);
  });

  it('survives 10 identical concurrent requests with a single payment', async () => {
    const p = newPayment();
    const results = await Promise.all(Array.from({ length: 10 }, () => call(url, 'POST', '/payments', { token: svcToken, body: p })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    await eventsFor(p.id, 'payment.captured');
    await bus.waitForIdle();
    expect(events.filter((e) => e.key === p.id)).toHaveLength(1);
  });
});

describe('UPI / gateway payments', () => {
  it('creates a gateway order, then a signed webhook captures it exactly once', async () => {
    const p = newPayment({ method: 'UPI' });
    const created = await call(url, 'POST', '/payments', { token: svcToken, body: p });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING');
    expect(created.body.checkout).toMatchObject({ gatewayOrderId: expect.stringMatching(/^order_/), amountPaise: 105_000, keyId: 'rzp_test_fake' });

    const { webhook } = gateway.simulateCustomerPayment(created.body.checkout.gatewayOrderId);
    expect((await sendWebhook({ ...webhook, signature: 'deadbeef' })).status).toBe(400);
    expect((await sendWebhook(webhook)).body).toEqual({ status: 'accepted' });
    expect((await sendWebhook(webhook)).body).toEqual({ status: 'duplicate' });

    const after = await call(url, 'GET', `/payments/${p.id}`, { token: cashierToken });
    expect(after.body).toMatchObject({ status: 'CAPTURED', capturedPaise: 105_000, checkout: null });
    const captured = await eventsFor(p.id, 'payment.captured');
    await bus.waitForIdle();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.payload).toMatchObject({ lateCapture: false, stateVersion: 2 });
  });

  it('flags (and does not capture) when the gateway amount differs', async () => {
    const p = newPayment({ method: 'UPI' });
    const created = await call(url, 'POST', '/payments', { token: svcToken, body: p });
    const { webhook } = gateway.simulateCustomerPayment(created.body.checkout.gatewayOrderId, { amountPaise: 100 });
    await sendWebhook(webhook);
    const after = await call(url, 'GET', `/payments/${p.id}`, { token: cashierToken });
    expect(after.body).toMatchObject({ status: 'PENDING', flag: 'AMOUNT_MISMATCH' });
  });

  it('returns 503 when the gateway is down, and a retry with the same id recovers', async () => {
    const p = newPayment({ method: 'UPI' });
    gateway.failNextCalls = 1;
    const down = await call(url, 'POST', '/payments', { token: svcToken, body: p });
    expect(down.status).toBe(503);
    const retry = await call(url, 'POST', '/payments', { token: svcToken, body: p });
    expect(retry.status).toBe(200);
    expect(retry.body.checkout.gatewayOrderId).toMatch(/^order_/);
  });

  it('verifies the checkout signature and takes the amount from the gateway, not the client', async () => {
    const p = newPayment({ method: 'CARD' });
    const created = await call(url, 'POST', '/payments', { token: svcToken, body: p });
    const gatewayOrderId = created.body.checkout.gatewayOrderId;
    const { payment, checkoutSignature } = gateway.simulateCustomerPayment(gatewayOrderId);
    const forged = await call(url, 'POST', `/payments/${p.id}/verify`, {
      token: cashierToken,
      body: { gatewayOrderId, gatewayPaymentId: payment.gatewayPaymentId, signature: '00'.repeat(32) },
    });
    expect(forged.status).toBe(400);
    const ok = await call(url, 'POST', `/payments/${p.id}/verify`, {
      token: cashierToken,
      body: { gatewayOrderId, gatewayPaymentId: payment.gatewayPaymentId, signature: checkoutSignature },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('CAPTURED');
  });

  it('reconciler captures a payment whose webhook was lost', async () => {
    const p = newPayment({ method: 'UPI' });
    const created = await call(url, 'POST', '/payments', { token: svcToken, body: p });
    gateway.simulateCustomerPayment(created.body.checkout.gatewayOrderId); // webhook never delivered
    await app.get(PaymentsService).syncFromGateway(p.id, 'test');
    expect((await call(url, 'GET', `/payments/${p.id}`, { token: cashierToken })).body.status).toBe('CAPTURED');
  });

  it('reconciler expires a pending payment nobody paid', async () => {
    const p = newPayment({ method: 'UPI' });
    await call(url, 'POST', '/payments', { token: svcToken, body: p });
    await app.get(PaymentsService).syncFromGateway(p.id, 'test', { expireBefore: new Date(Date.now() + 1000) });
    const after = await call(url, 'GET', `/payments/${p.id}`, { token: cashierToken });
    expect(after.body).toMatchObject({ status: 'FAILED', failureReason: 'EXPIRED' });
    await eventsFor(p.id, 'payment.failed');
  });

  it('cancel checks the gateway first; money that arrives later is still recorded (late capture)', async () => {
    const p = newPayment({ method: 'UPI' });
    const created = await call(url, 'POST', '/payments', { token: svcToken, body: p });
    const cancelled = await call(url, 'POST', `/payments/${p.id}/cancel`, { token: cashierToken });
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await call(url, 'POST', `/payments/${p.id}/cancel`, { token: cashierToken })).status).toBe(200); // idempotent

    const { webhook } = gateway.simulateCustomerPayment(created.body.checkout.gatewayOrderId);
    await sendWebhook(webhook);
    const after = await call(url, 'GET', `/payments/${p.id}`, { token: cashierToken });
    expect(after.body.status).toBe('CAPTURED');
    const [evt] = await eventsFor(p.id, 'payment.captured');
    expect(evt!.payload).toMatchObject({ lateCapture: true });
  });
});

describe('refunds', () => {
  async function capturedUpi(amountPaise = 100_000) {
    const p = newPayment({ method: 'UPI', amountPaise });
    const created = await call(url, 'POST', '/payments', { token: svcToken, body: p });
    await sendWebhook(gateway.simulateCustomerPayment(created.body.checkout.gatewayOrderId).webhook);
    return p.id;
  }
  const refund = (id: string, amountPaise: number, key = randomUUID(), tok = managerToken) =>
    call(url, 'POST', `/payments/${id}/refunds`, { token: tok, body: { amountPaise, reason: 'cold food' }, headers: { 'idempotency-key': key } });

  it('requires a manager and an idempotency key', async () => {
    const id = await capturedUpi();
    expect((await refund(id, 100, randomUUID(), cashierToken)).status).toBe(403);
    const noKey = await call(url, 'POST', `/payments/${id}/refunds`, { token: managerToken, body: { amountPaise: 100, reason: 'cold food' } });
    expect(noKey.status).toBe(400);
  });

  it('refunds partially, replays safely, and never exceeds the captured amount under concurrency', async () => {
    const id = await capturedUpi(100_000);
    const key = randomUUID();
    const r1 = await refund(id, 30_000, key);
    expect(r1.status).toBe(201);
    expect(r1.body.status).toBe('SUCCEEDED');
    const replay = await refund(id, 30_000, key);
    expect(replay.body.id).toBe(r1.body.id);

    // 70,000 left. Two concurrent 40,000 refunds: exactly one may succeed.
    const [a, b] = await Promise.all([refund(id, 40_000), refund(id, 40_000)]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);

    const after = await call(url, 'GET', `/payments/${id}`, { token: managerToken });
    expect(after.body).toMatchObject({ refundedPaise: 70_000, refundablePaise: 30_000 });
    expect((await refund(id, 30_001)).body.error.code).toBe('REFUND_EXCEEDS_CAPTURED');
    await eventsFor(id, 'payment.refunded', 2);
  });

  it('a refund whose outcome is unknown stays pending, then the reconciler resolves it', async () => {
    const id = await capturedUpi();
    gateway.failNextCalls = 1; // gateway times out on the refund call
    const r = await refund(id, 5_000);
    expect(r.body.status).toBe('PENDING');
    expect((await call(url, 'GET', `/payments/${id}`, { token: managerToken })).body.refundablePaise).toBe(95_000); // amount stays reserved

    await app.get(PaymentsService).syncRefund(r.body.id, 'test'); // gateway never got it: released
    const after = await call(url, 'GET', `/payments/${id}`, { token: managerToken });
    expect(after.body).toMatchObject({ refundedPaise: 0, refundablePaise: 100_000 });
  });

  it('pending gateway refund completes via signed webhook', async () => {
    const id = await capturedUpi();
    gateway.refundMode = 'pending';
    const r = await refund(id, 10_000);
    gateway.refundMode = 'processed';
    expect(r.body.status).toBe('PENDING');
    const [remote] = await gateway.listRefunds((await workerDb.query('SELECT gateway_payment_id FROM payments WHERE id = $1', [id]))[0]!.gateway_payment_id);
    const w = gateway.signedWebhook('refund.processed', { refund: { entity: { id: remote!.gatewayRefundId, amount: 10_000, status: 'processed', notes: { refund_id: r.body.id } } } });
    await sendWebhook(w);
    expect((await call(url, 'GET', `/payments/${id}`, { token: managerToken })).body.refundedPaise).toBe(10_000);
  });
});
