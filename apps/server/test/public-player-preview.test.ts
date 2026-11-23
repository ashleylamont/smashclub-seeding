import { randomUUID } from 'node:crypto';
import { playerRatings, players, recomputes, sets, tournaments } from '@smashclub/db';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { setPlayerCharacters } from '../src/players/characters';
import { ENGINE_VERSION, runRecompute } from '../src/recompute/recompute';
import { RecomputeTrigger } from '../src/recompute/trigger';
import { appRouter } from '../src/trpc/router';
import { fixtureClient } from './helpers/challongeFixtures';
import { createTestDb } from './helpers/testDb';

it('returns the same published rating and record as the public profile without history or registry data', async () => {
  const { db, close } = await createTestDb();
  try {
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
    const [player, opponent, newcomer, moved] = await db
      .insert(players)
      .values([
        { canonicalName: 'Public Alias Private Family Name', displayName: 'Public Alias' },
        { canonicalName: 'Opponent Private', displayName: 'Opponent' },
        { canonicalName: 'A New Player Private', displayName: 'New player' },
        { canonicalName: 'Former Player Private', displayName: 'Former alias' },
      ])
      .returning();
    await db
      .update(players)
      .set({ status: 'merged', mergedIntoPlayerId: player!.id })
      .where(eq(players.id, moved!.id));
    await setPlayerCharacters(db, player!.id, ['mario', 'kirby']);
    const [tournament] = await db
      .insert(tournaments)
      .values({
        name: 'Archived singles',
        challongeSlug: 'archived-singles',
        challongeState: 'complete',
        eventDate: new Date('2026-10-02T08:30:00Z'),
      })
      .returning();
    await db.insert(sets).values(
      [1, 2, 3].map((match) => ({
        tournamentId: tournament!.id,
        state: 'complete',
        challongeMatchId: match,
        p1PlayerId: player!.id,
        p2PlayerId: opponent!.id,
        winner: match === 3 ? 2 : 1,
        scoresCsv: match === 3 ? '1-2' : '2-1',
      })),
    );
    await runRecompute(db);
    await db
      .update(playerRatings)
      .set({ clubRating: 1596.25 })
      .where(eq(playerRatings.playerId, player!.id));
    await db.insert(recomputes).values({
      status: 'running',
      model: 'whr',
      engineVersion: ENGINE_VERSION,
      startedAt: new Date('2099-01-01'),
      settingsSnapshot: {},
    });

    const profile = await api.player({ playerId: player!.id });
    if (!profile || 'redirectTo' in profile || !profile.rating)
      throw new Error('Expected a rated public profile for the test player');
    expect(await api.playerPreview({ playerId: player!.id })).toEqual({
      profile: {
        name: 'Public Alias',
        characters: ['mario', 'kirby'],
        rating: {
          clubRating: 1596.25,
          wins: 2,
          losses: 1,
          isProvisional: profile.rating.isProvisional,
        },
      },
      redirectTo: null,
    });
    expect(await api.playerPreview({ playerId: newcomer!.id })).toEqual({
      profile: { name: 'New player', characters: [], rating: null },
      redirectTo: null,
    });
    expect(await api.playerPreview({ playerId: moved!.id })).toEqual({
      profile: null,
      redirectTo: player!.id,
    });
    expect(await api.playerPreview({ playerId: randomUUID() })).toBeNull();
  } finally {
    await close();
  }
});
