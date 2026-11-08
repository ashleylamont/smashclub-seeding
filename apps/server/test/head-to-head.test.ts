import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import {
  eventPlans,
  nativeLiveHandoffs,
  nativeResultPublications,
  playerRatings,
  players,
  recomputes,
  sets,
  tournaments,
  type Db,
} from '@smashclub/db';
import { DISPLAY_CENTRE, NATURAL_TO_DISPLAY, probabilityFromRatings } from '@smashclub/engine';
import { loadEnv } from '../src/env';
import { ENGINE_VERSION, runRecompute } from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { appRouter } from '../src/trpc/router';
import { fixtureClient } from './helpers/challongeFixtures';
import { createTestDb } from './helpers/testDb';

function publicApi(db: Db) {
  return appRouter.createCaller({
    db,
    user: null,
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://unused',
      BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
    }),
    challonge: fixtureClient([]),
    recomputeTrigger: new RecomputeTrigger(db, 1_000_000),
  }).public;
}

async function addTournament(
  db: Db,
  slug: string,
  fields: Partial<typeof tournaments.$inferInsert> = {},
) {
  const [row] = await db
    .insert(tournaments)
    .values({
      name: slug,
      challongeSlug: slug,
      eventDate: new Date('2026-04-10T08:00:00Z'),
      challongeState: 'complete',
      ...fields,
    })
    .returning();
  return row!.id;
}

async function nativeEditions(db: Db, slug: string, withdrawn = false) {
  const [plan] = await db
    .insert(eventPlans)
    .values({
      name: slug,
      eventDate: new Date('2026-05-01T08:00:00Z'),
      bracketMode: 'native',
      resultsWithdrawnAt: withdrawn ? new Date('2026-05-02T08:00:00Z') : null,
    })
    .returning();
  await db.insert(nativeLiveHandoffs).values({ eventPlanId: plan!.id, baseline: {} });
  const ids = [];
  for (const revision of [1, 2]) {
    const resultId = randomUUID();
    const id = await addTournament(db, `${slug}-r${revision}`, {
      provider: 'native',
      raw: { eventPlanId: plan!.id, resultId },
      eventDate: plan!.eventDate,
    });
    await db.insert(nativeResultPublications).values({
      resultId,
      eventPlanId: plan!.id,
      revision,
      result: {},
      tournamentIds: [id],
    });
    ids.push(id);
  }
  return ids as [string, string];
}

it('reads the effective played pair, preserves source identity and orients both facts and raw published WHR', async () => {
  const { db, close } = await createTestDb();
  try {
    const [a, b, c, middle, old, activeWithPointer] = await db
      .insert(players)
      .values([
        { canonicalName: 'Alice Private', displayName: 'Ace' },
        { canonicalName: 'Beatrice Private' },
        { canonicalName: 'Chris Private', displayName: 'Unrated player' },
        { canonicalName: 'Intermediate Private' },
        { canonicalName: 'Previous Private' },
        { canonicalName: 'Independent Private' },
      ])
      .returning();
    await db
      .update(players)
      .set({ status: 'merged', mergedIntoPlayerId: a!.id })
      .where(eq(players.id, middle!.id));
    await db
      .update(players)
      .set({ status: 'merged', mergedIntoPlayerId: middle!.id })
      .where(eq(players.id, old!.id));
    await db
      .update(players)
      .set({ mergedIntoPlayerId: a!.id })
      .where(eq(players.id, activeWithPointer!.id));
    const linked = await addTournament(db, 'linked-singles', { resultsMode: 'final_stage_only' });
    const doubles = await addTournament(db, 'doubles', { competitionFormat: 'doubles' });
    const [superseded, active] = await nativeEditions(db, 'effective');
    const [, withdrawn] = await nativeEditions(db, 'withdrawn', true);
    await db
      .update(tournaments)
      .set({ raw: null, challongeState: null })
      .where(eq(tournaments.id, superseded));
    const [withdrawnPlan] = await db
      .select({ id: eventPlans.id })
      .from(eventPlans)
      .where(eq(eventPlans.name, 'withdrawn'));
    await db
      .update(tournaments)
      .set({
        raw: { eventPlanId: withdrawnPlan!.id, resultId: 'not a uuid' },
        challongeState: null,
      })
      .where(eq(tournaments.id, active));
    await db.update(tournaments).set({ raw: null }).where(eq(tournaments.id, withdrawn));
    const historicUnknown = await addTournament(db, 'historic-null-status', {
      challongeState: null,
      eventDate: new Date('2026-02-01'),
    });
    const unfinished = await addTournament(db, 'recent-live', {
      challongeState: 'underway',
      eventDate: new Date(),
    });
    const freshUnknown = await addTournament(db, 'recent-null-status', {
      challongeState: null,
      eventDate: new Date(),
    });
    const [legacyPlan] = await db
      .insert(eventPlans)
      .values({ name: 'legacy', eventDate: new Date('2026-03-01') })
      .returning();
    const legacy = await addTournament(db, 'legacy-native', {
      provider: 'native',
      eventDate: legacyPlan!.eventDate,
      raw: { eventPlanId: legacyPlan!.id },
    });
    const legacyWithdrawn = await addTournament(db, 'legacy-withdrawn', {
      provider: 'native',
      raw: { eventPlanId: withdrawnPlan!.id },
    });
    const missingReceipt = await addTournament(db, 'missing-receipt', {
      provider: 'native',
      raw: { eventPlanId: legacyPlan!.id, resultId: randomUUID() },
    });
    const nextSet = (match: number, fields: Partial<typeof sets.$inferInsert> = {}) => ({
      tournamentId: linked,
      state: 'complete',
      challongeMatchId: match,
      p1PlayerId: a!.id,
      p2PlayerId: b!.id,
      winner: 1,
      scoresCsv: '2-1',
      ...fields,
    });
    await db.insert(sets).values([
      nextSet(1, { excludedFromRatings: true, exclusionManual: true }),
      nextSet(2, {
        p1PlayerId: b!.id,
        p2PlayerId: old!.id,
        winner: 1,
        scoresCsv: '1-0,0-1,1-0',
        resultStage: 'group',
      }),
      nextSet(3, { scoresCsv: null, winner: 2 }),
      nextSet(4, { scoresCsv: '-1-0' }),
      nextSet(5, { scoresCsv: '0-99' }),
      nextSet(6, { scoresCsv: null, raw: { outcome: 'forfeit' } }),
      nextSet(7, { scoresCsv: '2-0', raw: { outcome: 'bye' } }),
      nextSet(8, { raw: { outcome: 'no_contest' } }),
      nextSet(9, { winner: 0 }),
      nextSet(10, { state: 'open' }),
      nextSet(1, { tournamentId: doubles }),
      nextSet(1, { tournamentId: superseded }),
      nextSet(1, {
        tournamentId: active,
        scoresCsv: '2-0',
        raw: { outcome: 'played', advancementDisposition: 'superseded' },
      }),
      nextSet(2, {
        tournamentId: active,
        winner: 2,
        scoresCsv: '1-2',
        raw: { outcome: 'played' },
      }),
      nextSet(1, { tournamentId: withdrawn }),
      nextSet(1, { tournamentId: legacy, scoresCsv: '2-0' }),
      nextSet(1, { tournamentId: legacyWithdrawn }),
      nextSet(1, { tournamentId: missingReceipt }),
      nextSet(1, { tournamentId: historicUnknown, scoresCsv: '2-0' }),
      nextSet(1, { tournamentId: unfinished }),
      nextSet(1, { tournamentId: freshUnknown }),
      nextSet(11, { p1PlayerId: activeWithPointer!.id }),
      nextSet(12, { scoresCsv: '5-0' }),
      nextSet(13, { winner: 2, scoresCsv: '2-2' }),
      nextSet(14, { winner: 2, scoresCsv: '3-1' }),
    ]);

    const { recomputeId } = await runRecompute(db);
    for (const [player, rating, rd] of [
      [a!, 1650, 125],
      [b!, 1450, 175],
    ] as const) {
      await db
        .update(playerRatings)
        .set({ rating, rd, skillRating: 800, clubRating: 900 })
        .where(eq(playerRatings.playerId, player.id));
    }
    const finishedAt = new Date('2026-06-02T04:00:00Z');
    await db.update(recomputes).set({ finishedAt }).where(eq(recomputes.id, recomputeId));
    await db.insert(recomputes).values([
      {
        status: 'complete',
        engineVersion: 'old',
        startedAt: new Date('2099-01-01'),
        settingsSnapshot: {},
      },
      {
        status: 'complete',
        engineVersion: ENGINE_VERSION,
        model: 'glicko2',
        startedAt: new Date('2099-02-01'),
        settingsSnapshot: {},
      },
    ]);

    const api = publicApi(db);
    const response = await api.headToHead({ first: old!.id, second: b!.id });
    expect(response.status).toBe('ready');
    if (response.status !== 'ready') throw new Error('Expected a comparison');
    expect(response.players).toEqual([
      { id: a!.id, name: 'Ace', companyCode: null },
      { id: b!.id, name: 'Beatrice P', companyCode: null },
    ]);
    expect(JSON.stringify(response)).not.toMatch(
      /Private|Previous|Intermediate|advancementDisposition/,
    );
    expect(response.history).toMatchObject({
      wins: [5, 5],
      gamesWon: [15, 5],
      scoredMeetings: 7,
      recent: [
        { slug: 'effective-r2', winner: 1, games: [1, 2] },
        { slug: 'effective-r2', winner: 0, games: [2, 0] },
        { slug: 'linked-singles', winner: 1, games: null },
        { slug: 'linked-singles', winner: 1, games: null },
        { slug: 'linked-singles', winner: 0, games: [5, 0] },
        { slug: 'linked-singles', winner: 1, games: null },
        { slug: 'linked-singles', winner: 1, games: [1, 2] },
        { slug: 'linked-singles', winner: 0, games: [2, 1] },
        { slug: 'legacy-native', winner: 0, games: [2, 0] },
        { slug: 'historic-null-status', winner: 0, games: [2, 0] },
      ],
    });
    expect(response.forecast?.ratedAt).toBe(finishedAt.toISOString());
    const chance = probabilityFromRatings(
      (1650 - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY,
      (1450 - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY,
      (125 / NATURAL_TO_DISPLAY) ** 2 + (175 / NATURAL_TO_DISPLAY) ** 2,
    );
    expect(response.forecast?.firstWinChance).toBeCloseTo(chance, 12);

    const reversed = await api.headToHead({ first: b!.id, second: a!.id });
    expect(reversed.status).toBe('ready');
    if (reversed.status !== 'ready') throw new Error('Expected a reversed comparison');
    expect(reversed.history?.recent.map(({ id, games, winner }) => [id, games, winner])).toEqual(
      response.history?.recent.map(({ id, games, winner }) => [
        id,
        games && [games[1], games[0]],
        1 - winner,
      ]),
    );
    expect(reversed.history?.gamesWon).toEqual([5, 15]);
    expect(reversed.forecast?.firstWinChance).toBeCloseTo(1 - chance, 12);
    expect(await api.headToHead({ first: a!.id, second: middle!.id })).toMatchObject({
      status: 'same_player',
    });
    expect(await api.headToHead({ first: old!.id })).toMatchObject({
      status: 'choose_players',
      players: [{ id: a!.id }, null],
    });
    expect(await api.headToHead({ first: randomUUID(), second: b!.id })).toMatchObject({
      status: 'missing_player',
      players: [null, { id: b!.id }],
    });
    expect(await api.headToHead({ first: a!.id, second: c!.id })).toMatchObject({
      status: 'ready',
      history: { wins: [0, 0], gamesWon: [0, 0], scoredMeetings: 0, recent: [] },
      forecast: null,
    });
    expect(await api.headToHead({ first: activeWithPointer!.id, second: b!.id })).toMatchObject({
      status: 'ready',
      players: [{ id: activeWithPointer!.id }, { id: b!.id }],
      history: { wins: [1, 0] },
    });
    expect(await api.searchPlayers({ query: 'Private' })).toEqual([]);
  } finally {
    await close();
  }
});

it('keeps exact totals beyond the recent list and withholds totals if the pair exceeds the read budget', async () => {
  const { db, close } = await createTestDb();
  try {
    const [a, b] = await db
      .insert(players)
      .values([{ canonicalName: 'Alice' }, { canonicalName: 'Beatrice' }])
      .returning();
    const tournamentId = await addTournament(db, 'repeat-fixture');
    const addMeetings = (start: number, count: number) =>
      db.insert(sets).values(
        Array.from({ length: count }, (_, index) => ({
          tournamentId,
          state: 'complete',
          challongeMatchId: start + index,
          p1PlayerId: a!.id,
          p2PlayerId: b!.id,
          winner: 1,
          scoresCsv: '2-0',
        })),
      );
    await addMeetings(1, 15);
    const api = publicApi(db);
    const input = { first: a!.id, second: b!.id };
    const first = await api.headToHead(input);
    expect(first).toMatchObject({ status: 'ready', history: { wins: [15, 0], gamesWon: [30, 0] } });
    expect(first.status === 'ready' && first.history?.recent).toHaveLength(10);
    await addMeetings(16, 2049 - 15);
    expect(await api.headToHead(input)).toMatchObject({ status: 'ready', history: null });
  } finally {
    await close();
  }
});
