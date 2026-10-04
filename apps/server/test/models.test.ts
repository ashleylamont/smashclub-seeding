import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { playerRatings, ratingEvents, recomputes, sets, tournaments, type Db } from '@smashclub/db';
import * as engine from '@smashclub/engine';
import { defaultRatingSettings, LEAGUE_CATCH_ALL } from '@smashclub/shared';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import { ENGINE_VERSION, latestRecomputeId, runRecompute } from '../src/recompute/recompute';
import { getRatingSettings, updateRatingSettings } from '../src/settings';
import { appRouter } from '../src/trpc/router';
import { loadEnv } from '../src/env';
import { RecomputeTrigger } from '../src/recompute/trigger';
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
  vi.restoreAllMocks();
  await close();
});

async function syncBoth(): Promise<void> {
  const client = fixtureClient([main, rookie]);
  for (const slug of ['main1', 'rookie1']) {
    const [row] = await db
      .select({ id: tournaments.id })
      .from(tournaments)
      .where(eq(tournaments.challongeSlug, slug));
    await syncTournament(db, client, row!.id);
  }
}

function publicCaller() {
  return appRouter.createCaller({
    db,
    user: null,
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://unused',
      BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
    }),
    challonge: fixtureClient([]),
    recomputeTrigger: new RecomputeTrigger(db, 60_000),
  }).public;
}

describe('WHR-only recomputes', () => {
  it('rates only eligible result stages', async () => {
    await syncBoth();
    await db.update(sets).set({ resultStage: 'group' }).where(eq(sets.challongeMatchId, 11));
    await db
      .update(tournaments)
      .set({ resultsMode: 'final_stage_only' })
      .where(eq(tournaments.challongeSlug, 'main1'));
    expect((await runRecompute(db)).sets).toBe(5);
    expect((await runRecompute(db)).sets).toBe(5);
  });

  it('records which model produced a recompute', async () => {
    await syncBoth();
    const first = await runRecompute(db);
    expect(first.model).toBe('whr');
    const [row] = await db
      .select({ model: recomputes.model })
      .from(recomputes)
      .where(eq(recomputes.id, first.recomputeId));
    expect(row!.model).toBe('whr');
  });

  it('runs WHR by default and writes a full leaderboard', async () => {
    await syncBoth();

    const run = await runRecompute(db);
    expect(run.model).toBe('whr');
    expect(run.players).toBe(5);

    const ratings = await db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.recomputeId, run.recomputeId));
    expect(ratings).toHaveLength(5);
    // Ranks are dense and start at 1.
    expect(ratings.map((r) => r.rank).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
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
    const run = await runRecompute(db);

    const events = await db
      .select()
      .from(ratingEvents)
      .where(eq(ratingEvents.recomputeId, run.recomputeId));
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
      const ordered = [...playerEvents].sort((a, b) => a.seq - b.seq);
      for (const event of ordered) {
        expect(event.preRating).toBe(ordered[0]!.preRating);
        expect(event.postRating).toBe(ordered[0]!.postRating);
      }
      // One posterior per day: the day's end value carries the hindsight
      // estimate, identical on every row of the day.
      expect(new Set(ordered.map((e) => e.revisedRating)).size).toBe(1);
      // Every event carries a real opponent; WHR emits no decay rows.
      expect(playerEvents.every((e) => e.opponentPlayerId !== null)).toBe(true);
      expect(playerEvents.every((e) => e.isDecay === false)).toBe(true);
    }

    // Falco crosses both brackets, so he alone has four events on that day.
    const crossover = [...byPlayer.values()].find((list) => list.length === 4);
    expect(crossover).toBeDefined();
    expect(new Set(crossover!.map((e) => e.tournamentId)).size).toBe(2);
  });

  it('never reads old, failed or running runs as canonical', async () => {
    await syncBoth();
    const legacy = await db
      .insert(recomputes)
      .values({
        status: 'complete',
        model: 'glicko2',
        engineVersion: '1.0.0',
        settingsSnapshot: { glicko: { tau: 0.5 } },
      })
      .returning();
    expect(await latestRecomputeId(db)).toBeNull();
    expect(await publicCaller().leaderboard()).toMatchObject({ model: 'whr', rows: [] });
    expect(await publicCaller().ratingHistory()).toEqual({ events: [], players: [] });
    const completed = await runRecompute(db);
    for (const status of ['running', 'failed'] as const)
      await db
        .insert(recomputes)
        .values({ status, model: 'whr', engineVersion: ENGINE_VERSION, settingsSnapshot: {} });
    await db.insert(recomputes).values({
      status: 'complete',
      model: 'glicko2',
      engineVersion: ENGINE_VERSION,
      settingsSnapshot: {},
    });
    await db
      .insert(recomputes)
      .values({ status: 'complete', model: 'whr', engineVersion: '1.0.0', settingsSnapshot: {} });
    expect(await latestRecomputeId(db)).toBe(completed.recomputeId);
    expect((await db.select().from(recomputes).where(eq(recomputes.id, legacy[0]!.id)))[0]).toEqual(
      legacy[0],
    );
  });

  it('completes an empty WHR run with no fallback', async () => {
    const run = await runRecompute(db);
    expect(run).toMatchObject({ model: 'whr', players: 0, sets: 0, events: 0 });
    expect(await latestRecomputeId(db)).toBe(run.recomputeId);
  });

  it('excludes imported forfeits and byes even after a manual inclusion override', async () => {
    await syncBoth();
    await db
      .update(sets)
      .set({ scoresCsv: '-1-0', excludedFromRatings: false, exclusionManual: true })
      .where(eq(sets.challongeMatchId, 11));
    await db
      .update(sets)
      .set({ scoresCsv: '99-0', excludedFromRatings: false })
      .where(eq(sets.challongeMatchId, 12));
    await db
      .update(sets)
      .set({
        scoresCsv: null,
        raw: { provider: 'native', outcome: 'forfeit' },
        excludedFromRatings: false,
      })
      .where(eq(sets.challongeMatchId, 13));
    const run = await runRecompute(db);
    expect(run.sets).toBe(3);
    const events = await db
      .select()
      .from(ratingEvents)
      .where(eq(ratingEvents.recomputeId, run.recomputeId));
    expect(events).toHaveLength(6);
  });

  it('keeps the prior canonical run on nonconvergence and exposes manual failure', async () => {
    await syncBoth();
    const completed = await runRecompute(db);
    const empty = engine.runWhrModel({
      sets: [],
      tournaments: [],
      settings: defaultRatingSettings,
    });
    const fit = vi.spyOn(engine, 'runWhrModel').mockReturnValueOnce({
      ...empty,
      converged: false,
      iterations: 100,
    });
    const reportError = vi.fn();
    const trigger = new RecomputeTrigger(db, 60_000, reportError);
    await expect(trigger.runNow()).rejects.toThrow('WHR did not converge');
    expect(reportError).toHaveBeenCalledOnce();
    expect(await latestRecomputeId(db)).toBe(completed.recomputeId);
    const failed = (await db.select().from(recomputes).where(eq(recomputes.status, 'failed')))[0]!;
    expect(
      await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, failed.id)),
    ).toEqual([]);
    expect(
      await db.select().from(playerRatings).where(eq(playerRatings.recomputeId, failed.id)),
    ).toEqual([]);
    // A later chunk can fail after an earlier chunk inserted successfully.
    const [source] = await db
      .select()
      .from(ratingEvents)
      .where(eq(ratingEvents.recomputeId, completed.recomputeId));
    const event = {
      ...source!,
      opponentId: source!.opponentPlayerId,
      revisedRating: source!.revisedRating ?? undefined,
      revisedSd: source!.revisedSd ?? undefined,
    };
    const events = Array.from({ length: 501 }, (_, seq) => ({ ...event, seq }));
    events[500]!.setId = '00000000-0000-0000-0000-000000000001';
    fit.mockReturnValueOnce({ ...empty, events });
    await expect(runRecompute(db)).rejects.toThrow(/Failed query/);
    expect(await latestRecomputeId(db)).toBe(completed.recomputeId);
    const runs = await db.select().from(recomputes).where(eq(recomputes.status, 'failed'));
    for (const row of runs) {
      expect(
        await db.select().from(ratingEvents).where(eq(ratingEvents.recomputeId, row.id)),
      ).toEqual([]);
      expect(
        await db.select().from(playerRatings).where(eq(playerRatings.recomputeId, row.id)),
      ).toEqual([]);
    }
  });

  it('records effective calibrated settings in the completed snapshot', async () => {
    const expanded: FixtureTournament = {
      ...main,
      participants: [...main.participants],
      matches: [...main.matches],
    };
    for (let i = 4; i <= 8; i++) {
      await importRegistryPlayers(db, [
        { id: `new-${i}`, canonical_name: `New Player ${i}`, company: 'ATL' },
      ]);
      expanded.participants.push({ id: i, name: `[ATL] New Player ${i}` });
      expanded.matches.push({ id: 20 + i, p1: 1, p2: i, winner: 1, order: 20 + i });
    }
    const [t] = await db.select().from(tournaments).where(eq(tournaments.challongeSlug, 'main1'));
    await syncTournament(db, fixtureClient([expanded]), t!.id);
    const run = await runRecompute(db);
    const current = await getRatingSettings(db);
    const [saved] = await db.select().from(recomputes).where(eq(recomputes.id, run.recomputeId));
    expect(current.rating.leagueBandsCalibrated).toBe(true);
    expect(current.rating.leagueBandBasis).toBe('club');
    expect(saved!.settingsSnapshot).toEqual(current);
  });

  it('round-trips calibrated league bands and WHR configuration through a settings save', async () => {
    const { rating } = await getRatingSettings(db);
    const bands = [
      { name: 'Top', minRating: 1700 },
      { name: 'Middle', minRating: 1500 },
      { name: 'Rest', minRating: LEAGUE_CATCH_ALL },
    ];
    await updateRatingSettings(db, {
      ...rating,
      leagueBands: bands,
      leagueBandsCalibrated: true,
    });

    const saved = await getRatingSettings(db);
    await updateRatingSettings(db, { ...saved.rating, whrGamesWeight: 0.6 });

    const after = await getRatingSettings(db);
    expect(after.rating.whrGamesWeight).toBe(0.6);
    expect(after.rating.leagueBandsCalibrated).toBe(true);
    expect(after.rating.leagueBands).toEqual(bands);
  });
});
