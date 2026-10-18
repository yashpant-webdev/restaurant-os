import 'reflect-metadata';
import { join } from 'node:path';
import { z } from 'zod';
import {
  BaseConfig,
  createHttpApp,
  createLogger,
  Database,
  EventBus,
  InMemoryEventBus,
  installProcessGuards,
  JwtVerifier,
  KafkaEventBus,
  loadConfig,
  OutboxRelay,
  runMigrations,
} from '@ros/common';
import { PaymentModule } from './app.module';
import { FakeGateway } from './gateway/fake';
import { PaymentGateway } from './gateway/gateway';
import { RazorpayGateway } from './gateway/razorpay';
import { Reconciler } from './reconciler';

const PaymentConfig = BaseConfig.extend({
  PORT: z.coerce.number().int().default(4002),
  /** Owner/admin connection used only to run migrations at startup. */
  DATABASE_MIGRATION_URL: z.string().url(),
  PAYMENT_GATEWAY: z.enum(['razorpay', 'fake']).default('fake'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  PENDING_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(30 * 60_000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
});

async function main() {
  const cfg = loadConfig(PaymentConfig);
  const log = createLogger('payment', cfg.LOG_LEVEL);

  let gateway: PaymentGateway;
  if (cfg.PAYMENT_GATEWAY === 'razorpay') {
    if (!cfg.RAZORPAY_KEY_ID || !cfg.RAZORPAY_KEY_SECRET || !cfg.RAZORPAY_WEBHOOK_SECRET) {
      throw new Error('Invalid configuration: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET required');
    }
    gateway = new RazorpayGateway({ keyId: cfg.RAZORPAY_KEY_ID, keySecret: cfg.RAZORPAY_KEY_SECRET, webhookSecret: cfg.RAZORPAY_WEBHOOK_SECRET }, log);
  } else {
    if (cfg.NODE_ENV === 'production') throw new Error('Invalid configuration: fake gateway is not allowed in production');
    gateway = new FakeGateway('fake_key_secret_for_local_dev_only', 'fake_webhook_secret_for_local_dev_only');
  }

  await runMigrations(cfg.DATABASE_MIGRATION_URL, join(__dirname, '..', 'migrations'), log);
  const appDb = new Database({ url: cfg.DATABASE_URL, applicationName: 'payment-api', max: cfg.DB_POOL_MAX, statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS, logger: log });
  const workerDb = new Database({ url: cfg.DATABASE_WORKER_URL, applicationName: 'payment-worker', max: 5, statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS, logger: log });
  const bus: EventBus = cfg.EVENT_BUS === 'kafka' ? new KafkaEventBus(cfg.KAFKA_BROKERS!.split(','), 'payment', log) : new InMemoryEventBus(log);
  await bus.start();
  const relay = new OutboxRelay(workerDb, bus, log);
  const verifier = new JwtVerifier({ mode: cfg.JWT_MODE, secret: cfg.JWT_SECRET, jwksUrl: cfg.JWT_JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE });

  const app = await createHttpApp(
    PaymentModule.register({
      log, appDb, workerDb, gateway, relay, verifier,
      reconciler: { intervalMs: cfg.RECONCILE_INTERVAL_MS, pendingTimeoutMs: cfg.PENDING_TIMEOUT_MS },
      rateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE,
    }),
    { log, corsOrigins: cfg.CORS_ORIGINS.split(',').filter(Boolean) },
  );

  installProcessGuards(log, async () => {
    await app.close(); // stop accepting requests, wait for in-flight ones, stop the reconciler
    await relay.stop();
    await bus.stop();
    await Promise.allSettled([appDb.close(), workerDb.close()]);
  });

  relay.start();
  app.get(Reconciler).start();
  await app.listen(cfg.PORT);
  log.info({ port: cfg.PORT, gateway: gateway.name }, 'payment service started');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('payment service failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
