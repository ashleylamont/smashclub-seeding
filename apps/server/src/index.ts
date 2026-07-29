import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema, type Db } from '@smashclub/db';
import { buildApp } from './app';
import { createAuth } from './auth';
import { ChallongeClient } from './challonge/client';
import { loadEnv } from './env';
import { RecomputeTrigger } from './recompute/trigger';
import { acquireSchedulerLock, SyncScheduler } from './scheduler';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const nodeDb = drizzle(pool, { schema });

  // Single replica + Recreate strategy makes startup migrations race-free.
  await migrate(nodeDb, { migrationsFolder: path.resolve(env.MIGRATIONS_DIR) });
  const db = nodeDb as unknown as Db;

  const auth = createAuth(db, env);
  const challonge = new ChallongeClient({
    apiKey: env.CHALLONGE_API_KEY,
    username: env.CHALLONGE_USERNAME,
  });
  const recomputeTrigger = new RecomputeTrigger(db);

  const app = await buildApp({ db, env, auth, challonge, recomputeTrigger });

  const scheduler = new SyncScheduler(db, challonge, recomputeTrigger, (message) => app.log.info(message));
  if (await acquireSchedulerLock(db)) {
    scheduler.start();
    app.log.info('sync scheduler started');
  } else {
    app.log.warn('scheduler lock held elsewhere; this replica will not sync');
  }

  const shutdown = async (): Promise<void> => {
    scheduler.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
