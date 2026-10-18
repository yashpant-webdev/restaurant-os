import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { EventEnvelope } from '@ros/contracts';
import { Database, InMemoryEventBus, OutboxRelay } from '@ros/common';
import { call, freshServiceDb, JWT, log, newBus, relay as makeRelay, startApp, token, verifier, waitFor } from '../support/harness';
import { PaymentModule } from '../../services/payment/src/app.module';
import { FakeGateway } from '../../services/payment/src/gateway/fake';
import { OrderModule, registerPaymentConsumers } from '../../services/order-pos/src/app.module';
import { OrdersService } from '../../services/order-pos/src/orders.service';
import { DevServiceTokenProvider, PaymentClient } from '../../services/order-pos/src/payment-client';

/**
 * Both services run for real (HTTP, separate databases with RLS, outbox →
 * bus → inbox). Only the event transport (in-memory instead of Kafka) and the
 * gateway (fake Razorpay) are substituted.
 */
const TENANT = randomUUID();
const OUTLET = randomUUID();

let bus: InMemoryEventBus;
let gateway: FakeGateway;
let pay: { app: INestApplication; url: string; appDb: Database; workerDb: Database; relay: OutboxRelay };
let ord: { app: INestApplication; url: string; appDb: Database; workerDb: Database; relay: OutboxRelay };
let settled: EventEnvelope[];
let overpaid: EventEnvelope[];
let kots: EventEnvelope[] = [];
let owner: string;
let cashier: string;
let biryani: string;
let lassi: string;

beforeAll(async () => {
  bus = newBus();
  settled = [];
  overpaid = [];
  await bus.subscribe('pos.order.settled', 'finance-test', async (e) => void settled.push(e));
  await bus.subscribe('pos.order.overpaid', 'alerts-test', async (e) => void overpaid.push(e));
  await bus.subscribe('pos.kot.created', 'kitchen-test', async (e) => void kots.push(e));
  gateway = new FakeGateway('key-secret', 'webhook-secret');

  const pdb = await freshServiceDb('payment');
  const prelay = makeRelay(pdb.workerDb, bus);
  const papp = await startApp(
    PaymentModule.register({ log, ...pdb, gateway, relay: prelay, verifier: verifier(), reconciler: { intervalMs: 0, pendingTimeoutMs: 60_000 }, rateLimitPerMinute: 10_000 }),
  );
  pay = { ...papp, ...pdb, relay: prelay };

  const odb = await freshServiceDb('order');
  const orelay = makeRelay(odb.workerDb, bus);
  const payments = new PaymentClient(pay.url, new DevServiceTokenProvider(JWT), log);
  const oapp = await startApp(OrderModule.register({ log, appDb: odb.appDb, relay: orelay, payments, verifier: verifier(), rateLimitPerMinute: 10_000 }));
  await registerPaymentConsumers(bus, odb.appDb, log, oapp.app.get(OrdersService));
  ord = { ...oapp, ...odb, relay: orelay };

  prelay.start();
  orelay.start();

  owner = await token({ tid: TENANT, roles: ['owner'] });
  cashier = await token({ tid: TENANT, roles: ['cashier'], outlets: [OUTLET] });
  biryani = (await call(ord.url, 'POST', '/menu-items', { token: owner, body: { outletId: OUTLET, name: 'Chicken Biryani', pricePaise: 29_900, gstRateBp: 500 } })).body.id;
  lassi = (await call(ord.url, 'POST', '/menu-items', { token: owner, body: { outletId: OUTLET, name: 'Sweet Lassi', pricePaise: 8_950, gstRateBp: 500 } })).body.id;
});

afterAll(async () => {
  for (const s of [ord, pay].filter(Boolean)) {
    await s.app.close();
    await s.relay.stop();
    await s.appDb.close();
    await s.workerDb.close();
  }
});

let tableSeq = 0;
async function newOrder() {
  const id = randomUUID();
  const res = await call(ord.url, 'POST', '/orders', {
    token: cashier,
    body: { id, outletId: OUTLET, channel: 'DINE_IN', tableRef: `X${++tableSeq}`, lines: [{ itemId: biryani, quantity: 2 }, { itemId: lassi, quantity: 1 }] },
  });
  expect(res.status).toBe(201);
  return res.body;
}

const getOrder = async (id: string) => (await call(ord.url, 'GET', `/orders/${id}`, { token: cashier })).body;
const checkout = (orderId: string, body: object, key = randomUUID()) =>
  call(ord.url, 'POST', `/orders/${orderId}/payments`, { token: cashier, body, headers: { 'idempotency-key': key } });
const webhook = (w: { body: string; signature: string; eventId: string }) =>
  call(pay.url, 'POST', '/webhooks/razorpay', { raw: w.body, headers: { 'x-razorpay-signature': w.signature, 'x-razorpay-event-id': w.eventId } });

it('computes GST and round-off on the server', async () => {
  const o = await newOrder();
  // 2 × 299.00 + 89.50 = 687.50; GST 5% = 34.38 (17.19 + 17.19); 721.88 → rounds to 722.00
  expect(o).toMatchObject({ subtotalPaise: 68_750, cgstPaise: 1_719, sgstPaise: 1_719, roundOffPaise: 12, totalPaise: 72_200, duePaise: 72_200, status: 'OPEN' });
  // Replaying the same offline order is harmless.
  const replay = await call(ord.url, 'POST', '/orders', {
    token: cashier,
    body: { id: o.id, outletId: OUTLET, channel: 'DINE_IN', tableRef: o.tableRef, lines: [{ itemId: biryani, quantity: 2 }, { itemId: lassi, quantity: 1 }] },
  });
  expect(replay.status).toBe(200);
});

it('split payment: cash + UPI settles the order, assigns an invoice number and emits one settlement event', async () => {
  const o = await newOrder();
  const cash = await checkout(o.id, { method: 'CASH', amountPaise: 22_200 });
  expect(cash.body.status).toBe('CAPTURED');

  const upi = await checkout(o.id, { method: 'UPI' }); // remaining 500.00
  expect(upi.body).toMatchObject({ status: 'PENDING', amountPaise: 50_000 });
  expect((await getOrder(o.id)).duePaise).toBe(0); // pending UPI reserves the balance

  // A second cashier can't collect the same balance while UPI is pending.
  expect((await checkout(o.id, { method: 'CASH' })).body.error.code).toBe('NOTHING_DUE');

  await webhook(gateway.simulateCustomerPayment(upi.body.checkout.gatewayOrderId).webhook);
  await waitFor(async () => (await getOrder(o.id)).status === 'SETTLED');

  const final = await getOrder(o.id);
  expect(final).toMatchObject({ paidPaise: 72_200, overpaidPaise: 0, invoiceNo: expect.stringMatching(/^\d{4}\/\d{6}$/) });
  await waitFor(async () => settled.some((e) => e.key === o.id));
  await bus.waitForIdle();
  expect(settled.filter((e) => e.key === o.id)).toHaveLength(1);
  expect(settled.find((e) => e.key === o.id)!.payload).toMatchObject({ totalPaise: 72_200, paidPaise: 72_200 });
});

it('rejects collecting more than is due', async () => {
  const o = await newOrder();
  const res = await checkout(o.id, { method: 'CASH', amountPaise: 72_201 });
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe('AMOUNT_EXCEEDS_DUE');
});

it('payment service outage: checkout returns 503 and the same Idempotency-Key retry succeeds without double charging', async () => {
  const o = await newOrder();
  const key = randomUUID();
  gateway.failNextCalls = 4; // outlasts the client's own 3 automatic retries
  const first = await checkout(o.id, { method: 'UPI' }, key);
  expect(first.status).toBe(503);
  gateway.failNextCalls = 0;
  const retry = await checkout(o.id, { method: 'UPI' }, key);
  expect(retry.status).toBe(201);
  expect(retry.body.checkout.gatewayOrderId).toMatch(/^order_/);
  const view = await getOrder(o.id);
  expect(view.payments).toHaveLength(1);
});

it('refund is reflected on the order (paid amount goes down, invoice stays)', async () => {
  const o = await newOrder();
  const cash = await checkout(o.id, { method: 'CASH' });
  await waitFor(async () => (await getOrder(o.id)).status === 'SETTLED');
  const r = await call(pay.url, 'POST', `/payments/${cash.body.paymentId}/refunds`, {
    token: owner,
    body: { amountPaise: 8_950, reason: 'lassi spilled' },
    headers: { 'idempotency-key': randomUUID() },
  });
  expect(r.body.status).toBe('SUCCEEDED');
  await waitFor(async () => (await getOrder(o.id)).paidPaise === 72_200 - 8_950);
  const after = await getOrder(o.id);
  expect(after.status).toBe('SETTLED');
  expect(after.payments[0]).toMatchObject({ capturedPaise: 72_200, refundedPaise: 8_950 });
});

it('cancelled UPI that the customer pays anyway is recorded and flagged as overpaid', async () => {
  const o = await newOrder();
  const upi = await checkout(o.id, { method: 'UPI' });
  const cancel = await call(ord.url, 'POST', `/orders/${o.id}/payments/${upi.body.paymentId}/cancel`, { token: cashier });
  expect(cancel.body.status).toBe('CANCELLED');
  await waitFor(async () => (await getOrder(o.id)).duePaise === 72_200);

  await checkout(o.id, { method: 'CASH' }); // customer pays cash instead
  await waitFor(async () => (await getOrder(o.id)).status === 'SETTLED');

  // ...but the UPI payment also went through.
  await webhook(gateway.simulateCustomerPayment(upi.body.checkout.gatewayOrderId).webhook);
  await waitFor(async () => (await getOrder(o.id)).overpaidPaise === 72_200);
  await waitFor(async () => overpaid.some((e) => e.key === o.id));
});

it('tenant isolation across the whole flow', async () => {
  const o = await newOrder();
  const intruder = await token({ tid: randomUUID(), roles: ['owner'] });
  expect((await call(ord.url, 'GET', `/orders/${o.id}`, { token: intruder })).status).toBe(404);
  expect((await call(ord.url, 'POST', `/orders/${o.id}/payments`, { token: intruder, body: { method: 'CASH' }, headers: { 'idempotency-key': randomUUID() } })).status).toBe(404);
});

describe('dine-in table flow: captain → kitchen → cashier', () => {
  let captain: string;
  const floor = async () => (await call(ord.url, 'GET', `/floor?outletId=${OUTLET}`, { token: cashier })).body;
  const table = async (label: string) => (await floor()).tables.find((t: { label: string }) => t.label === label);

  beforeAll(async () => {
    captain = await token({ tid: TENANT, roles: ['captain'], outlets: [OUTLET], sub: 'captain-ravi' });
    for (const [label, seats] of [['T1', 2], ['T2', 4], ['T3', 6]] as const) {
      expect((await call(ord.url, 'POST', '/tables', { token: owner, body: { outletId: OUTLET, label, seats } })).status).toBe(201);
    }
    expect((await call(ord.url, 'POST', '/tables', { token: owner, body: { outletId: OUTLET, label: 'T1', seats: 2 } })).status).toBe(409);
    expect((await call(ord.url, 'POST', '/tables', { token: captain, body: { outletId: OUTLET, label: 'T9', seats: 2 } })).status).toBe(403);
  });

  it('runs a full table lifecycle', async () => {
    expect((await table('T1')).status).toBe('FREE');

    // Captain opens T1 for 2 guests: KOT #1 goes to the kitchen.
    const orderId = randomUUID();
    const open = await call(ord.url, 'POST', '/orders', {
      token: captain,
      body: { id: orderId, outletId: OUTLET, channel: 'DINE_IN', tableRef: 'T1', guests: 2, lines: [{ itemId: biryani, quantity: 2 }] },
    });
    expect(open.status).toBe(201);
    let t1 = await table('T1');
    expect(t1).toMatchObject({ status: 'OCCUPIED', order: { id: orderId, guests: 2, totalPaise: 62_800, kotCount: 1, items: [{ name: 'Chicken Biryani', quantity: 2 }] } });

    // A second captain can't open the same table.
    const clash = await call(ord.url, 'POST', '/orders', {
      token: captain,
      body: { id: randomUUID(), outletId: OUTLET, channel: 'DINE_IN', tableRef: 'T1', lines: [{ itemId: lassi, quantity: 1 }] },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toMatchObject({ code: 'TABLE_OCCUPIED', details: { orderId } });

    // Second round: KOT #2. Resending it (flaky Wi-Fi) adds nothing.
    const kotId = randomUUID();
    const round2 = { kotId, lines: [{ itemId: lassi, quantity: 2 }] };
    expect((await call(ord.url, 'POST', `/orders/${orderId}/items`, { token: captain, body: round2 })).body.kotCount).toBe(2);
    const resend = await call(ord.url, 'POST', `/orders/${orderId}/items`, { token: captain, body: round2 });
    expect(resend.body).toMatchObject({ kotCount: 2, subtotalPaise: 59_800 + 17_900, totalPaise: 81_600 });
    expect(resend.body.lines).toHaveLength(2);

    // Kitchen sees both tickets, as events and on its screen.
    await waitFor(async () => kots.filter((e) => e.key === orderId).length === 2);
    const kds = (await call(ord.url, 'GET', `/kots?outletId=${OUTLET}`, { token: cashier })).body;
    expect(kds.filter((k: { orderId: string }) => k.orderId === orderId).map((k: { kotNo: number }) => k.kotNo).sort()).toEqual([1, 2]);

    // Captain asks for the bill.
    await call(ord.url, 'POST', `/orders/${orderId}/request-bill`, { token: captain });
    expect((await table('T1')).status).toBe('BILL_REQUESTED');

    // Cashier starts UPI; the bill is now locked.
    const upi = await checkout(orderId, { method: 'UPI' });
    expect((await table('T1')).status).toBe('PAYING');
    const late = await call(ord.url, 'POST', `/orders/${orderId}/items`, { token: captain, body: { kotId: randomUUID(), lines: [{ itemId: lassi, quantity: 1 }] } });
    expect(late.body.error.code).toBe('BILL_LOCKED');

    // Customer pays: the order settles and the table is free again.
    const before = (await floor()).summary.settledTodayCount;
    await webhook(gateway.simulateCustomerPayment(upi.body.checkout.gatewayOrderId).webhook);
    await waitFor(async () => (await table('T1')).status === 'FREE');
    const after = await floor();
    expect(after.summary.settledTodayCount).toBe(before + 1);
    expect((await getOrder(orderId)).invoiceNo).toMatch(/^\d{4}\/\d{6}$/);

    // The table can be opened again for the next guests.
    t1 = await call(ord.url, 'POST', '/orders', {
      token: captain,
      body: { id: randomUUID(), outletId: OUTLET, channel: 'DINE_IN', tableRef: 'T1', lines: [{ itemId: lassi, quantity: 1 }] },
    });
    expect(t1.status).toBe(201);
  });

  it('dine-in needs a table', async () => {
    const res = await call(ord.url, 'POST', '/orders', {
      token: captain,
      body: { id: randomUUID(), outletId: OUTLET, channel: 'DINE_IN', lines: [{ itemId: lassi, quantity: 1 }] },
    });
    expect(res.status).toBe(400);
  });
});

it('no event was dead-lettered during the run', async () => {
  await bus.waitForIdle();
  expect(await ord.workerDb.query('SELECT * FROM dead_letters')).toHaveLength(0);
});
