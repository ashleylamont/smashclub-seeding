import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema, type Db } from '@smashclub/db';

const migrationsFolder = fileURLToPath(
  new URL('../../../../packages/db/migrations', import.meta.url),
);

async function openTestDb(loadDataDir?: Blob) {
  const client = await PGlite.create({ loadDataDir });
  const db = drizzle(client, { schema });
  if (!loadDataDir) {
    try {
      await migrate(db, { migrationsFolder });
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  return { client, db };
}

/** Build an unseeded snapshot from the current app migrations for a single test file run. */
export async function createTestDbSnapshot(): Promise<Blob> {
  const { client } = await openTestDb();
  try {
    return await client.dumpDataDir('none');
  } finally {
    await client.close();
  }
}

/** Open a private in-memory Postgres, migrating it unless given a pristine snapshot. */
export async function createTestDb(
  snapshot?: Blob,
): Promise<{ db: Db; close: () => Promise<void> }> {
  const { client, db } = await openTestDb(snapshot);
  return {
    db: db as unknown as Db,
    close: () => client.close(),
  };
}
