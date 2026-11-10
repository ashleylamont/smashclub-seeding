import { expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { playerRatings, type Db } from '@smashclub/db';
import { runRecompute } from '../../src/recompute/recompute';
import type { appRouter } from '../../src/trpc/router';

export async function expectDoublesRecapAndHistory(
  api: ReturnType<typeof appRouter.createCaller>['public'],
  slug: string,
  playerId: string,
  teammateName: string | null,
) {
  const profile = await api.player({ playerId });
  if (!profile?.doublesMatches) throw new Error('Missing player profile');
  expect(profile.doublesResults).toHaveLength(1);
  expect(profile.doublesMatches).toHaveLength(3);
  expect(profile.doublesMatches[0]).toMatchObject({
    format: 'doubles',
    tournamentSlug: slug,
    teammateName,
    score: expect.stringMatching(/^(?:2–0|0–2)$/),
  });
  expect(profile.rating).toMatchObject({ matchCount: 3 });
  expect(profile.doublesMatches.every((match) => match.ratingWeight !== null)).toBe(true);
  const impact = await api.whrResultImpact({
    playerId,
    setId: profile.doublesMatches[0]!.setId,
    recomputeId: profile.recomputeId!,
  });
  expect(impact).toMatchObject({ status: 'available', forecast: null });
  const recap = await api.recap({ slug });
  expect(recap).toMatchObject({
    competitionFormat: 'doubles',
    entrants: 4,
    setsPlayed: 6,
    coverage: { unresolvedEntrants: 0, unlinkedPlayedSets: 0 },
  });
  const podium = recap?.facts.find(({ fact }) => fact.kind === 'podium')?.fact;
  expect(podium).toMatchObject({
    kind: 'podium',
    places: expect.arrayContaining([
      expect.objectContaining({
        place: 1,
        player: expect.objectContaining({
          name: expect.stringContaining('Pair 3'),
          playerId: null,
        }),
      }),
    ]),
  });
  expect(JSON.stringify([recap, profile.doublesMatches])).not.toContain('Private Surname');
}

export async function publishedPlayerRating(db: Db, playerId: string) {
  const { recomputeId } = await runRecompute(db);
  const [rating] = await db
    .select()
    .from(playerRatings)
    .where(and(eq(playerRatings.recomputeId, recomputeId), eq(playerRatings.playerId, playerId)));
  return rating;
}
