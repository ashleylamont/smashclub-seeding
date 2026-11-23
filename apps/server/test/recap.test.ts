import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  players,
  recomputes,
  sets,
  tournamentParticipants,
  tournaments,
  type Db,
} from '@smashclub/db';
import type { RecapFact, RecapFactKind } from '@smashclub/engine';
import { importRegistryPlayers, registerTournamentSlugs } from '../src/bootstrap/importRegistry';
import { syncTournament } from '../src/sync/sync';
import {
  backfillRatingRecompute,
  latestRecomputeId,
  needsRatingRecompute,
  runRecompute,
} from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';
import * as whrProvenance from '../src/recompute/whrProvenance';
import { loadEnv } from '../src/env';
import * as characterReads from '../src/players/characters';
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

/**
 * A night with one newcomer and one regular, which is what a debut fact has to
 * tell apart. Both March and April are all-returners or all-newcomers, so
 * neither can catch a "before tonight" boundary that has collapsed to nothing.
 */
const june: FixtureTournament = {
  slug: 'june-main',
  state: 'complete',
  startedAt: '2025-06-01T18:00:00.000+11:00',
  completedAt: '2025-06-01T21:00:00.000+11:00',
  participants: [
    { id: 1, name: '[ATL] Fox McCloud', seed: 1, finalRank: 1 },
    { id: 6, name: '[ATL] Yoshi', seed: 2, finalRank: 2 },
  ],
  matches: [{ id: 51, p1: 1, p2: 6, winner: 1, order: 1, round: 1, scores: '2-0' }],
};

const ALL = [march, marchRookie, april, june];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await importRegistryPlayers(db, [
    { id: 'fox-mccloud', canonical_name: 'Fox McCloud', company: 'ATL' },
    { id: 'samus-aran', canonical_name: 'Samus Aran', company: 'ATL' },
    { id: 'kirby', canonical_name: 'Kirby', company: 'ATL' },
    { id: 'ness', canonical_name: 'Ness', company: 'ATL' },
    { id: 'lucas', canonical_name: 'Lucas', company: 'ATL' },
    { id: 'yoshi', canonical_name: 'Yoshi', company: 'ATL' },
  ]);
  await registerTournamentSlugs(
    db,
    ALL.map((t) => t.slug),
  );
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

function factsOfKind<K extends RecapFactKind>(
  recap: Recap,
  kind: K,
): Extract<RecapFact, { kind: K }>[] {
  return recap.facts
    .map((f) => f.fact as RecapFact)
    .filter((f): f is Extract<RecapFact, { kind: K }> => f.kind === kind);
}

async function publishForecastFixture(history: 'debut' | 'disconnected' | 'connected') {
  const [underdog, favourite, ...opponents] = await db
    .insert(players)
    .values(
      ['Underdog', 'Favourite', ...Array.from({ length: 12 }, (_, i) => `Opponent ${i}`)].map(
        (canonicalName) => ({ canonicalName }),
      ),
    )
    .returning();
  const [earlier, bridge, featured, later] = await db
    .insert(tournaments)
    .values(
      ['2025-03-01T08', '2025-03-08T06', '2025-03-08T08', '2025-03-15T08'].map((date, i) => ({
        challongeSlug: `forecast-${i}`,
        name: `Round ${i}`,
        challongeState: 'complete',
        eventDate: new Date(`${date}:00:00Z`),
      })),
    )
    .returning();
  // Link the early same-day result to a doubles bracket. The singles recap
  // does not display it, though it is part of the combined WHR replay.
  await db
    .update(tournaments)
    .set({ competitionFormat: 'doubles' })
    .where(eq(tournaments.id, bridge!.id));
  const earlierMembers = opponents.slice(0, 6);
  const otherMembers = history === 'connected' ? earlierMembers : opponents.slice(6);
  const [a, b] = await db
    .insert(tournamentParticipants)
    .values([
      {
        tournamentId: featured!.id,
        challongeParticipantId: 31,
        rawName: 'Underdog',
        cleanedName: 'Underdog',
        playerId: underdog!.id,
        challongeSeed: 8,
        finalRank: 1,
      },
      {
        tournamentId: featured!.id,
        challongeParticipantId: 32,
        rawName: 'Favourite',
        cleanedName: 'Favourite',
        playerId: favourite!.id,
        challongeSeed: 1,
        finalRank: 2,
      },
    ])
    .returning();
  const [teamOne, teamTwo] = await db
    .insert(tournamentParticipants)
    .values([
      {
        tournamentId: bridge!.id,
        challongeParticipantId: 33,
        rawName: 'Pair One',
        cleanedName: 'Pair One',
        memberPlayerIds: [favourite!.id, opponents[0]!.id],
      },
      {
        tournamentId: bridge!.id,
        challongeParticipantId: 34,
        rawName: 'Pair Two',
        cleanedName: 'Pair Two',
        memberPlayerIds: [underdog!.id, opponents[6]!.id],
      },
    ])
    .returning();
  let nextMatch = 1;
  const played = (tournamentId: string, p1PlayerId: string, p2PlayerId: string) => ({
    tournamentId,
    p1PlayerId,
    p2PlayerId,
    challongeMatchId: nextMatch++,
    state: 'complete',
    round: 1,
    winner: 1 as const,
    scoresCsv: '3-0',
  });

  await db.insert(sets).values([
    ...earlierMembers.map(({ id }) => played(earlier!.id, favourite!.id, id)),
    ...(history === 'debut'
      ? []
      : otherMembers.map(({ id }) => played(earlier!.id, id, underdog!.id))),
    { ...played(earlier!.id, favourite!.id, underdog!.id), raw: { outcome: 'forfeit' } },
    {
      ...played(bridge!.id, favourite!.id, underdog!.id),
      p1ParticipantId: teamOne!.id,
      p2ParticipantId: teamTwo!.id,
    },
    played(later!.id, favourite!.id, underdog!.id),
  ]);
  const [set] = await db
    .insert(sets)
    .values({
      ...played(featured!.id, underdog!.id, favourite!.id),
      p1ParticipantId: a!.id,
      p2ParticipantId: b!.id,
    })
    .returning();
  const { recomputeId } = await runRecompute(db);
  const api = caller().public;
  return {
    recomputeId,
    bridgeTournamentId: bridge!.id,
    featuredSetId: set!.id,
    underdogId: underdog!.id,
    readRecap: async () => (await api.recap({ slug: featured!.challongeSlug }))!,
    readImpact: (id: string) =>
      api.whrResultImpact({
        setId: set!.id,
        playerId: underdog!.id,
        recomputeId: id,
      }),
  };
}

describe('public.recap', () => {
  it('keeps ignored groups visible as excluded but leaves them out of recap results', async () => {
    await sync(['march-main']);
    await db.update(sets).set({ resultStage: 'group' }).where(eq(sets.challongeMatchId, 11));
    const before = (await caller().public.recap({ slug: 'march-main' }))!;
    await db
      .update(tournaments)
      .set({ resultsMode: 'final_stage_only' })
      .where(eq(tournaments.challongeSlug, 'march-main'));

    const view = (await caller().public.tournament({ slug: 'march-main' }))!;
    const group = view.sets.find((set) => set.resultStage === 'group')!;
    expect(view.resultsMode).toBe('final_stage_only');
    expect(group.excludedByResultsMode).toBe(true);
    expect(group.excludedFromRatings).toBe(true);
    expect(view.sets).toHaveLength(3);
    const after = (await caller().public.recap({ slug: 'march-main' }))!;
    expect(after.setsPlayed).toBe(before.setsPlayed - 1);

    // The tournament policy is separate from per-match admin exclusions.
    const [stored] = await db.select().from(sets).where(eq(sets.id, group.id));
    expect(stored!.excludedFromRatings).toBe(false);
  });

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
    const names = factsOfKind(recap, 'podium').flatMap((p) =>
      p.places.map((place) => place.player.name),
    );
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

  it.each([
    { history: 'debut' as const, forecastUnavailable: 'first_night', probability: null },
    { history: 'disconnected' as const, forecastUnavailable: 'disconnected', probability: null },
    { history: 'connected' as const, forecastUnavailable: null, probability: 0.0286 },
  ])(
    'agrees with match odds for $history prior history',
    async ({ history, forecastUnavailable, probability }) => {
      const fixture = await publishForecastFixture(history);
      const impact = await fixture.readImpact(fixture.recomputeId);
      expect(impact).toMatchObject({ status: 'available', forecastUnavailable });
      if (impact.status !== 'available') throw new Error('Expected the rated result');

      const recap = await fixture.readRecap();
      expect(factsOfKind(recap, 'seed_upset')).toMatchObject([
        { winnerSeed: 8, loserSeed: 1, score: '3-0' },
      ]);
      expect(factsOfKind(recap, 'podium')[0]?.places[0]?.player.playerId).toBe(fixture.underdogId);
      const odds = factsOfKind(recap, 'rating_upset');
      expect(odds).toHaveLength(probability === null ? 0 : 1);
      expect(impact.forecast === null).toBe(probability === null);
      expect(odds[0]?.probability ?? 0).toBeCloseTo(probability ?? 0, 4);
      expect(impact.forecast?.winProbability ?? 0).toBeCloseTo(odds[0]?.probability ?? 0, 10);
      const availableFacts = new Set(recap.facts.map(({ id }) => id));
      expect(recap.highlights.every(({ id }) => availableFacts.has(id))).toBe(true);
    },
  );

  it('restores verified odds after backfilling the latest publication without pre-night convergence', async () => {
    const fixture = await publishForecastFixture('connected');
    const [run] = await db
      .select({ stats: recomputes.stats })
      .from(recomputes)
      .where(eq(recomputes.id, fixture.recomputeId));
    const legacyStats = { ...(run!.stats as Record<string, unknown>) };
    delete legacyStats.whrConvergedPreNightKeys;
    for (const badKey of ['2025-03-09', '2025-02-30']) {
      await db
        .update(recomputes)
        .set({ stats: { ...legacyStats, whrConvergedPreNightKeys: ['2025-03-08', badKey] } })
        .where(eq(recomputes.id, fixture.recomputeId));
      expect.soft(await needsRatingRecompute(db)).toBe(true);
      expect.soft(factsOfKind(await fixture.readRecap(), 'rating_upset')).toEqual([]);
    }
    await db
      .update(recomputes)
      .set({ stats: legacyStats })
      .where(eq(recomputes.id, fixture.recomputeId));

    expect.soft(await needsRatingRecompute(db)).toBe(true);
    expect(await latestRecomputeId(db)).toBe(fixture.recomputeId);
    const legacy = await fixture.readImpact(fixture.recomputeId);
    expect.soft(legacy).toMatchObject({
      status: 'available',
      effectPoints: expect.any(Number),
      forecast: null,
    });
    const recapBefore = await fixture.readRecap();
    expect(factsOfKind(recapBefore, 'seed_upset')).toHaveLength(1);
    expect.soft(factsOfKind(recapBefore, 'rating_upset')).toEqual([]);

    const repaired = await backfillRatingRecompute(db);
    expect(repaired).not.toBeNull();
    const { recomputeId } = repaired!;
    expect(await needsRatingRecompute(db)).toBe(false);
    expect(await backfillRatingRecompute(db)).toBeNull();
    expect(await latestRecomputeId(db)).toBe(recomputeId);
    const impact = await fixture.readImpact(recomputeId);
    expect(impact).toMatchObject({
      status: 'available',
      forecast: { winProbability: expect.closeTo(0.0286, 4) },
    });
    expect(impact.status === 'available' && impact.effectPoints).toBe(
      legacy.status === 'available' && legacy.effectPoints,
    );
    expect(factsOfKind(await fixture.readRecap(), 'rating_upset')).toMatchObject([
      { probability: expect.closeTo(0.0286, 4) },
    ]);
    const [oldRun] = await db
      .select({ stats: recomputes.stats })
      .from(recomputes)
      .where(eq(recomputes.id, fixture.recomputeId));
    expect(oldRun?.stats).toEqual(legacyStats);
  });

  it('omits the upset when the result and rating run disagree on the winner', async () => {
    const fixture = await publishForecastFixture('connected');
    expect(factsOfKind(await fixture.readRecap(), 'rating_upset')).toHaveLength(1);

    const readCharacters = characterReads.charactersByPlayer;
    const intercept = vi
      .spyOn(characterReads, 'charactersByPlayer')
      .mockImplementationOnce(async (...args) => {
        // The recap has already read the old score. Publish a new rating run
        // for the reversed result before it reads the rating events.
        await db
          .update(sets)
          .set({ winner: 2, scoresCsv: '0-3' })
          .where(eq(sets.id, fixture.featuredSetId));
        await runRecompute(db);
        return readCharacters(...args);
      });

    try {
      const recap = await fixture.readRecap();
      expect(factsOfKind(recap, 'seed_upset')).toMatchObject([
        { winnerSeed: 8, loserSeed: 1, score: '3-0' },
      ]);
      expect(factsOfKind(recap, 'rating_upset')).toEqual([]);
      expect(factsOfKind(await fixture.readRecap(), 'seed_upset')).toEqual([]);
    } finally {
      intercept.mockRestore();
    }
  });

  it('skips the WHR history reread when the favourite won', async () => {
    const fixture = await publishForecastFixture('connected');
    await db
      .update(sets)
      .set({ winner: 2, scoresCsv: '0-3' })
      .where(eq(sets.id, fixture.featuredSetId));
    await runRecompute(db);

    const history = vi.spyOn(whrProvenance, 'loadWhrHistoryThroughDay');
    try {
      const recap = await fixture.readRecap();
      expect(recap.setsPlayed).toBe(1);
      expect(factsOfKind(recap, 'rating_upset')).toEqual([]);
      expect(history.mock.calls.length).toBe(0);
    } finally {
      history.mockRestore();
    }
  });

  it('waits for a new run to use a corrected doubles bridge as evidence', async () => {
    const fixture = await publishForecastFixture('disconnected');
    // Moving the bridge to an earlier night cannot authorize odds built from
    // the old recompute's disconnected fit.
    await db
      .update(tournaments)
      .set({ eventDate: new Date('2025-03-05T06:00:00Z') })
      .where(eq(tournaments.id, fixture.bridgeTournamentId));
    expect(factsOfKind(await fixture.readRecap(), 'rating_upset')).toEqual([]);

    const updated = await runRecompute(db);
    const impact = await fixture.readImpact(updated.recomputeId);
    expect(impact).toMatchObject({ status: 'available', forecastUnavailable: null });
    if (impact.status !== 'available') throw new Error('Expected the rated result');
    const [bridged] = factsOfKind(await fixture.readRecap(), 'rating_upset');
    expect(bridged?.probability).toBeCloseTo(impact.forecast!.winProbability, 10);
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

  /**
   * The same slice, under the model production actually runs.
   *
   * "Before tonight" is `rating_events.seq < the night's first seq`, which only
   * means anything if `seq` is the replay's global order. WHR numbered it per
   * player, so every player's first set was `seq` 1 and nothing was ever
   * before anything: the recap announced the whole room as first-timers every
   * night, on every night in club history, and silently dropped every rivalry,
   * breakthrough and milestone fact with them.
   */
  it('uses the global WHR sequence for career history', async () => {
    await sync(['march-main', 'march-rookie', 'april-main', 'june-main']);
    await runRecompute(db);

    // June is Yoshi's first night and Fox's third. One debutant, not two —
    // with a per-player `seq`, Yoshi's first event was numbered 1, which put
    // the whole of club history *after* the boundary and made everyone new.
    const [debut] = factsOfKind((await caller().public.recap({ slug: 'june-main' }))!, 'debut');
    expect(debut?.players.map((p) => p.name)).toEqual(['Yoshi']);
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

  /** An unfinished bracket, dated `hoursAgo`, synced and recapped. */
  const recapUnfinished = async (hoursAgo: number) => {
    const underway: FixtureTournament = {
      slug: 'may-main',
      state: 'underway',
      startedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
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
    return (await caller().public.recap({ slug: 'may-main' }))!;
  };

  it('reports a bracket still being played as incomplete, without inventing a podium', async () => {
    const recap = await recapUnfinished(2);
    expect(recap.isComplete).toBe(false);
    expect(recap.isAbandoned).toBe(false);
    expect(factsOfKind(recap, 'podium')).toHaveLength(0);
    expect(factsOfKind(recap, 'grand_finals')).toHaveLength(0);
    // The set that was played is still a fact worth having.
    expect(recap.setsPlayed).toBe(1);
  });

  /**
   * The night the room ran out of time. Challonge's `underway` is sticky, so
   * without a clock this bracket reads as "still in progress" forever — years
   * after everyone went home. Enough elapsed time is itself the evidence that
   * it is not going to finish.
   */
  it('treats a long-unfinished bracket as over, but still crowns nobody', async () => {
    const recap = await recapUnfinished(30 * 24);
    expect(recap.isComplete).toBe(true);
    expect(recap.isAbandoned).toBe(true);
    // Over is not won: the bracket never reached a final, so it has no podium.
    expect(factsOfKind(recap, 'podium')).toHaveLength(0);
    expect(factsOfKind(recap, 'grand_finals')).toHaveLength(0);
    expect(recap.setsPlayed).toBe(1);
  });
});
