import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { EventPayload, Topic } from '@ros/contracts';
import { Database, InMemoryEventBus } from '@ros/common';
import { call, freshServiceDb, log, newBus, startApp, token, verifier } from '../../../tests/support/harness';
import { AnalyticsModule } from '../src/app.module';
import { registerProjections } from '../src/projections';

const TENANT = randomUUID();
const OUTLET = randomUUID();
const BIRYANI = randomUUID();
const LASSI = randomUUID();
const ORDER_A = randomUUID();
const ORDER_B = randomUUID();
const PAY_A = randomUUID();

let app: INestApplication;
let url: string;
let appDb: Database;
let workerDb: Database;
let bus: InMemoryEventBus;
let owner: string;

async function publish<T extends Topic>(topic: T, payload: EventPayload<T>, eventId = randomUUID(), occurredAt = new Date().toISOString()) {
  await bus.publish(topic, { eventId, type: topic, version: 1, occurredAt, tenantId: TENANT, key: randomUUID(), payload });
}

const customer = { phone: '9876543210', name: 'Priya', marketingConsent: true };
const orderA: EventPayload<'pos.order.settled'> = {
  orderId: ORDER_A, outletId: OUTLET, invoiceNo: '2627/000001',
  subtotalPaise: 68_750, cgstPaise: 1_719, sgstPaise: 1_719, roundOffPaise: 12, totalPaise: 72_200, paidPaise: 72_200,
  payments: [{ paymentId: PAY_A, method: 'CASH', netPaise: 72_200 }],
  settledAt: '2026-10-10T08:00:00.000Z', openedAt: '2026-10-10T07:00:00.000Z', channel: 'DINE_IN', tableRef: 'T3', guests: 2, createdBy: 'ravi', customer,
  lines: [
    { itemId: BIRYANI, name: 'Chicken Biryani', quantity: 2, gstRateBp: 500, netPaise: 59_800, taxPaise: 2_990, costPaise: 18_000 },
    { itemId: LASSI, name: 'Sweet Lassi', quantity: 1, gstRateBp: 500, netPaise: 8_950, taxPaise: 448, costPaise: 2_500 },
  ],
};
const orderB: EventPayload<'pos.order.settled'> = {
  orderId: ORDER_B, outletId: OUTLET, invoiceNo: '2627/000002',
  subtotalPaise: 29_900, cgstPaise: 747, sgstPaise: 748, roundOffPaise: 5, totalPaise: 31_400, paidPaise: 31_400,
  payments: [{ paymentId: randomUUID(), method: 'UPI', netPaise: 31_400 }],
  settledAt: '2026-10-11T15:00:00.000Z', openedAt: '2026-10-11T14:10:00.000Z', channel: 'DINE_IN', tableRef: 'T1', guests: 1, createdBy: 'ravi', customer,
  lines: [{ itemId: BIRYANI, name: 'Chicken Biryani', quantity: 1, gstRateBp: 500, netPaise: 29_900, taxPaise: 1_495, costPaise: 9_000 }],
};
const RANGE = `outletId=${OUTLET}&from=2026-10-10&to=2026-10-11`;
const get = async (path: string, tok = owner) => call(url, 'GET', path, { token: tok });

beforeAll(async () => {
  ({ appDb, workerDb } = await freshServiceDb('analytics'));
  bus = newBus();
  await registerProjections(bus, appDb, log);
  ({ app, url } = await startApp(AnalyticsModule.register({ log, appDb, verifier: verifier(), rateLimitPerMinute: 10_000 })));
  owner = await token({ tid: TENANT, roles: ['owner'] });

  const dupId = randomUUID();
  await publish('pos.order.settled', orderA, dupId);
  await publish('pos.order.settled', orderA, dupId); // redelivered by the broker
  await publish('pos.order.settled', orderA); // re-imported with a new event id
  await publish('pos.order.settled', orderB);
  await publish(
    'payment.refunded',
    { paymentId: PAY_A, orderId: ORDER_A, outletId: OUTLET, method: 'CASH', status: 'CAPTURED', amountPaise: 72_200, capturedPaise: 72_200, refundedPaise: 8_950, stateVersion: 3, refundId: randomUUID(), refundPaise: 8_950 },
    randomUUID(),
    '2026-10-10T09:00:00.000Z',
  );
  await bus.waitForIdle();
  await call(url, 'POST', '/expenses', { token: owner, body: { outletId: OUTLET, businessDate: '2026-10-10', category: 'OTHER', amountPaise: 10_000 } });
  // Monthly rent of ₹310 for October (31 days): a 2-day range carries 2/31 of it = ₹20.
  await call(url, 'POST', '/expenses', { token: owner, body: { outletId: OUTLET, businessDate: '2026-10-01', category: 'RENT', amountPaise: 31_000, period: 'MONTHLY' } });
});

afterAll(async () => {
  await app.close();
  await appDb.close();
  await workerDb.close();
});

it('overview counts each sale once, even when events are duplicated', async () => {
  const { body } = await get(`/analytics/overview?${RANGE}`);
  expect(body.kpis).toMatchObject({
    bills: 2, netSalesPaise: 98_650, grossSalesPaise: 103_600, taxPaise: 4_933, guests: 3,
    avgBillPaise: 51_800, perCoverPaise: 32_883, refundsPaise: 8_950, avgTableMinutes: 55,
  });
  expect(body.daily).toEqual([
    { day: '2026-10-10', net: 68_750, bills: 1 },
    { day: '2026-10-11', net: 29_900, bills: 1 },
  ]);
  expect(body.paymentMix).toEqual(expect.arrayContaining([{ method: 'CASH', net: 72_200, count: 1 }, { method: 'UPI', net: 31_400, count: 1 }]));
  // 08:00Z = 13:30 IST Saturday (ISO day 6)
  expect(body.heatmap).toEqual(expect.arrayContaining([{ dow: 6, hour: 13, net: 68_750, bills: 1 }]));
});

it('menu engineering classifies items (Kasavana–Smith)', async () => {
  const { body } = await get(`/analytics/menu?${RANGE}`);
  expect(body.thresholds).toEqual({ popularityMixPct: 35, avgCmPerUnitPaise: 17_288 });
  expect(body.items).toEqual([
    expect.objectContaining({ name: 'Chicken Biryani', quantity: 3, cmPerUnitPaise: 20_900, foodCostPct: 30.1, class: 'STAR' }),
    expect.objectContaining({ name: 'Sweet Lassi', quantity: 1, cmPerUnitPaise: 6_450, class: 'DOG' }),
  ]);
});

it('P&L ties out: sales − refunds − food cost − expenses', async () => {
  const { body } = await get(`/analytics/pnl?${RANGE}`);
  expect(body.statement).toMatchObject({
    netSalesPaise: 98_650, refundsNetPaise: 8_522, roundOffPaise: 17, revenuePaise: 90_145,
    cogsPaise: 29_500, grossProfitPaise: 60_645, paymentFeesPaise: 0, expensesPaise: 12_000, operatingProfitPaise: 48_645,
  });
  expect(body.statement.expenses).toEqual([{ category: 'OTHER', amount: 10_000 }, { category: 'RENT', amount: 2_000 }]);
  expect(body.monthly).toEqual([{ month: '2026-10', from: '2026-10-10', to: '2026-10-11', net: 98_650, cogs: 29_500, expenses: 12_000, profit: 48_645 }]); // same as operating profit
  expect(body.ratios).toMatchObject({ foodCostPct: 29.9, costCoveragePct: 100 });
  expect(body.gst).toMatchObject({ outputCgstPaise: 2_466, outputSgstPaise: 2_467, byRate: [{ rateBp: 500, taxablePaise: 98_650, taxPaise: 4_933 }] });
});

it('CRM: recognises the repeat guest and masks the phone number', async () => {
  const { body } = await get(`/analytics/customers?${RANGE}`);
  expect(body.summary).toMatchObject({ customers: 1, consented: 1, newInRange: 1, identifiedBillPct: 100, repeatBillPct: 50 });
  expect(body.top[0]).toMatchObject({ phone: '••••••3210', name: 'Priya', visits: 2, spend: 103_600 });
  expect(JSON.stringify(body)).not.toContain('9876543210');
});

it('alerts: refunds show up for the owner', async () => {
  const { body } = await get(`/analytics/alerts?${RANGE}`);
  expect(body.items).toEqual([expect.objectContaining({ kind: 'REFUND', severity: 'info', amount_paise: 8_950 })]);
  expect(body.refundRatePct).toBe(8.64);
});

it('financials are owner-only and tenant-isolated', async () => {
  const cashier = await token({ tid: TENANT, roles: ['cashier'] });
  expect((await get(`/analytics/pnl?${RANGE}`, cashier)).status).toBe(403);
  const manager = await token({ tid: TENANT, roles: ['manager'] });
  expect((await get(`/analytics/pnl?${RANGE}`, manager)).status).toBe(403);
  expect((await get(`/analytics/overview?${RANGE}`, manager)).status).toBe(200);
  const other = await token({ tid: randomUUID(), roles: ['owner'] });
  expect((await get(`/analytics/overview?${RANGE}`, other)).body.kpis.bills).toBe(0);
  expect((await get(`/analytics/overview?outletId=${OUTLET}&from=2026-10-11&to=2026-10-01`)).status).toBe(400);
});
