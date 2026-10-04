import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '@smashclub/db';

/** Never use an external DATABASE_URL; each test suite creates its own cluster. */
export async function createPostgresCluster() {
  const directory = mkdtempSync(join(tmpdir(), 'smashclub-act-'));
  const data = join(directory, 'data');
  const bin = dirname(realpathSync(execFileSync('which', ['initdb'], { encoding: 'utf8' }).trim()));
  let started = false;
  const stop = () => {
    if (started)
      execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], {
        stdio: 'pipe',
      });
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    execFileSync(
      join(bin, 'initdb'),
      ['-D', data, '--username=postgres', '--auth=trust', '--no-locale'],
      { stdio: 'pipe' },
    );
    execFileSync(
      join(bin, 'pg_ctl'),
      [
        '-D',
        data,
        '-l',
        join(directory, 'postgres.log'),
        '-o',
        `-h '' -k '${directory}' -p 65432`,
        '-w',
        'start',
      ],
      { stdio: 'pipe' },
    );
    started = true;
    const url = new URL('postgresql://postgres@localhost/postgres');
    url.searchParams.set('host', directory);
    url.searchParams.set('port', '65432');
    const { db, pool } = createDb(url.toString());
    try {
      await migrate(drizzle(pool), {
        migrationsFolder: fileURLToPath(
          new URL('../../../../packages/db/migrations', import.meta.url),
        ),
      });
      return {
        db,
        pool,
        connectionString: url.toString(),
        close: async () => {
          await pool.end();
          stop();
        },
      };
    } catch (error) {
      await pool.end();
      throw error;
    }
  } catch (error) {
    stop();
    throw error;
  }
}
