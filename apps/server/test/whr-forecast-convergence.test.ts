import { beforeAll, expect, it } from 'vitest';
import { players, sets, tournamentParticipants, tournaments } from '@smashclub/db';
import { defaultRatingSettings } from '@smashclub/shared';
import { loadEnv } from '../src/env';
import { runRecompute } from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { updateRatingSettings } from '../src/settings';
import { appRouter } from '../src/trpc/router';
import { fixtureClient } from './helpers/challongeFixtures';
import { createTestDb, createTestDbSnapshot } from './helpers/testDb';

let snapshot: Blob;

beforeAll(async () => {
  snapshot = await createTestDbSnapshot();
});

it.each([
  { priorSd: 1.2, earlierWins: 38, earlierLosses: 30, laterLosses: 9 },
  { priorSd: 4, earlierWins: 250, earlierLosses: 100, laterLosses: 151 },
])('withholds odds after the earlier fit caps with prior SD $priorSd', async (fixture) => {
  const { db, close } = await createTestDb(snapshot);
  try {
    const [favourite, underdog] = await db
      .insert(players)
      .values([{ canonicalName: 'Favourite Player' }, { canonicalName: 'Underdog Player' }])
      .returning();
    const [earlier, later] = await db
      .insert(tournaments)
      .values([
        {
          challongeSlug: 'earlier-night',
          name: 'Earlier night',
          challongeState: 'complete',
          eventDate: new Date('2026-01-01T08:00:00Z'),
        },
        {
          challongeSlug: 'later-night',
          name: 'Later night',
          challongeState: 'complete',
          eventDate: new Date('2026-01-08T08:00:00Z'),
        },
      ])
      .returning();
    const [first, second] = await db
      .insert(tournamentParticipants)
      .values([
        {
          tournamentId: later!.id,
          challongeParticipantId: 1,
          rawName: 'Favourite Player',
          cleanedName: 'Favourite Player',
          playerId: favourite!.id,
          challongeSeed: 1,
          finalRank: 2,
        },
        {
          tournamentId: later!.id,
          challongeParticipantId: 2,
          rawName: 'Underdog Player',
          cleanedName: 'Underdog Player',
          playerId: underdog!.id,
          challongeSeed: 8,
          finalRank: 1,
        },
      ])
      .returning();

    let matchId = 0;
    const played = (tournamentId: string, winner: 1 | 2) => ({
      tournamentId,
      challongeMatchId: ++matchId,
      state: 'complete',
      round: 1,
      p1PlayerId: favourite!.id,
      p2PlayerId: underdog!.id,
      winner,
      scoresCsv: winner === 1 ? '3-0' : '0-3',
    });
    await db
      .insert(sets)
      .values([
        ...Array.from({ length: fixture.earlierWins }, () => played(earlier!.id, 1)),
        ...Array.from({ length: fixture.earlierLosses }, () => played(earlier!.id, 2)),
      ]);
    const [target] = await db
      .insert(sets)
      .values(
        Array.from({ length: fixture.laterLosses }, () => ({
          ...played(later!.id, 2),
          p1ParticipantId: first!.id,
          p2ParticipantId: second!.id,
        })),
      )
      .returning({ id: sets.id });
    await updateRatingSettings(db, { ...defaultRatingSettings, whrPriorSd: fixture.priorSd });
    const { recomputeId } = await runRecompute(db);
    const api = appRouter.createCaller({
      db,
      env: loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://unused',
        BETTER_AUTH_SECRET: 'test-secret-test-secret-test',
      }),
      user: null,
      challonge: fixtureClient([]),
      recomputeTrigger: new RecomputeTrigger(db, 1_000_000),
    }).public;

    const impact = await api.whrResultImpact({
      playerId: favourite!.id,
      setId: target!.id,
      recomputeId,
    });
    expect.soft(impact).toMatchObject({
      status: 'available',
      effectPoints: expect.any(Number),
      forecast: null,
      forecastUnavailable: 'missing_estimate',
    });
    const recap = await api.recap({ slug: 'later-night' });
    expect(recap?.setsPlayed).toBe(fixture.laterLosses);
    const facts = recap!.facts.map(({ fact }) => fact);
    expect(facts.find(({ kind }) => kind === 'podium')).toMatchObject({
      places: [{ player: { playerId: underdog!.id } }, { player: { playerId: favourite!.id } }],
    });
    expect(facts.find(({ kind }) => kind === 'seed_upset')).toMatchObject({
      winnerSeed: 8,
      loserSeed: 1,
      score: '3-0',
    });
    expect(facts.filter(({ kind }) => kind === 'rating_upset')).toEqual([]);
  } finally {
    await close();
  }
});
