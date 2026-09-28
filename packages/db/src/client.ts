import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema/index';

/**
 * Driver-agnostic handle: node-postgres in production, PGlite in tests.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(connectionString: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export { schema };
