// Local demo: real PostgreSQL + payment service + order service + a POS web page.
// Run with `npm run demo`, then open http://localhost:4000
//
// Production differences: Kafka instead of the in-memory bus, real Razorpay
// instead of the fake gateway, Keycloak instead of demo tokens.
import EmbeddedPostgres from 'embedded-postgres';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('reflect-metadata');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const common = require(join(root, 'packages/common/dist/index.js'));
const { PaymentModule } = require(join(root, 'services/payment/dist/app.module.js'));
const { FakeGateway } = require(join(root, 'services/payment/dist/gateway/fake.js'));
const { OrderModule, registerLiveFeed, registerPaymentConsumers } = require(join(root, 'services/order-pos/dist/app.module.js'));
const { LiveHub } = require(join(root, 'services/order-pos/dist/live.js'));
const { OrdersService } = require(join(root, 'services/order-pos/dist/orders.service.js'));
const { DevServiceTokenProvider, PaymentClient } = require(join(root, 'services/order-pos/dist/payment-client.js'));
const { AnalyticsModule } = require(join(root, 'services/analytics/dist/app.module.js'));
const { registerProjections } = require(join(root, 'services/analytics/dist/projections.js'));
const { generateHistory } = await import('./history.mjs');

const PG_PORT = 54330;
const PORTS = { ui: 4000, order: 4001, payment: 4002, analytics: 4003 };
const JWT = { secret: 'demo-secret-for-local-use-only-at-least-32-chars', issuer: 'ros-demo', audience: 'ros-api' };
const TENANT = '01900000-0000-7000-8000-000000000001';
const OUTLET = '01900000-0000-7000-8000-0000000000a1';
const log = common.createLogger('demo', process.env.LOG_LEVEL ?? 'warn');

// Demo data is kept in .demo-data/ between runs. `npm run demo -- --fresh` starts over.
const DATA_DIR = join(root, '.demo-data', 'pg');
const FRESH = process.argv.includes('--fresh');
if (FRESH) rmSync(join(root, '.demo-data'), { recursive: true, force: true });
const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: 'postgres',
  password: 'postgres',
  port: PG_PORT,
  persistent: true,
  onLog: () => {},
});

async function serviceDb(svc, migrationsDir) {
  const admin = `postgres://postgres:postgres@localhost:${PG_PORT}/postgres`;
  await common.bootstrapServiceDatabase(admin, svc, { app: `${svc}-app-pw`, worker: `${svc}-worker-pw` });
  await common.runMigrations(`postgres://postgres:postgres@localhost:${PG_PORT}/${svc}_db`, migrationsDir, log);
  const url = (role, pw) => `postgres://${role}:${pw}@localhost:${PG_PORT}/${svc}_db`;
  return {
    appDb: new common.Database({ url: url(`${svc}_app`, `${svc}-app-pw`), applicationName: `${svc}-api`, logger: log }),
    workerDb: new common.Database({ url: url(`${svc}_worker`, `${svc}-worker-pw`), applicationName: `${svc}-worker`, logger: log }),
  };
}

const token = (roles, sub) =>
  common.signDevToken(JWT.secret, { sub, tid: TENANT, outlets: [OUTLET], roles }, { issuer: JWT.issuer, audience: JWT.audience, expiresIn: '12h' });

/** Resolves true if nothing is listening on the port yet. */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = createTcpServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
}

async function main() {
  const busy = [];
  for (const port of [PG_PORT, ...Object.values(PORTS)]) if (!(await portFree(port))) busy.push(port);
  if (busy.length) {
    console.error(`\nPort ${busy.join(', ')} already in use: another demo is probably still running.`);
    console.error('Stop it with Ctrl+C in the terminal where it runs, or find it with:');
    console.error(`  lsof -nP -iTCP:${busy[0]} -sTCP:LISTEN\n`);
    process.exit(1);
  }
  console.log('Starting PostgreSQL...');
  const firstRun = !existsSync(join(DATA_DIR, 'PG_VERSION'));
  if (firstRun) await pg.initialise();
  await pg.start();

  const bus = new common.InMemoryEventBus(log);
  const events = [];
  const topics = ['pos.kot.created', 'payment.captured', 'payment.failed', 'payment.cancelled', 'payment.refunded', 'pos.order.settled', 'pos.order.overpaid'];
  for (const t of topics) await bus.subscribe(t, 'demo-event-log', async (e) => void events.unshift({ ...e, receivedAt: new Date().toISOString() }));

  const verifier = new common.JwtVerifier({ mode: 'hs256', ...JWT });
  const cors = [`http://localhost:${PORTS.ui}`, `http://127.0.0.1:${PORTS.ui}`];

  console.log('Starting payment service...');
  const pdb = await serviceDb('payment', join(root, 'services/payment/migrations'));
  const gateway = new FakeGateway('demo-key-secret', 'demo-webhook-secret');
  const prelay = new common.OutboxRelay(pdb.workerDb, bus, log, { idleMs: 50 });
  const payApp = await common.createHttpApp(
    PaymentModule.register({ log, ...pdb, gateway, relay: prelay, verifier, reconciler: { intervalMs: 15_000, pendingTimeoutMs: 30 * 60_000 }, rateLimitPerMinute: 1000 }),
    { log, corsOrigins: cors },
  );
  await payApp.listen(PORTS.payment);

  console.log('Starting order service...');
  const odb = await serviceDb('order', join(root, 'services/order-pos/migrations'));
  const orelay = new common.OutboxRelay(odb.workerDb, bus, log, { idleMs: 50 });
  const payments = new PaymentClient(`http://127.0.0.1:${PORTS.payment}`, new DevServiceTokenProvider(JWT), log);
  const orderApp = await common.createHttpApp(OrderModule.register({ log, appDb: odb.appDb, relay: orelay, payments, verifier, rateLimitPerMinute: 1000 }), {
    log,
    corsOrigins: cors,
  });
  await registerPaymentConsumers(bus, odb.appDb, log, orderApp.get(OrdersService));
  await registerLiveFeed(bus, orderApp.get(LiveHub), 'demo');
  await orderApp.listen(PORTS.order);

  console.log('Starting analytics service...');
  const adb = await serviceDb('analytics', join(root, 'services/analytics/migrations'));
  await registerProjections(bus, adb.appDb, log);
  const analyticsApp = await common.createHttpApp(AnalyticsModule.register({ log, appDb: adb.appDb, verifier, rateLimitPerMinute: 1000 }), { log, corsOrigins: cors });
  await analyticsApp.listen(PORTS.analytics);

  prelay.start();
  orelay.start();

  // Tokens expire (12h). Mint them when needed instead of once at startup, so a demo
  // left running overnight keeps working. Pages also renew theirs on a 401.
  const ownerToken = () => token(['owner'], 'Owner');
  const api = async (method, base, path, body, tok) => {
    tok ??= await ownerToken();
    const res = await fetch(`http://127.0.0.1:${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const post = (path, body) => api('POST', PORTS.order, path, body);

  const seeded = (await api('GET', PORTS.order, `/floor?outletId=${OUTLET}`)).tables.length > 0;
  if (!seeded) {
    console.log('First run: setting up a 10-table restaurant, staff and 60 days of history...');
    const tableSeats = [2, 2, 4, 4, 4, 6, 4, 2, 8, 4];
    for (let i = 0; i < tableSeats.length; i++) await post('/tables', { outletId: OUTLET, label: `T${i + 1}`, seats: tableSeats[i], sortOrder: i });

    for (const [name, role] of [['Asha', 'CASHIER'], ['Ravi', 'CAPTAIN'], ['Sunil', 'CAPTAIN'], ['Meena', 'CAPTAIN']]) await post('/staff', { outletId: OUTLET, name, role });

    //  category,  name,            price,  GST,  food cost, popularity weight (for history)
    const MENU = [
      ['Starters', 'Paneer Tikka', 24_900, 500, 7_500, 10],
      ['Starters', 'Chicken 65', 27_900, 500, 11_900, 7],
      ['Starters', 'Veg Spring Roll', 18_900, 500, 4_200, 3],
      ['Mains', 'Chicken Biryani', 29_900, 500, 10_500, 18],
      ['Mains', 'Veg Biryani', 22_900, 500, 9_600, 9],
      ['Mains', 'Dal Makhani', 21_900, 500, 5_200, 9],
      ['Mains', 'Butter Chicken', 32_900, 500, 12_200, 12],
      ['Breads', 'Butter Naan', 6_000, 500, 1_500, 20],
      ['Breads', 'Tandoori Roti', 3_500, 500, 900, 6],
      ['Drinks', 'Sweet Lassi', 8_950, 500, 3_400, 6],
      ['Drinks', 'Masala Chai', 3_500, 500, 1_100, 5],
      ['Desserts', 'Gulab Jamun', 9_900, 500, 2_000, 3],
    ];
    const seededMenu = [];
    for (const [category, name, pricePaise, gstRateBp, costPaise, weight] of MENU) {
      seededMenu.push({ ...(await post('/menu-items', { outletId: OUTLET, name, pricePaise, gstRateBp, costPaise, category })), weight });
    }

    // 60 days of realistic history, imported through the same event pipeline the live system uses.
    // It goes only to analytics: the live order service never saw these orders.
    const staffList = await api('GET', PORTS.order, `/staff?outletId=${OUTLET}`);
    const historyBus = new common.InMemoryEventBus(log);
    await registerProjections(historyBus, adb.appDb, log);
    const t0 = Date.now();
    const history = await generateHistory({ bus: historyBus, tenantId: TENANT, outletId: OUTLET, menu: seededMenu, captains: staffList.filter((x) => x.role === 'CAPTAIN'), days: 60 });
    await historyBus.waitForIdle();
    for (const e of history.expenses) await api('POST', PORTS.analytics, '/expenses', { outletId: OUTLET, ...e });
    console.log(`  ${history.orders} bills, ${history.refunds} refunds, ${history.expenses.length} expense entries (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log('Continuing with the saved demo data (run `npm run demo -- --fresh` to start over).');
  }

  // Demo sign-in: a staff member's token carries their staff id. In production this comes from Keycloak.
  const staffToken = async (id) => {
    const member = (await api('GET', PORTS.order, `/staff?outletId=${OUTLET}`)).find((x) => x.id === id);
    if (!member) return null;
    const roles = { CAPTAIN: ['captain'], CASHIER: ['cashier'], MANAGER: ['manager'] }[member.role];
    return { token: await token(roles, id), name: member.name, role: member.role };
  };
  const ashaId = (await api('GET', PORTS.order, `/staff?outletId=${OUTLET}`)).find((x) => x.role === 'CASHIER')?.id;
  const cashierToken = async () => (ashaId ? (await staffToken(ashaId)).token : token(['cashier'], 'cashier'));

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });

  const ui = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(join(root, 'scripts/demo/pos.html'))); // read per request so edits show on reload
      }
      if (req.method === 'GET' && url.pathname === '/owner') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(join(root, 'scripts/demo/owner.html')));
      }
      if (url.pathname === '/demo/captains') {
        const list = await api('GET', PORTS.order, `/staff?outletId=${OUTLET}`);
        return json(res, 200, list.filter((x) => x.role === 'CAPTAIN').map((x) => ({ id: x.id, name: x.name, openTables: x.openTables })));
      }
      if (url.pathname === '/demo/token') {
        const t = await staffToken(url.searchParams.get('staffId'));
        return t ? json(res, 200, t) : json(res, 404, { error: { message: 'No such active staff member' } });
      }
      if (url.pathname === '/demo/config') {
        const menu = await api('GET', PORTS.order, `/menu-items?outletId=${OUTLET}`);
        return json(res, 200, { orderUrl: `http://localhost:${PORTS.order}`, paymentUrl: `http://localhost:${PORTS.payment}`, outletId: OUTLET, analyticsUrl: `http://localhost:${PORTS.analytics}`, outletName: 'Spice Route · Indiranagar', tokens: { owner: await ownerToken(), cashier: await cashierToken() }, menu });
      }
      if (url.pathname === '/demo/events') return json(res, 200, events.slice(0, 50));
      if (url.pathname === '/demo/audit') {
        const rows = await pdb.workerDb.query(
          'SELECT action, from_status, to_status, actor, detail, at FROM payment_audit WHERE payment_id = $1 ORDER BY id',
          [url.searchParams.get('paymentId')],
        );
        return json(res, 200, rows);
      }
      // Plays the customer's phone: pays in the (fake) Razorpay checkout, which then
      // sends a real HMAC-signed webhook to the payment service.
      if (req.method === 'POST' && url.pathname === '/demo/simulate-upi') {
        const { gatewayOrderId, succeed = true } = await readBody(req);
        const { webhook } = gateway.simulateCustomerPayment(gatewayOrderId, { succeed });
        const r = await fetch(`http://127.0.0.1:${PORTS.payment}/webhooks/razorpay`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-razorpay-signature': webhook.signature, 'x-razorpay-event-id': webhook.eventId },
          body: webhook.body,
        });
        return json(res, 200, { webhookStatus: r.status, webhookResponse: await r.json() });
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: String(err?.message ?? err) });
    }
  });
  await new Promise((r) => ui.listen(PORTS.ui, r));

  console.log(`\nDemo ready → http://localhost:${PORTS.ui}   (floor: captain, cashier, kitchen)`);
  console.log(`  owner dashboard http://localhost:${PORTS.ui}/owner`);
  console.log(`  order service   http://localhost:${PORTS.order}`);
  console.log(`  payment service http://localhost:${PORTS.payment}`);
  console.log(`  analytics       http://localhost:${PORTS.analytics}`);
  console.log('Press Ctrl+C to stop. Data is kept in .demo-data/ (npm run demo -- --fresh to reset).\n');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // Ctrl+C reaches Postgres too, so it stops at the same moment: the resulting
    // "database shutting down" warnings are expected here, so only show real errors.
    log.level = 'error';
    ui.close();
    await orderApp.close();
    await payApp.close();
    await analyticsApp.close();
    await prelay.stop();
    await orelay.stop();
    await Promise.allSettled([pdb.appDb.close(), pdb.workerDb.close(), odb.appDb.close(), odb.workerDb.close(), adb.appDb.close(), adb.workerDb.close()]);
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(async (err) => {
  console.error('Demo failed to start:', err instanceof Error ? err.message : (err ?? 'unknown error (check that ports 4000-4002 and 54330 are free)'));
  await pg.stop().catch(() => {});
  process.exit(1);
});
