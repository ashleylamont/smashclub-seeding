import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { players, tournaments, type Db } from '@smashclub/db';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { runRecompute } from '../src/recompute/recompute';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

/**
 * What a decay row on the profile is called.
 *
 * Decay is charged for an *occasion*, but a rating event has to point at one
 * tournament, so the engine points it at the evening's first bracket. Reading
 * that back as the row's title told a main-bracket player they had missed the
 * rookie bracket — the half of the night they could never have entered.
 */

let db: Db;
let close: () => Promise<void>;

/**
 * A run of sets between two players, long enough to settle their ratings.
 *
 * `firstOrder` is the bracket's play order, which has to stay unique within a
 * tournament: the module payload carries the order as the match identifier, so
 * two runs sharing one would be two matches claiming to be the same set.
 */
const runOfSets = (count: number, firstId: number, p1: number, p2: number, firstOrder = 1) =>
  Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    p1,
    p2,
    winner: i % 2 === 0 ? p1 : p2,
    order: firstOrder + i,
  }));

/*
 * Three club nights. Fox and Samus are main-bracket regulars, Kirby and Yoshi
 * rookie regulars, and Link and Zelda play the first and third nights but skip
 * the second entirely — which is the only way to have a player miss a night
 * that ran *both* brackets.
 */
const night1Main: FixtureTournament = {
  slug: 'main1',
  state: 'complete',
  startedAt: '2025-03-01T18:00:00.000+11:00',
  completedAt: '2025-03-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
    { id: 3, name: '[ATL] Link' },
    { id: 4, name: '[ATL] Zelda' },
  ],
  matches: [...runOfSets(8, 11, 1, 2), ...runOfSets(8, 31, 3, 4, 9)],
};

const night1Rookie: FixtureTournament = {
  slug: 'rookie1',
  state: 'complete',
  // Later the same evening — one occasion, two brackets.
  startedAt: '2025-03-01T20:30:00.000+11:00',
  completedAt: '2025-03-01T22:30:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Kirby' },
    { id: 2, name: '[ATL] Yoshi' },
  ],
  matches: runOfSets(8, 51, 1, 2),
};

/*
 * Night two ran its rookie bracket first, so the engine hangs the night's decay
 * off the rookie bracket — which is exactly the row a main-bracket player should
 * never be told they missed.
 */
const night2Main: FixtureTournament = {
  slug: 'main2',
  state: 'complete',
  startedAt: '2025-04-01T19:30:00.000+11:00',
  completedAt: '2025-04-01T22:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
  ],
  matches: [{ id: 71, p1: 1, p2: 2, winner: 2, order: 1 }],
};

const night2Rookie: FixtureTournament = {
  slug: 'rookie2',
  state: 'complete',
  startedAt: '2025-04-01T17:00:00.000+11:00',
  completedAt: '2025-04-01T19:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Kirby' },
    { id: 2, name: '[ATL] Yoshi' },
  ],
  matches: [{ id: 81, p1: 1, p2: 2, winner: 1, order: 1 }],
};

/** Night three ran one bracket, and is where Link and Zelda reappear. */
const night3Main: FixtureTournament = {
  slug: 'main3',
  state: 'complete',
  startedAt: '2025-05-01T18:00:00.000+11:00',
  completedAt: '2025-05-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Link' },
    { id: 3, name: '[ATL] Zelda' },
  ],
  matches: [
    { id: 91, p1: 2, p2: 3, winner: 2, order: 1 },
    { id: 92, p1: 1, p2: 2, winner: 1, order: 2 },
  ],
};

const ALL = [night1Main, night1Rookie, night2Main, night2Rookie, night3Main];

function anonymous() {
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

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox-mccloud', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus-aran', canonical_name: 'Samus Aran', company: 'ATL' },
    { id: 'kirby', canonical_name: 'Kirby', company: 'ATL' },
    { id: 'yoshi', canonical_name: 'Yoshi', company: 'ATL' },
    { id: 'link', canonical_name: 'Link', company: 'ATL' },
    { id: 'zelda', canonical_name: 'Zelda', company: 'ATL' },
  ]);
  await registerTournamentSlugs(
    db,
    ALL.map((t) => t.slug),
  );
  const client = fixtureClient(ALL);
  for (const fixture of ALL) {
    const [row] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.challongeSlug, fixture.slug));
    await syncTournament(db, client, row!.id);
  }
  await runRecompute(db);
});

afterEach(async () => {
  await close();
});

async function decayRows(canonicalName: string) {
  const [player] = await db.select({ id: players.id }).from(players).where(eq(players.canonicalName, canonicalName));
  const result = await anonymous().public.player({ playerId: player!.id });
  const profile = result as { events: Array<Record<string, unknown>> };
  return profile.events.filter((event) => event.isDecay);
}

describe('naming an inactivity decay row', () => {
  it('names every bracket of the night that was missed', async () => {
    // Link skipped a night the club ran a main and a rookie bracket on. Both
    // belong in the row: one occasion, and it is the occasion he missed.
    const decay = await decayRows('Link');
    expect(decay).toHaveLength(1);
    expect(decay[0]!.tournamentName).toBe('rookie2 + main2');
  });

  it('does not call a whole night rookie because one of its brackets was', async () => {
    // The chip on this row is what says "this was the rookie bracket". A night
    // with a main bracket in it was never rookie-only, whichever bracket the
    // engine happened to hang the event off.
    const decay = await decayRows('Link');
    expect(decay[0]!.isRookie).toBe(false);
  });

  it('leaves the tournament a played set belongs to alone', async () => {
    const [player] = await db.select({ id: players.id }).from(players).where(eq(players.canonicalName, 'Link'));
    const result = (await anonymous().public.player({ playerId: player!.id })) as {
      events: Array<Record<string, unknown>>;
    };
    const played = result.events.filter((event) => !event.isDecay);
    // A set was played in one bracket, and is still reported against that one.
    expect(new Set(played.map((event) => event.tournamentName))).toEqual(new Set(['main1', 'main3']));
  });
});
