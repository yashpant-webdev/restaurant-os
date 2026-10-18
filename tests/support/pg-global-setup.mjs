import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Starts a real PostgreSQL server once for the whole integration test run.
export default async function () {
  const pg = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), 'ros-pg-')),
    user: 'postgres',
    password: 'postgres',
    port: 54329,
    persistent: false,
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  globalThis.__ROS_PG__ = pg;
}
