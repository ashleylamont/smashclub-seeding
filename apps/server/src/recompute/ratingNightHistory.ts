import { playerRatings, ratingEvents, ratingNights, tournaments, type Db } from '@smashclub/db';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { hasRatingNightLedger, latestCompletedRecompute } from './recompute';
import {
  matchesFullFit,
  publicPostNightEstimate,
  readNightFitAvailability,
} from './nightFitAvailability';

export function readRatingNightHistory(db: Db, playerIds: string[]) {
  return db.transaction(
    async (tx) => {
      const run = await latestCompletedRecompute(tx);
      if (!run) return { mode: 'unavailable' as const, eventKeys: [], points: [] };
      const { after } = await readNightFitAvailability(tx, run);

      if (hasRatingNightLedger(run.stats)) {
        const points = await tx
          .select({
            playerId: ratingNights.playerId,
            eventKey: ratingNights.eventKey,
            played: ratingNights.played,
            postRating: ratingNights.postRating,
            postRd: ratingNights.postRd,
          })
          .from(ratingNights)
          .where(
            and(eq(ratingNights.recomputeId, run.id), inArray(ratingNights.playerId, playerIds)),
          )
          .orderBy(asc(ratingNights.eventKey), asc(ratingNights.playerId));
        return {
          mode: 'nightly' as const,
          eventKeys: [...new Set(points.map((point) => point.eventKey))],
          points: points.map((point) => ({
            ...point,
            ...publicPostNightEstimate(point, after.has(point.eventKey)),
          })),
        };
      }

      // Pre-ledger runs have estimates only for players with rated sets that night.
      // Keep the full calendar so an unplayed night separates adjacent points.
      const eventKey = sql<string>`to_char(${tournaments.eventDate} at time zone 'UTC', 'YYYY-MM-DD')`;
      const played = and(
        eq(ratingEvents.recomputeId, run.id),
        eq(ratingEvents.isDecay, false),
        isNotNull(ratingEvents.won),
        isNotNull(tournaments.eventDate),
      );
      const calendar = await tx
        .selectDistinct({ eventKey })
        .from(ratingEvents)
        .innerJoin(tournaments, eq(ratingEvents.tournamentId, tournaments.id))
        .where(played)
        .orderBy(eventKey);
      const estimates = await tx
        .selectDistinctOn([ratingEvents.playerId, eventKey], {
          playerId: ratingEvents.playerId,
          eventKey,
          postRating: ratingEvents.postRating,
          postRd: ratingEvents.postRd,
          rating: playerRatings.rating,
          rd: playerRatings.rd,
        })
        .from(ratingEvents)
        .innerJoin(tournaments, eq(ratingEvents.tournamentId, tournaments.id))
        .innerJoin(
          playerRatings,
          and(
            eq(ratingEvents.recomputeId, playerRatings.recomputeId),
            eq(ratingEvents.playerId, playerRatings.playerId),
          ),
        )
        .where(and(played, inArray(ratingEvents.playerId, playerIds)))
        .orderBy(ratingEvents.playerId, eventKey, desc(ratingEvents.seq));
      return {
        mode: 'played' as const,
        eventKeys: calendar.map((night) => night.eventKey),
        points: estimates.map(({ rating, rd, ...point }) => ({
          ...point,
          ...publicPostNightEstimate(
            point,
            after.has(point.eventKey) && matchesFullFit(point, { rating, rd }),
          ),
          played: true,
        })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
