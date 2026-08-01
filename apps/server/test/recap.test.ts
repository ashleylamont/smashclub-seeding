import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { tournaments, type Db } from '@smashclub/db';
import type { RecapFact, RecapFactKind } from '@smashclub/engine';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { runRecompute } from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { loadEnv } from '../src/env';
import { appRouter } from '../src/trpc/router';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

/**
 * The recap end to end, over the real sync and recompute pipelines.
 *
 * The engine's own behaviour is covered in packages/engine; what is pinned
 * here is the wiring the engine cannot see: that a night folds both of its
 * brackets together, that a recap exists *before* any recompute has run, and
 * that "before tonight" is computed against the right slice of history.
 */

let db: Db;
let close: () => Promise<void>;

const march: FixtureTournament = {
  slug: 'march-main',
  state: 'complete',
  startedAt: '2025-03-01T18:00:00.000+11:00',
  completedAt: '2025-03-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud', seed: 1, finalRank: 2 },
    { id: 2, name: '[ATL] Samus Aran', seed: 2, finalRank: 1 },
    { id: 3, name: '[ATL] Kirby', seed: 3, finalRank: 3 },
  ],
  matches: [
    { id: 11, p1: 1, p2: 3, winner: 1, order: 1, round: 1, scores: '3-0' },
    { id: 12, p1: 2, p2: 3, winner: 2, order: 2, round: -1, scores: '3-1' },
    { id: 13, p1: 1, p2: 2, winner: 2, order: 3, round: 2, scores: '3-2' },
  ],
};

/** The same evening's rookie bracket — a separate Challonge tournament. */
const marchRookie: FixtureTournament = {
  slug: 'march-rookie',
  state: 'complete',
  startedAt: '2025-03-01T20:00:00.000+11:00',
  completedAt: '2025-03-01T22:00:00.000+11:00',
  participants: [
    { id: 4, name: '[ATL] Ness', seed: 1, finalRank: 2 },
    { id: 5, name: '[ATL] Lucas', seed: 2, finalRank: 1 },
  ],
  matches: [{ id: 21, p1: 4, p2: 5, winner: 5, order: 1, round: 1, scores: '1-3' }],
};

/** A later night, so March has history behind it when we ask about April. */
const april: FixtureTournament = {
  slug: 'april-main',
  state: 'complete',
  startedAt: '2025-04-01T18:00:00.000+11:00',
  completedAt: '2025-04-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud', seed: 1, finalRank: 1 },
    { id: 2, name: '[ATL] Samus Aran', seed: 2, finalRank: 2 },
    { id: 3, name: '[ATL] Kirby', seed: 3, finalRank: 3 },
  ],
  matches: [
    { id: 31, p1: 1, p2: 3, winner: 1, order: 1, round: 1, scores: '3-0' },
    { id: 32, p1: 2, p2: 3, winner: 2, order: 2, round: -1, scores: '3-0' },
    { id: 33, p1: 1, p2: 2, winner: 1, order: 3, round: 2, scores: '3-2' },
  ],
};

const ALL = [march, marchRookie, april];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox-mccloud', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus-aran', canonical_name: 'Samus Aran', company: 'ATL' },
    { id: 'kirby', canonical_name: 'Kirby', company: 'ATL' },
    { id: 'ness', canonical_name: 'Ness', company: 'ATL' },
    { id: 'lucas', canonical_name: 'Lucas', company: 'ATL' },
  ]);
  await registerTournamentSlugs(db, ALL.map((t) => t.slug));
});

afterEach(async () => {
  await close();
});

async function sync(slugs: string[]): Promise<void> {
  const client = fixtureClient(ALL);
  for (const slug of slugs) {
    const [row] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.challongeSlug, slug));
    await syncTournament(db, client, row!.id);
  }
}

function caller() {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
  });
  return appRouter.createCaller({
    db,
    env,
    user: null,
    challonge: fixtureClient(ALL),
    recomputeTrigger: new RecomputeTrigger(db, 1_000_000),
  });
}

type Recap = NonNullable<Awaited<ReturnType<ReturnType<typeof caller>['public']['recap']>>>;

function factsOfKind<K extends RecapFactKind>(recap: Recap, kind: K): Array<Extract<RecapFact, { kind: K }>> {
  return recap.facts
    .map((f) => f.fact as RecapFact)
    .filter((f): f is Extract<RecapFact, { kind: K }> => f.kind === kind);
}

describe('public.recap', () => {
  it('returns null for a slug that does not exist', async () => {
    expect(await caller().public.recap({ slug: 'nope' })).toBeNull();
  });

  it('folds both brackets of one evening into a single recap', async () => {
    await sync(['march-main', 'march-rookie']);
    const recap = (await caller().public.recap({ slug: 'march-rookie' }))!;

    expect(recap.tournaments.map((t) => t.slug)).toEqual(['march-main', 'march-rookie']);
    expect(recap.eventKey).toBe('2025-03-01');
    // Reached via the rookie slug, but a shared link should carry the main one.
    expect(recap.slug).toBe('march-main');
    expect(factsOfKind(recap, 'podium')).toHaveLength(2);
    expect(recap.entrants).toBe(5);
  });

  it('produces facts before any recompute has run', async () => {
    // The whole reason seed- and score-based facts exist: a bracket that just
    // finished has unresolved identities and no ratings yet.
    await sync(['march-main']);
    const recap = (await caller().public.recap({ slug: 'march-main' }))!;

    expect(recap.facts.length).toBeGreaterThan(0);
    expect(factsOfKind(recap, 'podium')[0]?.places[0]?.player.name).toBe('Samus A');
    expect(factsOfKind(recap, 'rating_upset')).toHaveLength(0);
    expect(factsOfKind(recap, 'biggest_climb')).toHaveLength(0);
  });

  it('publishes the shortened public alias, not the canonical name', async () => {
    await sync(['march-main']);
    const recap = (await caller().public.recap({ slug: 'march-main' }))!;
    const names = factsOfKind(recap, 'podium').flatMap((p) => p.places.map((place) => place.player.name));
    expect(names).toContain('Fox M');
    expect(names).not.toContain('Fox McCloud');
  });

  it('carries the company code for each player', async () => {
    await sync(['march-main']);
    const recap = (await caller().public.recap({ slug: 'march-main' }))!;
    const [podium] = factsOfKind(recap, 'podium');
    expect(podium?.places.every((p) => p.player.companyCode === 'ATL')).toBe(true);
  });

  it('gains rating facts once a recompute lands', async () => {
    await sync(['march-main', 'march-rookie', 'april-main']);
    await runRecompute(db);
    const recap = (await caller().public.recap({ slug: 'april-main' }))!;

    // Fox beat Samus in the April final; both had March ratings going in.
    expect(factsOfKind(recap, 'biggest_climb')).toHaveLength(1);
    expect(recap.facts.length).toBeGreaterThan(0);
  });

  it('counts head-to-head history only from nights before this one', async () => {
    await sync(['march-main', 'march-rookie', 'april-main']);
    await runRecompute(db);

    // Fox and Samus met once in March and once in April. March's recap must
    // not see April's meeting; April's must see March's.
    const marchRecap = (await caller().public.recap({ slug: 'march-main' }))!;
    const aprilRecap = (await caller().public.recap({ slug: 'april-main' }))!;

    // Two meetings is below the rivalry threshold, so neither reports one —
    // what matters is that neither *inflates* the count from the other night.
    expect(factsOfKind(marchRecap, 'rivalry')).toHaveLength(0);
    expect(factsOfKind(aprilRecap, 'rivalry')).toHaveLength(0);

    // The observable proxy for the same slice: March is nobody's second night,
    // so all five of the evening's entrants are debutants, and nobody is by
    // April.
    expect(factsOfKind(marchRecap, 'debut')[0]?.players).toHaveLength(5);
    expect(factsOfKind(aprilRecap, 'debut')).toHaveLength(0);
  });

  it('compares turnout only against earlier nights', async () => {
    await sync(['march-main', 'march-rookie', 'april-main']);
    const marchRecap = (await caller().public.recap({ slug: 'march-main' }))!;
    const aprilRecap = (await caller().public.recap({ slug: 'april-main' }))!;

    // March is the club's first night, so it has nothing to compare against.
    expect(factsOfKind(marchRecap, 'turnout')).toHaveLength(0);
    // April has three entrants against March's five, so it is not a record.
    const [aprilTurnout] = factsOfKind(aprilRecap, 'turnout');
    expect(aprilTurnout).toMatchObject({ entrants: 3, previousBest: 5, isRecord: false });
  });

  it('reports an unfinished bracket as incomplete without inventing a podium', async () => {
    const underway: FixtureTournament = {
      slug: 'may-main',
      state: 'underway',
      startedAt: '2025-05-01T18:00:00.000+11:00',
      completedAt: null,
      participants: [
        { id: 1, name: '[ATL] Fox McCloud', seed: 1 },
        { id: 2, name: '[ATL] Samus Aran', seed: 2 },
      ],
      matches: [{ id: 41, p1: 1, p2: 2, winner: 2, order: 1, round: 1, scores: '3-1' }],
    };
    await registerTournamentSlugs(db, [underway.slug]);
    const [row] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.challongeSlug, underway.slug));
    await syncTournament(db, fixtureClient([...ALL, underway]), row!.id);

    const recap = (await caller().public.recap({ slug: 'may-main' }))!;
    expect(recap.isComplete).toBe(false);
    expect(factsOfKind(recap, 'podium')).toHaveLength(0);
    expect(factsOfKind(recap, 'grand_finals')).toHaveLength(0);
    // The set that was played is still a fact worth having.
    expect(recap.setsPlayed).toBe(1);
  });
});
