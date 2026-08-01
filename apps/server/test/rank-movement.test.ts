import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { playerRatings, players, tournaments, type Db } from '@smashclub/db';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { runRecompute } from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { loadEnv } from '../src/env';
import { appRouter } from '../src/trpc/router';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

/**
 * Rank movement is movement over the club's most recent night.
 *
 * It used to be the diff between the last two recomputes, which meant it
 * reported whatever had last triggered one — a resolved identity, a settings
 * save, a model switch — and reported nothing at all once a second recompute
 * ran over the same games. This pins the property that broke: what the ▲▼
 * column says depends on the games played, not on how often the pipeline ran.
 */

let db: Db;
let close: () => Promise<void>;

const night1: FixtureTournament = {
  slug: 'night1',
  state: 'complete',
  startedAt: '2025-03-01T18:00:00.000+11:00',
  completedAt: '2025-03-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
    { id: 3, name: '[ATL] Kirby' },
  ],
  matches: [
    { id: 11, p1: 1, p2: 2, winner: 1, order: 1 },
    { id: 12, p1: 1, p2: 3, winner: 1, order: 2 },
    { id: 13, p1: 2, p2: 3, winner: 2, order: 3 },
  ],
};

/** A month later, Samus turns the head-to-head around decisively. */
const night2: FixtureTournament = {
  slug: 'night2',
  state: 'complete',
  startedAt: '2025-04-01T18:00:00.000+11:00',
  completedAt: '2025-04-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
    { id: 3, name: '[ATL] Kirby' },
  ],
  matches: [
    // `winner` is a participant id, not a side.
    { id: 21, p1: 2, p2: 1, winner: 2, order: 1 },
    { id: 22, p1: 2, p2: 3, winner: 2, order: 2 },
    { id: 23, p1: 2, p2: 1, winner: 2, order: 3 },
    { id: 24, p1: 3, p2: 1, winner: 3, order: 4 },
  ],
};

const ALL = [night1, night2];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox-mccloud', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus-aran', canonical_name: 'Samus Aran', company: 'ATL' },
    { id: 'kirby', canonical_name: 'Kirby', company: 'ATL' },
  ]);
  await registerTournamentSlugs(db, ALL.map((t) => t.slug));
});

afterEach(async () => {
  await close();
});

async function sync(slugs: string[]): Promise<void> {
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

/** rank and previousRank by player name, from a recompute's stored board. */
async function board(recomputeId: string): Promise<Map<string, { rank: number; previousRank: number | null }>> {
  const rows = await db
    .select({
      canonicalName: players.canonicalName,
      rank: playerRatings.rank,
      previousRank: playerRatings.previousRank,
    })
    .from(playerRatings)
    .innerJoin(players, eq(playerRatings.playerId, players.id))
    .where(eq(playerRatings.recomputeId, recomputeId));
  return new Map(rows.map((row) => [row.canonicalName, { rank: row.rank, previousRank: row.previousRank }]));
}

/** What the board actually publishes, through the real router. */
async function publicDeltas(): Promise<Map<string, number | null>> {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
  });
  const caller = appRouter.createCaller({
    db,
    env,
    user: null,
    challonge: fixtureClient(ALL),
    recomputeTrigger: new RecomputeTrigger(db, 1_000_000),
  });
  const { rows } = await caller.public.leaderboard();
  // Keyed on the canonical name, not the published one, so this map shares a
  // key space with board() above — the published name is the shortened alias.
  return new Map(rows.map((row) => [row.canonicalName, row.rankDelta]));
}

describe('rank movement over the last club night', () => {
  it('has nothing to compare against on the first night', async () => {
    await sync(['night1']);
    const run = await runRecompute(db);

    for (const [name, row] of await board(run.recomputeId)) {
      expect(row.previousRank, name).toBeNull();
    }
    for (const [name, delta] of await publicDeltas()) {
      expect(delta, name).toBeNull();
    }
  });

  it('reports exactly the standings from before the latest night', async () => {
    await sync(['night1']);
    const first = await runRecompute(db);
    const afterNight1 = await board(first.recomputeId);

    await sync(['night2']);
    const second = await runRecompute(db);
    const afterNight2 = await board(second.recomputeId);

    // Every player's `previousRank` is the rank they actually held before the
    // night — the standings the earlier recompute published.
    for (const [name, row] of afterNight2) {
      expect(row.previousRank, name).toBe(afterNight1.get(name)!.rank);
    }
    // And the night genuinely moved someone, so this is not a vacuous pass.
    expect(afterNight1.get('Fox McCloud')!.rank).toBe(1);
    expect(afterNight2.get('Samus Aran')!.rank).toBe(1);

    const deltas = await publicDeltas();
    expect(deltas.get('Samus Aran')).toBe(
      afterNight2.get('Samus Aran')!.previousRank! - afterNight2.get('Samus Aran')!.rank,
    );
    expect(deltas.get('Samus Aran')!).toBeGreaterThan(0);
    expect(deltas.get('Fox McCloud')!).toBeLessThan(0);
  });

  it('does not forget the movement when the pipeline runs again', async () => {
    await sync(['night1', 'night2']);
    await runRecompute(db);
    const before = await publicDeltas();

    // A second recompute over the same games — what any resolved identity or
    // settings save triggers. Under the old recompute-diff this flattened every
    // arrow to "–" because the two most recent boards were identical.
    const again = await runRecompute(db);
    expect(await publicDeltas()).toEqual(before);

    const rows = await board(again.recomputeId);
    expect(rows.get('Samus Aran')!.previousRank).not.toBeNull();
    expect([...before.values()].some((delta) => (delta ?? 0) !== 0)).toBe(true);
  });

  it('withholds the whole event, not just one bracket of it', async () => {
    // A rookie bracket on the same evening as the main one: a player who only
    // entered the rookie side must still be compared against the standings from
    // before that evening, not against a board that already has the main
    // bracket's results in it.
    const sameNightRookie: FixtureTournament = {
      slug: 'night2-rookie',
      state: 'complete',
      startedAt: '2025-04-01T20:30:00.000+11:00',
      completedAt: '2025-04-01T22:30:00.000+11:00',
      participants: [
        { id: 1, name: '[ATL] Kirby' },
        { id: 2, name: '[ATL] Samus Aran' },
      ],
      matches: [{ id: 31, p1: 1, p2: 2, winner: 1, order: 1 }],
    };
    await registerTournamentSlugs(db, ['night2-rookie']);
    const client = fixtureClient([...ALL, sameNightRookie]);
    for (const slug of ['night1', 'night2', 'night2-rookie']) {
      const [row] = await db
        .select({ id: tournaments.id })
        .from(tournaments)
        .where(eq(tournaments.challongeSlug, slug));
      await syncTournament(db, client, row!.id);
    }

    const withRookie = await runRecompute(db);
    const rows = await board(withRookie.recomputeId);

    // Withholding only the main bracket would leave the rookie set in the
    // "before" board, so Kirby's win over Samus would already be counted on
    // both sides and show as no movement at all.
    const [kirbyBefore] = await db
      .select({ previousRank: playerRatings.previousRank })
      .from(playerRatings)
      .where(
        and(
          eq(playerRatings.recomputeId, withRookie.recomputeId),
          eq(playerRatings.playerId, await playerId('Kirby')),
        ),
      );
    expect(kirbyBefore!.previousRank).toBe(rows.get('Kirby')!.previousRank);
    expect(rows.get('Kirby')!.previousRank).toBe(3); // bottom of the night-one board
  });
});
