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
import { OrderModule, registerPaymentConsumers } from './app.module';
import { OrdersService } from './orders.service';
import { DevServiceTokenProvider, PaymentClient } from './payment-client';

const OrderConfig = BaseConfig.extend({
  PORT: z.coerce.number().int().default(4001),
  DATABASE_MIGRATION_URL: z.string().url(),
  PAYMENT_SERVICE_URL: z.string().url(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
});

async function main() {
  const cfg = loadConfig(OrderConfig);
  const log = createLogger('order-pos', cfg.LOG_LEVEL);
  if (cfg.NODE_ENV === 'production') {
    // Production service-to-service auth must come from Keycloak (client credentials + token exchange), not a shared secret.
    throw new Error('Invalid configuration: Keycloak service token provider is not implemented yet');
  }

  await runMigrations(cfg.DATABASE_MIGRATION_URL, join(__dirname, '..', 'migrations'), log);
  const appDb = new Database({ url: cfg.DATABASE_URL, applicationName: 'order-api', max: cfg.DB_POOL_MAX, statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS, logger: log });
  const workerDb = new Database({ url: cfg.DATABASE_WORKER_URL, applicationName: 'order-worker', max: 5, statementTimeoutMs: cfg.DB_STATEMENT_TIMEOUT_MS, logger: log });
  const bus: EventBus = cfg.EVENT_BUS === 'kafka' ? new KafkaEventBus(cfg.KAFKA_BROKERS!.split(','), 'order-pos', log) : new InMemoryEventBus(log);
  const relay = new OutboxRelay(workerDb, bus, log);
  const verifier = new JwtVerifier({ mode: cfg.JWT_MODE, secret: cfg.JWT_SECRET, jwksUrl: cfg.JWT_JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE });
  const payments = new PaymentClient(cfg.PAYMENT_SERVICE_URL, new DevServiceTokenProvider({ secret: cfg.JWT_SECRET!, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE }), log);

  const app = await createHttpApp(OrderModule.register({ log, appDb, relay, payments, verifier, rateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE }), {
    log,
    corsOrigins: cfg.CORS_ORIGINS.split(',').filter(Boolean),
  });
  await registerPaymentConsumers(bus, appDb, log, app.get(OrdersService));
  await bus.start();

  installProcessGuards(log, async () => {
    await app.close();
    await relay.stop();
    await bus.stop();
    await Promise.allSettled([appDb.close(), workerDb.close()]);
  });

  relay.start();
  await app.listen(cfg.PORT);
  log.info({ port: cfg.PORT }, 'order service started');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('order service failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
