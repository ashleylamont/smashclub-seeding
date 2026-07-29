import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { tournaments, type Db } from '@smashclub/db';
import { buildApp } from '../src/app';
import { createAuth } from '../src/auth';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { runRecompute } from '../src/recompute/recompute';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;

const fixture: FixtureTournament = {
  slug: 'weekly1',
  state: 'complete',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
  ],
  matches: [{ id: 11, p1: 1, p2: 2, winner: 1, order: 1 }],
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://unused', BETTER_AUTH_SECRET: 'test-secret-test-secret-test' });
  const challonge = fixtureClient([fixture]);
  const auth = createAuth(db, env);
  const recomputeTrigger = new RecomputeTrigger(db);
  app = await buildApp({ db, env, auth, challonge, recomputeTrigger });

  await importRegistryPlayers(db, [
    { id: 'fox', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus', canonical_name: 'Samus Aran', company: 'ATL' },
  ]);
  await registerTournamentSlugs(db, ['weekly1']);
  const [row] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.challongeSlug, 'weekly1'));
  await syncTournament(db, challonge, row!.id);
  await runRecompute(db);
});

afterEach(async () => {
  await app.close();
  await close();
});

describe('HTTP surface', () => {
  it('serves /healthz', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('serves the public leaderboard over tRPC', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/trpc/public.leaderboard',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: { data: { rows: Array<{ name: string; rank: number }> } } };
    const rows = body.result.data.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe('Fox McCloud');
    expect(rows[0]!.rank).toBe(1);
  });

  it('serves tournament detail over tRPC', async () => {
    const input = encodeURIComponent(JSON.stringify({ slug: 'weekly1' }));
    const response = await app.inject({ method: 'GET', url: `/api/trpc/public.tournament?input=${input}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { result: { data: { sets: unknown[]; participants: unknown[] } } };
    expect(body.result.data.participants).toHaveLength(2);
    expect(body.result.data.sets).toHaveLength(1);
  });

  it('rejects admin procedures without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/trpc/admin.reviewQueue' });
    expect(response.statusCode).toBe(401);
  });

  it('answers better-auth session endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/get-session' });
    expect(response.statusCode).toBe(200);
  });
});
