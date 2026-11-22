import { expect, it } from 'vitest';
import { players, sets, tournaments } from '@smashclub/db';
import { loadEnv } from '../src/env';
import { runRecompute } from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { appRouter } from '../src/trpc/router';
import { fixtureClient } from './helpers/challongeFixtures';
import { createTestDb } from './helpers/testDb';

it('returns the same published night estimates as the profile for selected players only', async () => {
  const { db, close } = await createTestDb();
  try {
    const [returning, present, debut, unrated] = await db
      .insert(players)
      .values([
        { canonicalName: 'Returning Player' },
        { canonicalName: 'Both Nights' },
        { canonicalName: 'First Rated' },
        { canonicalName: 'Never Rated' },
      ])
      .returning();
    const [first, second] = await db
      .insert(tournaments)
      .values([
        {
          name: 'First night',
          challongeSlug: 'rating-night-history-first',
          challongeState: 'complete',
          eventDate: new Date('2026-05-28T08:00:00Z'),
        },
        {
          name: 'Second night',
          challongeSlug: 'rating-night-history-second',
          challongeState: 'complete',
          eventDate: new Date('2026-08-27T08:00:00Z'),
        },
      ])
      .returning();
    await db.insert(sets).values([
      {
        tournamentId: first!.id,
        challongeMatchId: 1,
        state: 'complete',
        p1PlayerId: returning!.id,
        p2PlayerId: present!.id,
        winner: 1,
        scoresCsv: '3-0',
      },
      {
        tournamentId: second!.id,
        challongeMatchId: 2,
        state: 'complete',
        p1PlayerId: present!.id,
        p2PlayerId: debut!.id,
        winner: 1,
        scoresCsv: '3-0',
      },
    ]);
    await runRecompute(db);
    const api = appRouter.createCaller({
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
    const history = await api.ratingHistory();
    expect(history.events.map(({ playerId }) => playerId)).not.toContain(unrated!.id);
    expect(history.events.filter(({ playerId }) => playerId === returning!.id)).toHaveLength(1);
    const profile = await api.player({ playerId: returning!.id });
    if (!profile || !('nights' in profile) || !profile.nights) throw new Error('Missing nights.');
    expect(profile.nights).toHaveLength(2);
    expect(profile.nights[1]).toMatchObject({ eventKey: '2026-08-27', played: false });
    expect(profile.nights[1]!.postRd).not.toBe(profile.nights[0]!.postRd);

    const points = await api.ratingNightHistory({
      playerIds: [returning!.id, debut!.id, unrated!.id],
    });
    expect(points).toHaveLength(3);
    expect(points.filter(({ playerId }) => playerId === returning!.id)).toEqual(
      profile.nights.map(({ eventKey, played, postRating, postRd }) => ({
        playerId: returning!.id,
        eventKey,
        played,
        postRating,
        postRd,
      })),
    );
    expect(points.find(({ playerId }) => playerId === debut!.id)).toMatchObject({
      eventKey: '2026-08-27',
      played: true,
    });
    await expect(
      api.ratingNightHistory({ playerIds: Array(9).fill(returning!.id) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  } finally {
    await close();
  }
});
