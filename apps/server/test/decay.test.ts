import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { playerRatings, players, ratingEvents, tournaments, type Db } from '@smashclub/db';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { runRecompute } from '../src/recompute/recompute';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

/**
 * Inactivity decay through the real pipeline.
 *
 * The engine unit tests pin the counting rule; this checks the thing only the
 * full path can get wrong — that sync records event dates such that a main and a
 * rookie bracket run on the same evening actually collapse to one period. If
 * sync stamped them a day apart, the rule would be right and the behaviour still
 * wrong.
 */

let db: Db;
let close: () => Promise<void>;

/** Two club nights, each with a main and a rookie bracket. */
const night1Main: FixtureTournament = {
  slug: 'main1',
  state: 'complete',
  // sync derives eventDate from startedAt, so that is what has to differ.
  startedAt: '2025-03-01T18:00:00.000+11:00',
  completedAt: '2025-03-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
  ],
  matches: [{ id: 11, p1: 1, p2: 2, winner: 1, order: 1 }],
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
  matches: [{ id: 21, p1: 1, p2: 2, winner: 1, order: 1 }],
};

const night2Main: FixtureTournament = {
  slug: 'main2',
  state: 'complete',
  startedAt: '2025-04-01T18:00:00.000+11:00',
  completedAt: '2025-04-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
  ],
  matches: [{ id: 31, p1: 1, p2: 2, winner: 2, order: 1 }],
};

const night2Rookie: FixtureTournament = {
  slug: 'rookie2',
  state: 'complete',
  startedAt: '2025-04-01T20:30:00.000+11:00',
  completedAt: '2025-04-01T22:30:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Kirby' },
    { id: 2, name: '[ATL] Yoshi' },
  ],
  matches: [{ id: 41, p1: 1, p2: 2, winner: 2, order: 1 }],
};

const ALL = [night1Main, night1Rookie, night2Main, night2Rookie];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox-mccloud', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus-aran', canonical_name: 'Samus Aran', company: 'ATL' },
    { id: 'kirby', canonical_name: 'Kirby', company: 'ATL' },
    { id: 'yoshi', canonical_name: 'Yoshi', company: 'ATL' },
  ]);
  await registerTournamentSlugs(db, ALL.map((t) => t.slug));
});

afterEach(async () => {
  await close();
});

async function syncAll(slugs: string[] = ALL.map((t) => t.slug)): Promise<void> {
  const client = fixtureClient(ALL);
  for (const slug of slugs) {
    const [row] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.challongeSlug, slug));
    await syncTournament(db, client, row!.id);
  }
}

async function playerId(canonicalName: string): Promise<string> {
  const [row] = await db.select({ id: players.id }).from(players).where(eq(players.canonicalName, canonicalName));
  return row!.id;
}

async function decayEventsFor(recomputeId: string, canonicalName: string) {
  return db
    .select()
    .from(ratingEvents)
    .where(
      and(
        eq(ratingEvents.recomputeId, recomputeId),
        eq(ratingEvents.playerId, await playerId(canonicalName)),
        eq(ratingEvents.isDecay, true),
      ),
    );
}

describe('inactivity decay through sync and recompute', () => {
  it('sync stamps same-evening brackets with the same event date', async () => {
    await syncAll();
    const rows = await db
      .select({ slug: tournaments.challongeSlug, eventDate: tournaments.eventDate })
      .from(tournaments);
    const dayBySlug = new Map(rows.map((r) => [r.slug, r.eventDate?.toISOString().slice(0, 10)]));

    // If these differed, the per-day decay rule would silently do nothing.
    expect(dayBySlug.get('main1')).toBe(dayBySlug.get('rookie1'));
    expect(dayBySlug.get('main2')).toBe(dayBySlug.get('rookie2'));
    expect(dayBySlug.get('main1')).not.toBe(dayBySlug.get('main2'));
  });

  it('charges no decay to players who attended every club night', async () => {
    await syncAll();
    const run = await runRecompute(db);

    // Main-bracket regulars were never in the rookie bracket, and vice versa —
    // nobody missed an occasion, so nobody should decay.
    for (const name of ['Fox McCloud', 'Samus Aran', 'Kirby', 'Yoshi']) {
      expect(await decayEventsFor(run.recomputeId, name), `${name} decayed`).toHaveLength(0);
    }
  });

  it('charges exactly one step to a player who misses a whole club night', async () => {
    // Kirby and Yoshi skip the second night's rookie bracket entirely.
    await syncAll(['main1', 'rookie1', 'main2']);
    const run = await runRecompute(db);

    // Two event days exist; the rookie pair attended only the first.
    for (const name of ['Kirby', 'Yoshi']) {
      const decay = await decayEventsFor(run.recomputeId, name);
      expect(decay, `${name}`).toHaveLength(1);
      expect(decay[0]!.postRd).toBeGreaterThan(decay[0]!.preRd);
      // Decay moves confidence, never the rating itself.
      expect(decay[0]!.postRating).toBeCloseTo(decay[0]!.preRating, 9);
    }
    // The main-bracket pair played both nights and are untouched.
    for (const name of ['Fox McCloud', 'Samus Aran']) {
      expect(await decayEventsFor(run.recomputeId, name), name).toHaveLength(0);
    }
  });

  it('leaves an attending player more confident than an absent one', async () => {
    await syncAll(['main1', 'rookie1', 'main2']);
    const run = await runRecompute(db);

    const rows = await db
      .select({ playerId: playerRatings.playerId, skillSd: playerRatings.skillSd })
      .from(playerRatings)
      .where(eq(playerRatings.recomputeId, run.recomputeId));
    const sdById = new Map(rows.map((r) => [r.playerId, r.skillSd]));

    const attended = sdById.get(await playerId('Fox McCloud'))!;
    const absent = sdById.get(await playerId('Kirby'))!;
    expect(absent).toBeGreaterThan(attended);
  });
});
