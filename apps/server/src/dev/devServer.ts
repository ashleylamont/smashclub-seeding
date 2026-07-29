/**
 * Local development harness.
 *
 * Boots the *real* Fastify app against an in-process Postgres (PGlite), applies
 * the real migrations, and seeds a believable club through the real sync and
 * recompute pipelines. No Postgres server, no Challonge, no OAuth app needed —
 * which is what makes it possible to drive the actual UI in a browser and to
 * run end-to-end tests.
 *
 * Email/password auth is enabled here only (never in production) so the
 * Fastify↔better-auth bridge, sessions, roles and the claim flow are genuinely
 * exercised rather than assumed.
 *
 * Usage:
 *   DEV_CACHE_DIR=/path/to/.challonge-cache pnpm dev:harness
 *   pnpm dev:harness            # synthetic data
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { schema, type Db } from '@smashclub/db';
import { buildApp } from '../app';
import { createAuth } from '../auth';
import { loadEnv } from '../env';
import { RecomputeTrigger } from '../recompute/trigger';
import { seedDevData } from './seedFixtures';

const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/migrations', import.meta.url));

export interface DevHarness {
  url: string;
  close: () => Promise<void>;
  adminCredentials: { email: string; password: string };
  userCredentials: { email: string; password: string };
}

export async function startDevHarness(
  options: { port?: number; cacheDir?: string; quiet?: boolean; webDistDir?: string } = {},
): Promise<DevHarness> {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const cacheDir = options.cacheDir ?? process.env.DEV_CACHE_DIR;
  const webDistDir = options.webDistDir ?? process.env.WEB_DIST_DIR;
  const log = options.quiet ? () => undefined : (message: string) => console.log(message);

  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder });
  const db = pgliteDb as unknown as Db;

  const adminEmail = 'admin@smashclub.dev';
  const userEmail = 'player@smashclub.dev';
  const password = 'devpassword123';

  const env = loadEnv({
    NODE_ENV: 'development',
    DATABASE_URL: 'pglite://memory',
    BETTER_AUTH_SECRET: 'dev-secret-dev-secret-dev-secret-32',
    BETTER_AUTH_URL: `http://localhost:${port}`,
    ADMIN_EMAILS: adminEmail,
    PORT: String(port),
    // When provided, the harness also serves the built SPA, so the browser
    // talks to a single origin (no dev proxy) — what e2e runs against.
    ...(webDistDir ? { WEB_DIST_DIR: webDistDir } : {}),
  });

  log('seeding development data…');
  const { result, client: challonge } = await seedDevData(db, cacheDir);
  log(
    `seeded from ${result.source}: ${result.tournaments} tournaments, ${result.sets} sets, ` +
      `${result.players} players, ${result.queuedForReview} awaiting identity review`,
  );

  const auth = createAuth(db, env, { enableCredentials: true });
  const recomputeTrigger = new RecomputeTrigger(db, 500);
  const app = await buildApp({ db, env, auth, challonge, recomputeTrigger });

  // Two accounts so role-gating can actually be tested. The admin address is in
  // ADMIN_EMAILS, so it is promoted on first sign-in.
  for (const [email, name] of [
    [adminEmail, 'Dev Admin'],
    [userEmail, 'Dev Player'],
  ]) {
    await auth.api
      .signUpEmail({ body: { email: email!, password, name: name! } })
      .catch((error: unknown) => log(`  (sign-up for ${email} skipped: ${String(error)})`));
  }

  await app.listen({ port, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${port}`;
  log(`\ndev harness listening on ${url}`);
  log(`  admin:  ${adminEmail} / ${password}`);
  log(`  player: ${userEmail} / ${password}`);

  return {
    url,
    adminCredentials: { email: adminEmail, password },
    userCredentials: { email: userEmail, password },
    close: async () => {
      await app.close();
      await client.close();
    },
  };
}

// Run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startDevHarness().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
