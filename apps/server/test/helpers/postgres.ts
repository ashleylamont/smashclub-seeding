import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createDb } from '@smashclub/db';

export const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** No external URL: every caller owns a disposable cluster, including on CI. */
export async function postgresCluster(applyMigrations = true) {
  const directory = mkdtempSync(join(tmpdir(), 'smashclub-pg-'));
  const container = `smashclub-test-${directory.split('-').at(-1)!.toLowerCase()}`;
  let started = false;
  let bin = '';
  const docker = process.env.POSTGRES_TEST_CONTAINER === '1';
  let connection: ReturnType<typeof createDb> | undefined;
  const stop = () => {
    if (!started) return;
    if (docker) run('docker', ['rm', '-f', container]);
    else run(join(bin, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop']);
    started = false;
  };
  try {
    const url = new URL('postgresql://postgres@localhost/postgres');
    if (docker) {
      run('docker', [
        'run',
        '-d',
        '--rm',
        '--name',
        container,
        '-e',
        'POSTGRES_PASSWORD=synthetic-test-password',
        '-p',
        '127.0.0.1::5432',
        'postgres:17.10-bookworm',
      ]);
      started = true;
      url.password = 'synthetic-test-password';
      url.port = run('docker', ['port', container, '5432/tcp']).split(':').at(-1)!;
      const deadline = Date.now() + 30_000;
      while (true) {
        try {
          run('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
          break;
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } else {
      bin = dirname(realpathSync(run('which', ['initdb'])));
      run(join(bin, 'initdb'), [
        '-D',
        join(directory, 'data'),
        '-U',
        'postgres',
        '-A',
        'trust',
        '--no-locale',
        '--encoding=UTF8',
      ]);
      run(join(bin, 'pg_ctl'), [
        '-D',
        join(directory, 'data'),
        '-l',
        join(directory, 'postgres.log'),
        '-o',
        `-h '' -k '${directory}' -p 65432`,
        '-w',
        'start',
      ]);
      started = true;
      url.searchParams.set('host', directory);
      url.searchParams.set('port', '65432');
    }
    connection = createDb(url.toString());
    const version = await connection.pool.query('SHOW server_version_num');
    if (Math.floor(Number(version.rows[0].server_version_num) / 10_000) !== 17)
      throw new Error('PostgreSQL reliability tests require major version 17');
    if (applyMigrations) await migrate(drizzle(connection.pool), { migrationsFolder });
    return {
      ...connection,
      connectionString: url.toString(),
      /** Reopen connections without losing durable state. */
      connect: () => createDb(url.toString()),
      close: async () => {
        try {
          await connection!.pool.end();
        } finally {
          try {
            stop();
          } finally {
            rmSync(directory, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    await connection?.pool.end();
    const log =
      docker && started
        ? run('docker', ['logs', container])
        : started
          ? readFileSync(join(directory, 'postgres.log'), 'utf8')
          : '';
    try {
      stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    throw new Error(`Disposable PostgreSQL failed: ${log}`, { cause: error });
  }
}

/** Hold the event row until both independent connections reach the lock barrier. */
export async function contend<T>(
  cluster: Awaited<ReturnType<typeof postgresCluster>>,
  planId: string,
  actions: (() => Promise<T>)[],
) {
  const locker = await cluster.pool.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM event_plans WHERE id = $1 FOR UPDATE', [planId]);
  const attempts = Promise.allSettled(actions.map((action) => action()));
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      await locker.query('SELECT pg_stat_clear_snapshot()');
      const result = await locker.query(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()",
      );
      if (Number(result.rows[0].count) >= actions.length) break;
      if (Date.now() > deadline)
        throw new Error('Independent transactions did not reach the event lock barrier');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
    // Settle all operations even on a barrier failure before teardown.
    await attempts;
  }
  return attempts;
}
