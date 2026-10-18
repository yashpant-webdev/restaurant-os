import { z } from 'zod';

/**
 * Validates environment config at boot. A service with bad config refuses to
 * start (fail fast) instead of failing on the first real payment.
 * Error output lists field names only, never values, so secrets don't leak.
 */
export const BaseConfig = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Connection for request handling. Role WITHOUT BYPASSRLS, so tenant isolation is enforced by Postgres. */
  DATABASE_URL: z.string().url(),
  /** Connection for background workers (outbox relay, reconciliation). Role WITH BYPASSRLS. */
  DATABASE_WORKER_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  JWT_MODE: z.enum(['hs256', 'jwks']).default('hs256'),
  JWT_SECRET: z.string().min(32).optional(),
  JWT_JWKS_URL: z.string().url().optional(),
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  EVENT_BUS: z.enum(['memory', 'kafka']).default('memory'),
  KAFKA_BROKERS: z.string().optional(),
  CORS_ORIGINS: z.string().default(''),
});
export type BaseConfig = z.infer<typeof BaseConfig>;

export function loadConfig<S extends z.ZodTypeAny>(schema: S, env: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${fields}`);
  }
  const cfg = parsed.data as BaseConfig;
  if (cfg.JWT_MODE === 'hs256' && !cfg.JWT_SECRET) throw new Error('Invalid configuration: JWT_SECRET required');
  if (cfg.JWT_MODE === 'jwks' && !cfg.JWT_JWKS_URL) throw new Error('Invalid configuration: JWT_JWKS_URL required');
  if (cfg.EVENT_BUS === 'kafka' && !cfg.KAFKA_BROKERS) throw new Error('Invalid configuration: KAFKA_BROKERS required');
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_MODE !== 'jwks') throw new Error('Invalid configuration: production must use JWT_MODE=jwks (Keycloak)');
    if (cfg.EVENT_BUS !== 'kafka') throw new Error('Invalid configuration: production must use EVENT_BUS=kafka');
  }
  return parsed.data;
}
