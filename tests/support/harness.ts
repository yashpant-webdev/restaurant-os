import 'reflect-metadata';
import { join } from 'node:path';
import { Client } from 'pg';
import type { INestApplication } from '@nestjs/common';
import {
  bootstrapServiceDatabase,
  createHttpApp,
  createLogger,
  Database,
  InMemoryEventBus,
  JwtVerifier,
  OutboxRelay,
  Role,
  runMigrations,
  signDevToken,
} from '@ros/common';

export const ADMIN_URL = 'postgres://postgres:postgres@localhost:54329/postgres';
export const JWT = { secret: 'test-secret-that-is-at-least-32-characters-long', issuer: 'ros-test', audience: 'ros-api' };
export const log = createLogger('test', process.env.TEST_LOG_LEVEL ?? 'silent');

const dbUrl = (user: string, pw: string, db: string) => `postgres://${user}:${pw}@localhost:54329/${db}`;

/** Fresh database for a service: drop, create with least-privilege roles, migrate. */
export async function freshServiceDb(svc: 'payment' | 'order' | 'analytics') {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${svc}_db WITH (FORCE)`);
  await admin.end();
  await bootstrapServiceDatabase(ADMIN_URL, svc, { app: `${svc}-app-pw`, worker: `${svc}-worker-pw` });
  const dir = join(__dirname, '..', '..', 'services', svc === 'order' ? 'order-pos' : svc, 'migrations');
  await runMigrations(dbUrl('postgres', 'postgres', `${svc}_db`), dir, log);
  const appDb = new Database({ url: dbUrl(`${svc}_app`, `${svc}-app-pw`, `${svc}_db`), applicationName: `${svc}-api-test`, logger: log });
  const workerDb = new Database({ url: dbUrl(`${svc}_worker`, `${svc}-worker-pw`, `${svc}_db`), applicationName: `${svc}-worker-test`, logger: log });
  return { appDb, workerDb };
}

export function verifier() {
  return new JwtVerifier({ mode: 'hs256', secret: JWT.secret, issuer: JWT.issuer, audience: JWT.audience });
}

export function token(claims: { tid: string; roles: Role[]; outlets?: string[]; sub?: string; expiresIn?: string }) {
  return signDevToken(
    JWT.secret,
    { sub: claims.sub ?? 'user-1', tid: claims.tid, outlets: claims.outlets ?? ['*'], roles: claims.roles },
    { issuer: JWT.issuer, audience: JWT.audience, expiresIn: claims.expiresIn },
  );
}

export async function startApp(module: unknown): Promise<{ app: INestApplication; url: string }> {
  const app = await createHttpApp(module, { log, corsOrigins: [] });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return { app, url: url.replace('[::1]', '127.0.0.1') };
}

export function newBus() {
  return new InMemoryEventBus(log);
}

export function relay(db: Database, bus: InMemoryEventBus) {
  return new OutboxRelay(db, bus, log, { idleMs: 20 });
}

/** Tiny fetch helper for tests. */
export async function call(url: string, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const res = await fetch(url + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}
