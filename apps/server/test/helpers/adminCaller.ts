import type { Db } from '@smashclub/db';
import { loadEnv } from '../../src/env';
import { RecomputeTrigger } from '../../src/recompute/trigger';
import { appRouter } from '../../src/trpc/router';
import { fixtureClient } from './challongeFixtures';

/**
 * The admin API as an admin actually reaches it, without an HTTP round trip.
 *
 * The Challonge client is a fixture with no tournaments in it: nothing these
 * tests exercise may call Challonge, and a fixture client makes that a test
 * failure rather than a metered request.
 */
export function adminCaller(db: Db) {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
  });
  const caller = appRouter.createCaller({
    db,
    env,
    challonge: fixtureClient([]),
    // A long debounce: nothing here should trigger a recompute, and a stray
    // timer must not outlive the test's database.
    recomputeTrigger: new RecomputeTrigger(db, 60_000, () => {}),
    user: { id: 'test-admin', email: 'admin@example.com', name: 'Test Admin', role: 'admin' },
  });
  return caller.admin;
}
