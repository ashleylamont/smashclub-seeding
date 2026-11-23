import { playerRatings, ratingEvents, ratingNights, type Db, type sets } from '@smashclub/db';
import type { RecapSet } from '@smashclub/engine';
import { and, eq, inArray } from 'drizzle-orm';
import { verifiedRankMovementNight } from '../recompute/whrProvenance';

type ResultRow = Pick<
  typeof sets.$inferSelect,
  'id' | 'tournamentId' | 'p1PlayerId' | 'p2PlayerId' | 'winner'
>;

export async function loadRecapRankMovement(
  db: Db,
  run: { id: string; stats: unknown },
  recapDay: string | null,
  recapSets: readonly RecapSet[],
  results: readonly ResultRow[],
) {
  const day = verifiedRankMovementNight(run.stats);
  if (!day || day !== recapDay) return [];

  const included = new Set(
    recapSets
      .filter((set) => set.state === 'complete' && set.winner !== null && !set.excludedFromRatings)
      .map(({ id }) => id),
  );
  const played = new Map(
    results
      .filter(
        ({ id, p1PlayerId, p2PlayerId }) =>
          included.has(id) && p1PlayerId && p2PlayerId && p1PlayerId !== p2PlayerId,
      )
      .map((result) => [result.id, result]),
  );
  if (!played.size) return [];

  // The rating event repeats the night's estimates exactly. Match the
  // recorded result from each side against the run's played-night ledger.
  // Keep unmatched or multiply matched rows so either case fails verification.
  const recordedSides = await db
    .select({
      setId: ratingEvents.setId,
      tournamentId: ratingEvents.tournamentId,
      playerId: ratingEvents.playerId,
      won: ratingEvents.won,
      day: ratingNights.eventKey,
    })
    .from(ratingEvents)
    .leftJoin(
      ratingNights,
      and(
        eq(ratingNights.recomputeId, ratingEvents.recomputeId),
        eq(ratingNights.playerId, ratingEvents.playerId),
        eq(ratingNights.played, true),
        eq(ratingNights.preRating, ratingEvents.preRating),
        eq(ratingNights.postRating, ratingEvents.postRating),
        eq(ratingNights.postRd, ratingEvents.postRd),
      ),
    )
    .where(
      and(
        eq(ratingEvents.recomputeId, run.id),
        eq(ratingEvents.isDecay, false),
        inArray(ratingEvents.setId, [...played.keys()]),
      ),
    );
  if (recordedSides.length !== played.size * 2) return [];

  const seen = new Set<string>();
  for (const row of recordedSides) {
    const result = row.setId && played.get(row.setId);
    if (!result || row.day !== day || result.tournamentId !== row.tournamentId) return [];
    const side =
      row.playerId === result.p1PlayerId ? 1 : row.playerId === result.p2PlayerId ? 2 : null;
    const key = `${result.id}:${row.playerId}`;
    if (!side || row.won !== (result.winner === side) || seen.has(key)) return [];
    seen.add(key);
  }

  return db
    .select({
      playerId: playerRatings.playerId,
      rank: playerRatings.rank,
      previousRank: playerRatings.previousRank,
    })
    .from(playerRatings)
    .where(eq(playerRatings.recomputeId, run.id));
}
