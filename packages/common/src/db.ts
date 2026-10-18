import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import type { Logger } from './logger';

export type Tx = Pick<PoolClient, 'query'>;

// Postgres BIGINT (money in paise) arrives as a string by default. Parse it to a
// number, but refuse values JS cannot represent exactly instead of silently rounding.
types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('bigint value exceeds safe integer range');
  return n;
});
// DATE columns stay 'YYYY-MM-DD' strings: converting to a JS Date would shift the day by time zone.
types.setTypeParser(1082, (v: string) => v);

export interface DatabaseOptions {
  url: string;
  applicationName: string;
  max?: number;
  statementTimeoutMs?: number;
  logger: Logger;
}

const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thin wrapper over a pg Pool that makes the safe path the easy path:
 * - every query has a statement timeout, so a stuck query cannot pin a connection forever;
 * - `tx()` always commits or rolls back and releases the client, even when the callback throws;
 * - serialization failures and deadlocks are retried automatically;
 * - `tenantId` is set as a transaction-local setting that Postgres row-level security reads.
 */
export class Database {
  readonly pool: Pool;
  private readonly log: Logger;

  constructor(opts: DatabaseOptions) {
    this.log = opts.logger;
    this.pool = new Pool({
      connectionString: opts.url,
      application_name: opts.applicationName,
      max: opts.max ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: opts.statementTimeoutMs ?? 5_000,
      query_timeout: (opts.statementTimeoutMs ?? 5_000) + 1_000,
    });
    // Without this listener, an idle client losing its connection emits an
    // unhandled 'error' event and kills the process.
    this.pool.on('error', (err) => this.log.error({ err }, 'idle postgres client error'));
  }

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<R[]> {
    const res = await this.pool.query<R>(sql, params);
    return res.rows;
  }

  async tx<T>(
    fn: (tx: Tx) => Promise<T>,
    opts: { tenantId?: string; isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'; maxRetries?: number } = {},
  ): Promise<T> {
    if (opts.tenantId !== undefined && !UUID_RE.test(opts.tenantId)) {
      throw new Error('tenantId must be a UUID');
    }
    const maxRetries = opts.maxRetries ?? 3;
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      let broken = false;
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}`);
        if (opts.tenantId) {
          await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [opts.tenantId]);
        }
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // connection is unusable; destroy it instead of returning it to the pool
        }
        const code = (err as { code?: string }).code;
        if (code && RETRYABLE_SQLSTATES.has(code) && attempt < maxRetries) {
          this.log.warn({ code, attempt }, 'retrying transaction after concurrency conflict');
          await sleep(10 * 2 ** attempt + Math.random() * 20);
          continue;
        }
        throw err;
      } finally {
        client.release(broken);
      }
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Applies `NNN_name.sql` files in order, each in its own transaction, under an
 * advisory lock so that two replicas starting together cannot both migrate.
 * Refuses to start if an already-applied file was edited (checksum mismatch).
 */
export async function runMigrations(url: string, dir: string, logger: Logger): Promise<string[]> {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(7262001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      logger.info({ file }, 'migration applied');
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(7262001)').catch(() => undefined);
    client.release();
    await pool.end();
  }
}
