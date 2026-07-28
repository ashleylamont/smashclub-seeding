import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema, type Db } from '@smashclub/db';

const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url));

/** In-memory real Postgres (PGlite) with the app's migrations applied. */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return {
    db: db as unknown as Db,
    close: () => client.close(),
  };
}
