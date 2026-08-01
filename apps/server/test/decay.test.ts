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

/**
 * A run of sets between two players, as a real bracket night produces.
 *
 * Fixtures here have to establish their players before decay says anything:
 * inactivity widens the band only as far as `decayRdCap`, and someone seen once
 * or twice is already past it — the club has no confidence in them left to lose.
 * The activity penalty, not the band, is what marks such a player absent.
 */
const runOfSets = (count: number, firstId: number, p1: number, p2: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    p1,
    p2,
    winner: i % 2 === 0 ? 1 : 2,
    order: i + 1,
  }));

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
  matches: runOfSets(8, 11, 1, 2),
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
    // Also in the main bracket the same evening: one player, two brackets, one
    // occasion. This is the case eventCount exists to describe.
    { id: 3, name: '[ATL] Fox McCloud' },
  ],
  matches: [
    // Rookie sets carry scaled-down weight, so it takes more of them than in the
    // main bracket to settle Kirby's and Yoshi's ratings.
    ...runOfSets(8, 21, 1, 2),
    { id: 29, p1: 3, p2: 1, winner: 1, order: 9 },
  ],
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

  it('publishes events attended separately from brackets entered', async () => {
    await syncAll();
    const run = await runRecompute(db);

    const counts = async (name: string): Promise<{ eventCount: number; tournamentCount: number }> => {
      const [row] = await db
        .select({ eventCount: playerRatings.eventCount, tournamentCount: playerRatings.tournamentCount })
        .from(playerRatings)
        .where(
          and(eq(playerRatings.recomputeId, run.recomputeId), eq(playerRatings.playerId, await playerId(name))),
        );
      return row!;
    };

    // Fox played the main and rookie brackets on night one, plus the main on
    // night two: three brackets, two occasions.
    expect(await counts('Fox McCloud')).toEqual({ eventCount: 2, tournamentCount: 3 });
    // One bracket per night for everyone else.
    expect(await counts('Kirby')).toEqual({ eventCount: 2, tournamentCount: 2 });
    expect(await counts('Samus Aran')).toEqual({ eventCount: 2, tournamentCount: 2 });

    // The invariant, for the whole field: you cannot attend more occasions than
    // the brackets you entered.
    const all = await db
      .select({ eventCount: playerRatings.eventCount, tournamentCount: playerRatings.tournamentCount })
      .from(playerRatings)
      .where(eq(playerRatings.recomputeId, run.recomputeId));
    expect(all).toHaveLength(4);
    for (const row of all) {
      expect(row.eventCount).toBeLessThanOrEqual(row.tournamentCount);
    }
  });

  it('charges the activity penalty for a missed night and shows what the next costs', async () => {
    // The rookie pair skip the second night. With a grace window of one, nothing
    // is docked yet — but the board can already say what the next one costs.
    await syncAll(['main1', 'rookie1', 'main2']);
    const run = await runRecompute(db);

    const ratingFor = async (name: string) => {
      const [row] = await db
        .select()
        .from(playerRatings)
        .where(and(eq(playerRatings.recomputeId, run.recomputeId), eq(playerRatings.playerId, await playerId(name))));
      return row!;
    };

    const absent = await ratingFor('Kirby');
    expect(absent.missedEvents).toBe(1);
    expect(absent.attendanceStreak).toBe(0);
    expect(absent.activityPenalty).toBe(0);
    expect(absent.nextMissPenalty).toBe(40);
    expect(absent.clubRating).toBeCloseTo(absent.skillRating, 9);

    const present = await ratingFor('Fox McCloud');
    expect(present.missedEvents).toBe(0);
    expect(present.attendanceStreak).toBe(2);
    expect(present.nextMissPenalty).toBe(0);
  });

  it('ranks the board on the club rating while seeding stays conservative', async () => {
    await syncAll(['main1', 'rookie1', 'main2']);
    const run = await runRecompute(db);

    const rows = await db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.recomputeId, run.recomputeId));

    for (const row of rows) {
      // The published order is the club rating, and it is the skill estimate
      // less the penalty — never the conservative number the bracket seeds on.
      expect(row.clubRating).toBeCloseTo(row.skillRating - row.activityPenalty, 9);
      expect(row.conservativeRating).toBeCloseTo(row.skillRating - 2 * row.skillSd, 9);
    }
    const byRank = [...rows].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < byRank.length; i++) {
      expect(byRank[i - 1]!.clubRating).toBeGreaterThanOrEqual(byRank[i]!.clubRating);
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
