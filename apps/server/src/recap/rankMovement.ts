import { playerRatings, ratingEvents, ratingNights, type Db, type sets } from '@smashclub/db';
import type { RecapSet } from '@smashclub/engine';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { verifiedRankMovementNight } from '../recompute/whrProvenance';

type ResultRow = Pick<
  typeof sets.$inferSelect,
  'id' | 'tournamentId' | 'p1PlayerId' | 'p2PlayerId' | 'winner'
>;

const matchesPlayedNight = and(
  eq(ratingNights.recomputeId, ratingEvents.recomputeId),
  eq(ratingNights.playerId, ratingEvents.playerId),
  eq(ratingNights.played, true),
  eq(ratingNights.preRating, ratingEvents.preRating),
  eq(ratingNights.postRating, ratingEvents.postRating),
  eq(ratingNights.postRd, ratingEvents.postRd),
);

function positiveCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

async function latestRatedSetCount(db: Db, runId: string, day: string, stats: unknown) {
  const {
    whrLatestRatedSetCount,
    events,
    ratingNights: nights,
  } = stats as {
    whrLatestRatedSetCount?: unknown;
    events?: unknown;
    ratingNights?: unknown;
  };
  if (positiveCount(whrLatestRatedSetCount)) return whrLatestRatedSetCount;
  if (whrLatestRatedSetCount !== undefined || !positiveCount(events) || !positiveCount(nights))
    return null;

  // Older publications did not store a latest set count. Their immutable
  // rows can supply it only while both ledgers are still complete.
  const recordedNightCount = db
    .select({ rows: count() })
    .from(ratingNights)
    .where(eq(ratingNights.recomputeId, runId));
  const [ledger] = await db
    .select({
      events: count(),
      nights: sql<number>`(${recordedNightCount})`.mapWith(Number),
      sets: sql<number>`count(distinct ${ratingEvents.setId}) filter (where ${ratingNights.eventKey} is not null and not ${ratingEvents.isDecay})`.mapWith(
        Number,
      ),
    })
    .from(ratingEvents)
    .leftJoin(ratingNights, and(matchesPlayedNight, eq(ratingNights.eventKey, day)))
    .where(eq(ratingEvents.recomputeId, runId));
  return ledger?.events === events && ledger.nights === nights ? ledger.sets : null;
}

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

  // The movement compares two whole boards. A recap of just one part of the
  // rated night cannot attribute that movement to the results it displays.
  if (played.size !== (await latestRatedSetCount(db, run.id, day, run.stats))) return [];

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
    .leftJoin(ratingNights, matchesPlayedNight)
    .where(
      and(
        eq(ratingEvents.recomputeId, run.id),
        eq(ratingEvents.isDecay, false),
        inArray(ratingEvents.setId, [...played.keys()]),
      ),
    );
  if (recordedSides.length !== played.size * 2) return [];

  const seen = new Set<string>();
  const playedPlayerIds = new Set<string>();
  for (const row of recordedSides) {
    const result = row.setId && played.get(row.setId);
    if (!result || row.day !== day || result.tournamentId !== row.tournamentId) return [];
    const side =
      row.playerId === result.p1PlayerId ? 1 : row.playerId === result.p2PlayerId ? 2 : null;
    const key = `${result.id}:${row.playerId}`;
    if (!side || row.won !== (result.winner === side) || seen.has(key)) return [];
    seen.add(key);
    playedPlayerIds.add(row.playerId);
  }

  return db
    .select({
      playerId: playerRatings.playerId,
      rank: playerRatings.rank,
      previousRank: playerRatings.previousRank,
    })
    .from(playerRatings)
    .where(
      and(
        eq(playerRatings.recomputeId, run.id),
        inArray(playerRatings.playerId, [...playedPlayerIds]),
      ),
    );
}
