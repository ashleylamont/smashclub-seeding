import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { players, ratingNights, recomputes, sets, tournaments, type Db } from '@smashclub/db';
import { fitWhrPrefix } from '@smashclub/engine';
import { defaultRatingSettings } from '@smashclub/shared';
import { loadEnv } from '../src/env';
import { runRecompute } from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { loadWhrHistoryThroughDay } from '../src/recompute/whrProvenance';
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
        {
          name: 'Unrated night',
          challongeSlug: 'rating-night-history-unrated',
          challongeState: 'complete',
          eventDate: new Date('2026-07-02T08:00:00Z'),
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
    const { recomputeId } = await runRecompute(db);
    const api = publicApi(db);
    const history = await api.ratingHistory({ verifiedFits: true });
    expect(history.events.map(({ playerId }) => playerId)).not.toContain(unrated!.id);
    expect(history.events.filter(({ playerId }) => playerId === returning!.id)).toHaveLength(1);
    const profile = await api.player({ verifiedFits: true, playerId: returning!.id });
    if (!profile || !('nights' in profile) || !profile.nights) throw new Error('Missing nights.');
    expect(profile.nights).toHaveLength(2);
    expect(profile.nights[0]).toMatchObject({
      eventKey: '2026-05-28',
      postRating: expect.any(Number),
    });
    expect(profile.nights[1]).toMatchObject({ eventKey: '2026-08-27', played: false });
    expect(profile.nights[1]!.postRd).not.toBe(profile.nights[0]!.postRd);

    const result = await api.ratingNightHistory({
      verifiedFits: true,
      playerIds: [returning!.id, debut!.id, unrated!.id],
    });
    expect(result).toMatchObject({
      mode: 'nightly',
      eventKeys: ['2026-05-28', '2026-08-27'],
    });
    const { points } = result;
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
      api.ratingNightHistory({ verifiedFits: true, playerIds: Array(9).fill(returning!.id) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await api.ratingNightHistory({ verifiedFits: true, playerIds: [unrated!.id] })).toEqual({
      mode: 'nightly',
      eventKeys: [],
      points: [],
    });

    // A nightly run predating convergence metadata cannot verify older prefixes.
    await db
      .update(recomputes)
      .set({ stats: { ratingNights: 1 } })
      .where(eq(recomputes.id, recomputeId));
    const oldNightly = await api.player({ verifiedFits: true, playerId: returning!.id });
    if (!oldNightly || !('nights' in oldNightly)) throw new Error('Missing legacy profile.');
    expect(oldNightly.nights).toMatchObject([
      { preRating: expect.any(Number), postRating: null, postRd: null },
      {
        preRating: null,
        postRating: profile.nights[1]!.postRating,
        postRd: profile.nights[1]!.postRd,
      },
    ]);

    // Reproduce a pre-ledger WHR run. Another player's set still establishes a club night.
    await db.delete(ratingNights).where(eq(ratingNights.recomputeId, recomputeId));
    await db.update(recomputes).set({ stats: {} }).where(eq(recomputes.id, recomputeId));
    expect(
      await api.ratingNightHistory({ verifiedFits: true, playerIds: [returning!.id] }),
    ).toEqual({
      mode: 'played',
      eventKeys: ['2026-05-28', '2026-08-27'],
      points: [
        {
          playerId: returning!.id,
          eventKey: '2026-05-28',
          postRating: null,
          postRd: null,
          played: true,
        },
      ],
    });
  } finally {
    await close();
  }
});

it('withholds a capped historical fit and keeps a later converged night', async () => {
  const { db, close } = await createTestDb();
  try {
    const [player, opponent, newPlayer, newOpponent] = await db
      .insert(players)
      .values([
        { canonicalName: 'Returning Player' },
        { canonicalName: 'First Opponent' },
        { canonicalName: 'New Player' },
        { canonicalName: 'New Opponent' },
      ])
      .returning();
    const firstKey = '2026-01-01';
    const lastKey = '2026-01-08';
    const firstDate = new Date(`${firstKey}T08:00:00Z`);
    const lastDate = new Date(`${lastKey}T08:00:00Z`);
    const [first, last] = await db
      .insert(tournaments)
      .values([
        {
          name: 'First night',
          challongeSlug: 'capped-fit-first',
          challongeState: 'complete',
          eventDate: firstDate,
        },
        {
          name: 'Last night',
          challongeSlug: 'capped-fit-last',
          challongeState: 'complete',
          eventDate: lastDate,
        },
      ])
      .returning();
    const match = (tournamentId: string, index: number, winner: 1 | 2) => ({
      tournamentId,
      challongeMatchId: index + 1,
      p1PlayerId: player!.id,
      p2PlayerId: opponent!.id,
      winner,
      scoresCsv: winner === 1 ? '3-0' : '0-3',
      state: 'complete',
    });
    await db
      .insert(sets)
      .values([
        ...Array.from({ length: 68 }, (_, index) => match(first!.id, index, index < 38 ? 1 : 2)),
        ...Array.from({ length: 9 }, (_, index) => match(last!.id, index, 2)),
        { ...match(last!.id, 9, 1), p1PlayerId: newPlayer!.id, p2PlayerId: newOpponent!.id },
      ]);
    await runRecompute(db);
    const history = await loadWhrHistoryThroughDay(db, lastDate, defaultRatingSettings);
    if (!history) throw new Error('Missing fixture fit inputs.');
    expect([
      fitWhrPrefix(history, firstKey).converged,
      fitWhrPrefix(history, lastKey).converged,
    ]).toEqual([false, true]);

    const api = publicApi(db);
    const oldProfile = await api.player({ playerId: player!.id });
    if (!oldProfile || !('nights' in oldProfile) || !oldProfile.nights)
      throw new Error('Missing older profile response.');
    const capped = oldProfile.nights[0]!;
    expect(capped).toMatchObject({
      eventKey: firstKey,
      postRating: expect.any(Number),
      postRd: expect.any(Number),
    });
    expect(oldProfile.nights[1]!.preRating).toBeTypeOf('number');
    expect(oldProfile.events[0]).toMatchObject({
      postRating: capped.postRating,
      postRd: capped.postRd,
    });
    expect((await api.ratingNightHistory({ playerIds: [player!.id] })).points[0]).toMatchObject({
      eventKey: firstKey,
      postRating: capped.postRating,
      postRd: capped.postRd,
    });
    expect(
      (await api.ratingHistory()).events.find((event) => event.playerId === player!.id),
    ).toMatchObject({
      eventKey: firstKey,
      postRating: capped.postRating,
      postRd: capped.postRd,
    });

    const profile = await api.player({ verifiedFits: true, playerId: player!.id });
    if (!profile || !('nights' in profile) || !profile.rating) throw new Error('Missing profile.');
    expect(profile.nights).toMatchObject([
      {
        eventKey: firstKey,
        played: true,
        preRating: expect.any(Number),
        postRating: null,
        postRd: null,
        revisedRating: expect.any(Number),
        prePenalty: 0,
        postPenalty: 0,
      },
      {
        eventKey: lastKey,
        played: true,
        preRating: null,
        postRating: profile.rating.skillRating,
        postRd: expect.any(Number),
        revisedRating: profile.rating.skillRating,
      },
    ]);
    expect(profile.events).toHaveLength(77);
    const form = await api.ratingHistory({ verifiedFits: true });
    const played = form.events.filter(({ playerId }) => playerId === player!.id);
    expect(played).toHaveLength(77);
    expect(played[0]).toMatchObject({
      eventKey: firstKey,
      won: expect.any(Boolean),
      postRating: null,
      postRd: null,
    });
    expect(played.at(-1)).toMatchObject({
      eventKey: lastKey,
      won: false,
      postRating: profile.rating.skillRating,
    });
    expect(profile.events[0]).toMatchObject({
      won: expect.any(Boolean),
      postRating: null,
      postRd: null,
      revisedRating: expect.any(Number),
    });
    expect(profile.events[76]).toMatchObject({
      won: false,
      postRating: profile.rating.skillRating,
    });
    expect(await api.ratingNightHistory({ verifiedFits: true, playerIds: [player!.id] })).toEqual({
      mode: 'nightly',
      eventKeys: [firstKey, lastKey],
      points: profile.nights.map(({ eventKey, played, postRating, postRd }) => ({
        playerId: player!.id,
        eventKey,
        played,
        postRating,
        postRd,
      })),
    });
    const debut = await api.player({ verifiedFits: true, playerId: newPlayer!.id });
    if (!debut || !('nights' in debut)) throw new Error('Missing debut profile.');
    expect(debut.nights).toMatchObject([
      { eventKey: lastKey, preRating: 1500, postRating: expect.any(Number) },
    ]);

    // The organiser can change a date before the queued rating update takes effect.
    await db.update(tournaments).set({ eventDate: lastDate }).where(eq(tournaments.id, first!.id));
    const moved = await api.player({ verifiedFits: true, playerId: player!.id });
    if (!moved || !('nights' in moved) || !moved.nights)
      throw new Error('Missing profile after date edit.');
    expect(moved.events[0]).toMatchObject({
      won: expect.any(Boolean),
      postRating: null,
      postRd: null,
    });
    expect(moved.events.at(-1)).toMatchObject({ postRating: profile.rating.rating });
    const movedForm = (await api.ratingHistory({ verifiedFits: true })).events.filter(
      ({ playerId }) => playerId === player!.id,
    );
    expect(movedForm[0]).toMatchObject({ eventKey: lastKey, postRating: null, postRd: null });
    expect(movedForm.at(-1)).toMatchObject({
      eventKey: lastKey,
      postRating: profile.rating.rating,
    });

    await db.update(tournaments).set({ eventDate: null }).where(eq(tournaments.id, first!.id));
    const undatedForm = (await api.ratingHistory({ verifiedFits: true })).events.filter(
      ({ playerId }) => playerId === player!.id,
    );
    expect(undatedForm[0]).toMatchObject({
      eventKey: null,
      won: expect.any(Boolean),
      postRating: null,
      postRd: null,
    });
  } finally {
    await close();
  }
});
