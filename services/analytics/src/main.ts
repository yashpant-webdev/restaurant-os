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
  runMigrations,
} from '@ros/common';
import { AnalyticsModule } from './app.module';
import { registerProjections } from './projections';

const AnalyticsConfig = BaseConfig.extend({
  PORT: z.coerce.number().int().default(4003),
  DATABASE_MIGRATION_URL: z.string().url(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
});

async function main() {
  const cfg = loadConfig(AnalyticsConfig);
  const log = createLogger('analytics', cfg.LOG_LEVEL);
  await runMigrations(cfg.DATABASE_MIGRATION_URL, join(__dirname, '..', 'migrations'), log);
  const appDb = new Database({ url: cfg.DATABASE_URL, applicationName: 'analytics-api', max: cfg.DB_POOL_MAX, statementTimeoutMs: 15_000, logger: log });
  const bus: EventBus = cfg.EVENT_BUS === 'kafka' ? new KafkaEventBus(cfg.KAFKA_BROKERS!.split(','), 'analytics', log) : new InMemoryEventBus(log);
  const verifier = new JwtVerifier({ mode: cfg.JWT_MODE, secret: cfg.JWT_SECRET, jwksUrl: cfg.JWT_JWKS_URL, issuer: cfg.JWT_ISSUER, audience: cfg.JWT_AUDIENCE });

  const app = await createHttpApp(AnalyticsModule.register({ log, appDb, verifier, rateLimitPerMinute: cfg.RATE_LIMIT_PER_MINUTE }), {
    log,
    corsOrigins: cfg.CORS_ORIGINS.split(',').filter(Boolean),
  });
  await registerProjections(bus, appDb, log);
  await bus.start();

  installProcessGuards(log, async () => {
    await app.close();
    await bus.stop();
    await appDb.close();
  });
  await app.listen(cfg.PORT);
  log.info({ port: cfg.PORT }, 'analytics service started');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('analytics service failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
