// Local demo: real PostgreSQL + payment service + order service + a POS web page.
// Run with `npm run demo`, then open http://localhost:4000
//
// Production differences: Kafka instead of the in-memory bus, real Razorpay
// instead of the fake gateway, Keycloak instead of demo tokens.
import EmbeddedPostgres from 'embedded-postgres';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('reflect-metadata');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const common = require(join(root, 'packages/common/dist/index.js'));
const { PaymentModule } = require(join(root, 'services/payment/dist/app.module.js'));
const { FakeGateway } = require(join(root, 'services/payment/dist/gateway/fake.js'));
const { OrderModule, registerPaymentConsumers } = require(join(root, 'services/order-pos/dist/app.module.js'));
const { OrdersService } = require(join(root, 'services/order-pos/dist/orders.service.js'));
const { DevServiceTokenProvider, PaymentClient } = require(join(root, 'services/order-pos/dist/payment-client.js'));

const PG_PORT = 54330;
const PORTS = { ui: 4000, order: 4001, payment: 4002 };
const JWT = { secret: 'demo-secret-for-local-use-only-at-least-32-chars', issuer: 'ros-demo', audience: 'ros-api' };
const TENANT = '01900000-0000-7000-8000-000000000001';
const OUTLET = '01900000-0000-7000-8000-0000000000a1';
const log = common.createLogger('demo', process.env.LOG_LEVEL ?? 'warn');

const pg = new EmbeddedPostgres({
  databaseDir: mkdtempSync(join(tmpdir(), 'ros-demo-pg-')),
  user: 'postgres',
  password: 'postgres',
  port: PG_PORT,
  persistent: false,
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

async function main() {
  console.log('Starting PostgreSQL...');
  await pg.initialise();
  await pg.start();

  const bus = new common.InMemoryEventBus(log);
  const events = [];
  const topics = ['payment.captured', 'payment.failed', 'payment.cancelled', 'payment.refunded', 'pos.order.settled', 'pos.order.overpaid'];
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
  await orderApp.listen(PORTS.order);
  prelay.start();
  orelay.start();

  const owner = await token(['owner'], 'owner@demo');
  const cashier = await token(['cashier'], 'cashier@demo');

  const menu = [];
  for (const [name, pricePaise, gstRateBp] of [
    ['Chicken Biryani', 29_900, 500],
    ['Paneer Tikka', 24_900, 500],
    ['Butter Naan', 6_000, 500],
    ['Dal Makhani', 21_900, 500],
    ['Sweet Lassi', 8_950, 500],
    ['Masala Chai', 3_500, 500],
  ]) {
    const res = await fetch(`http://127.0.0.1:${PORTS.order}/menu-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` },
      body: JSON.stringify({ outletId: OUTLET, name, pricePaise, gstRateBp }),
    });
    menu.push(await res.json());
  }

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
      if (url.pathname === '/demo/config') {
        return json(res, 200, { orderUrl: `http://localhost:${PORTS.order}`, paymentUrl: `http://localhost:${PORTS.payment}`, outletId: OUTLET, tokens: { owner, cashier }, menu });
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

  console.log(`\nDemo ready → http://localhost:${PORTS.ui}`);
  console.log(`  order service   http://localhost:${PORTS.order}`);
  console.log(`  payment service http://localhost:${PORTS.payment}`);
  console.log('Press Ctrl+C to stop (the demo database is temporary).\n');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    ui.close();
    await orderApp.close();
    await payApp.close();
    await prelay.stop();
    await orelay.stop();
    await Promise.allSettled([pdb.appDb.close(), pdb.workerDb.close(), odb.appDb.close(), odb.workerDb.close()]);
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(async (err) => {
  console.error('Demo failed to start:', err);
  await pg.stop().catch(() => {});
  process.exit(1);
});
