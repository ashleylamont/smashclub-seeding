import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { playerRatings, ratingEvents, recomputes, tournaments, type Db } from '@smashclub/db';
import { LEAGUE_CATCH_ALL } from '@smashclub/shared';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { runRecompute } from '../src/recompute/recompute';
import { compareModels } from '../src/recompute/compareModels';
import { getGlickoSettings, updateGlickoSettings } from '../src/settings';
import { createTestDb } from './helpers/testDb';
import { fixtureClient, type FixtureTournament } from './helpers/challongeFixtures';

let db: Db;
let close: () => Promise<void>;

/** A main bracket and a same-day rookie bracket, linked by one crossover player. */
const main: FixtureTournament = {
  slug: 'main1',
  state: 'complete',
  completedAt: '2025-03-01T12:00:00Z',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud' },
    { id: 2, name: '[ATL] Samus Aran' },
    { id: 3, name: '[OPT] Falco Lombardi' },
  ],
  matches: [
    { id: 11, p1: 1, p2: 2, winner: 1, order: 1 },
    { id: 12, p1: 1, p2: 3, winner: 1, order: 2 },
    { id: 13, p1: 2, p2: 3, winner: 2, order: 3 },
  ],
};

const rookie: FixtureTournament = {
  slug: 'rookie1',
  state: 'complete',
  completedAt: '2025-03-01T18:00:00Z',
  participants: [
    { id: 1, name: '[OPT] Falco Lombardi' },
    { id: 2, name: '[ATL] Kirby' },
    { id: 3, name: '[ATL] Yoshi' },
  ],
  matches: [
    { id: 21, p1: 1, p2: 2, winner: 1, order: 1 },
    { id: 22, p1: 1, p2: 3, winner: 1, order: 2 },
    { id: 23, p1: 2, p2: 3, winner: 2, order: 3 },
  ],
};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox-mccloud', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus-aran', canonical_name: 'Samus Aran', company: 'ATL' },
    { id: 'falco-lombardi', canonical_name: 'Falco Lombardi', company: 'OPT' },
    { id: 'kirby', canonical_name: 'Kirby', company: 'ATL' },
    { id: 'yoshi', canonical_name: 'Yoshi', company: 'ATL' },
  ]);
  // The slug carries the rookie flag (registerTournamentSlugs infers it).
  await registerTournamentSlugs(db, ['main1', 'rookie1']);
});

afterEach(async () => {
  await close();
});

async function syncBoth(): Promise<void> {
  const client = fixtureClient([main, rookie]);
  for (const slug of ['main1', 'rookie1']) {
    const [row] = await db.select({ id: tournaments.id }).from(tournaments).where(eq(tournaments.challongeSlug, slug));
    await syncTournament(db, client, row!.id);
  }
}

describe('parallel rating models', () => {
  it('records which model produced a recompute', async () => {
    await syncBoth();
    const first = await runRecompute(db);
    expect(first.model).toBe('glicko2');
    const [row] = await db.select({ model: recomputes.model }).from(recomputes).where(eq(recomputes.id, first.recomputeId));
    expect(row!.model).toBe('glicko2');
  });

  it('runs the WHR model when it is the active one and writes a full leaderboard', async () => {
    await syncBoth();
    const { glicko } = await getGlickoSettings(db);
    await updateGlickoSettings(db, { ...glicko, activeModel: 'whr' });

    const run = await runRecompute(db);
    expect(run.model).toBe('whr');
    expect(run.players).toBe(5);

    const ratings = await db.select().from(playerRatings).where(eq(playerRatings.recomputeId, run.recomputeId));
    expect(ratings).toHaveLength(5);
    // Ranks are dense and start at 1.
    expect([...ratings.map((r) => r.rank)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    for (const rating of ratings) {
      expect(Number.isFinite(rating.skillRating)).toBe(true);
      expect(rating.skillSd).toBeGreaterThan(0);
      // Seeding stays the pessimistic estimate under this model too.
      expect(rating.conservativeRating).toBeLessThan(rating.skillRating);
      expect(rating.league).toBeTruthy();
    }
  });

  it('treats same-day brackets as one WHR rating period', async () => {
    await syncBoth();
    const { glicko } = await getGlickoSettings(db);
    await updateGlickoSettings(db, { ...glicko, activeModel: 'whr' });
    const run = await runRecompute(db);

    const events = await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, run.recomputeId));
    // 6 sets across both brackets, two players each.
    expect(events).toHaveLength(12);

    const byPlayer = new Map<string, typeof events>();
    for (const event of events) {
      const list = byPlayer.get(event.playerId) ?? [];
      list.push(event);
      byPlayer.set(event.playerId, list);
    }
    expect(byPlayer.size).toBe(5);

    for (const [, playerEvents] of byPlayer) {
      // Main and rookie brackets ran on the same date, so every player sits at
      // exactly one rating for the whole day — a period is an occasion, not a
      // bracket, and skill did not change between the two.
      expect(new Set(playerEvents.map((e) => e.postRating)).size).toBe(1);
      // The movement into that period is booked once; the rest are flat.
      expect(playerEvents.filter((e) => e.preRating !== e.postRating).length).toBeLessThanOrEqual(1);
      // Every event carries a real opponent; WHR emits no decay rows.
      expect(playerEvents.every((e) => e.opponentPlayerId !== null)).toBe(true);
      expect(playerEvents.every((e) => e.isDecay === false)).toBe(true);
    }

    // Falco crosses both brackets, so he alone has four events on that day.
    const crossover = [...byPlayer.values()].find((list) => list.length === 4);
    expect(crossover).toBeDefined();
    expect(new Set(crossover!.map((e) => e.tournamentId)).size).toBe(2);
  });

  it('compares both models without publishing either', async () => {
    await syncBoth();
    await runRecompute(db);
    const before = await db.select({ id: recomputes.id }).from(recomputes);

    const comparison = await compareModels(db);
    expect(comparison.activeModel).toBe('glicko2');
    expect(comparison.players).toBe(5);
    expect(comparison.rows).toHaveLength(5);
    for (const row of comparison.rows) {
      expect(row.glicko).not.toBeNull();
      expect(row.whr).not.toBeNull();
      expect(row.rankDelta).not.toBeNull();
    }
    // Rows are ordered by biggest disagreement.
    const magnitudes = comparison.rows.map((row) => Math.abs(row.rankDelta ?? 0));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);

    // Read-only: no new recompute was written.
    const after = await db.select({ id: recomputes.id }).from(recomputes);
    expect(after).toHaveLength(before.length);
  });

  it('round-trips calibrated league bands and the model choice through a settings save', async () => {
    const { glicko } = await getGlickoSettings(db);
    const bands = [
      { name: 'Top', minRating: 1700 },
      { name: 'Middle', minRating: 1500 },
      { name: 'Rest', minRating: LEAGUE_CATCH_ALL },
    ];
    await updateGlickoSettings(db, {
      ...glicko,
      activeModel: 'whr',
      leagueBands: bands,
      leagueBandsCalibrated: true,
    });

    // Changing one tuning parameter must not revert the bands to the shipped
    // defaults or the model to Glicko-2. Anything that saves settings has to send
    // the whole object; a payload built from a subset of fields silently resets
    // every setting it omits, because the schema fills those with defaults.
    const saved = await getGlickoSettings(db);
    await updateGlickoSettings(db, { ...saved.glicko, tau: 0.6 });

    const after = await getGlickoSettings(db);
    expect(after.glicko.tau).toBe(0.6);
    expect(after.glicko.activeModel).toBe('whr');
    expect(after.glicko.leagueBandsCalibrated).toBe(true);
    expect(after.glicko.leagueBands).toEqual(bands);
  });
});
