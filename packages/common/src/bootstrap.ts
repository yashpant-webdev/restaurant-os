import { Client } from 'pg';

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Creates a service's database and its two least-privilege roles:
 *  - `<svc>_app`: used by request handlers. NOT the table owner and NO BYPASSRLS,
 *    so Postgres row-level security enforces tenant isolation even if app code has a bug.
 *  - `<svc>_worker`: used by background jobs that legitimately span tenants
 *    (outbox relay, reconciliation, webhook lookup). Has BYPASSRLS, never exposed to HTTP input directly.
 * Migrations run as the owner/admin. In production the same is done by the
 * CloudNativePG `managed.roles` spec; this function is for dev and tests.
 */
export async function bootstrapServiceDatabase(adminUrl: string, svc: string, passwords: { app: string; worker: string }): Promise<void> {
  if (!IDENT_RE.test(svc)) throw new Error('invalid service name');
  const db = `${svc}_db`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db]);
    if (!exists.rowCount) await admin.query(`CREATE DATABASE ${db}`);
    for (const [role, bypass] of [[`${svc}_app`, false], [`${svc}_worker`, true]] as const) {
      const pw = bypass ? passwords.worker : passwords.app;
      const r = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      const verb = r.rowCount ? 'ALTER' : 'CREATE';
      await admin.query(`${verb} ROLE ${role} LOGIN ${bypass ? 'BYPASSRLS' : 'NOBYPASSRLS'} PASSWORD ${admin.escapeLiteral(pw)}`);
    }
    await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${svc}_app, ${svc}_worker`);
  } finally {
    await admin.end();
  }
}
