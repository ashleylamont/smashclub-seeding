import { and, asc, eq, sql } from 'drizzle-orm';
import {
  playerRatings,
  players,
  ratingEvents,
  ratingNights,
  sets,
  tournaments,
  type Db,
} from '@smashclub/db';
import { eventKeyOf } from '@smashclub/engine';
import { includesResultStage, publicPlayerName, unplayedResultOutcome } from '@smashclub/shared';
import { playerSetScore } from '../events/playerSetScore';
import {
  matchesFullFit,
  publicPostNightEstimate,
  publicRatingNights,
  readNightFitAvailability,
  recordedRatingEventNight,
  type PublicRatingNight,
} from '../recompute/nightFitAvailability';
import { hasRatingNightLedger, latestCompletedRecompute } from '../recompute/recompute';
import { readWhrRunProvenance } from '../recompute/whrProvenance';
import {
  verifiedScorelineEvidence,
  type PublishedScorelineEvidence,
} from '../recompute/scorelineEvidence';

export async function readPlayerRating(db: Db, playerId: string, verifiedFits = false) {
  const run = await latestCompletedRecompute(db);
  const recomputeId = run?.id ?? null;
  let ratingRow = null;
  let events: Record<string, unknown>[] = [];
  const doublesEvidence = new Map<string, PublishedScorelineEvidence>();
  let nights: PublicRatingNight[] = [];
  const gamesWeight = verifiedFits
    ? ((run && (await readWhrRunProvenance(db, run.id))?.settings.whrGamesWeight) ?? null)
    : undefined;
  if (run) {
    const { id: recomputeId } = run;
    const availability = verifiedFits ? await readNightFitAvailability(db, run) : null;
    const hasLedger = hasRatingNightLedger(run.stats);
    const [rating] = await db
      .select()
      .from(playerRatings)
      .where(and(eq(playerRatings.recomputeId, recomputeId), eq(playerRatings.playerId, playerId)));
    ratingRow = rating ?? null;

    const nightRows = await db
      .select({
        eventKey: ratingNights.eventKey,
        played: ratingNights.played,
        preRating: ratingNights.preRating,
        postRating: ratingNights.postRating,
        postRd: ratingNights.postRd,
        revisedRating: ratingNights.revisedRating,
        prePenalty: ratingNights.prePenalty,
        postPenalty: ratingNights.postPenalty,
      })
      .from(ratingNights)
      .where(and(eq(ratingNights.recomputeId, recomputeId), eq(ratingNights.playerId, playerId)))
      .orderBy(asc(ratingNights.eventKey));
    nights = publicRatingNights(nightRows, availability);

    const opponents = players; // alias for readability in the join below
    const eventRows = await db
      .select({
        seq: ratingEvents.seq,
        isDecay: ratingEvents.isDecay,
        won: ratingEvents.won,
        postRating: ratingEvents.postRating,
        postRd: ratingEvents.postRd,
        weight: ratingEvents.weight,
        /** WHR only: the current fit's hindsight estimate at this night. */
        revisedRating: ratingEvents.revisedRating,
        revisedSd: ratingEvents.revisedSd,
        /** The played set that produced this event; null for inactivity decay. */
        setId: ratingEvents.setId,
        /** Pool or bracket stage for the played set; null for decay. */
        resultStage: sets.resultStage,
        resultState: sets.state,
        resultExcluded: sets.excludedFromRatings,
        resultsMode: tournaments.resultsMode,
        scoreCsv: sets.scoresCsv,
        resultRaw: sets.raw,
        resultWinner: sets.winner,
        p1PlayerId: sets.p1PlayerId,
        p2PlayerId: sets.p2PlayerId,
        tournamentId: ratingEvents.tournamentId,
        tournamentName: tournaments.name,
        competitionFormat: tournaments.competitionFormat,
        tournamentDate: tournaments.eventDate,
        isRookie: tournaments.isRookie,
        opponentPlayerId: ratingEvents.opponentPlayerId,
        opponentCanonicalName: opponents.canonicalName,
        opponentDisplayName: opponents.displayName,
        matchedNight: ratingNights.eventKey,
      })
      .from(ratingEvents)
      .innerJoin(tournaments, eq(ratingEvents.tournamentId, tournaments.id))
      .leftJoin(ratingNights, availability && hasLedger ? recordedRatingEventNight : sql`false`)
      .leftJoin(sets, eq(ratingEvents.setId, sets.id))
      .leftJoin(opponents, eq(ratingEvents.opponentPlayerId, opponents.id))
      .where(and(eq(ratingEvents.recomputeId, recomputeId), eq(ratingEvents.playerId, playerId)))
      .orderBy(asc(ratingEvents.seq));
    events = eventRows.map(
      ({
        opponentCanonicalName,
        opponentDisplayName,
        scoreCsv,
        resultRaw,
        resultWinner,
        resultState,
        resultExcluded,
        resultsMode,
        p1PlayerId,
        p2PlayerId,
        matchedNight,
        ...row
      }) => {
        if (row.competitionFormat === 'doubles' && row.setId)
          doublesEvidence.set(row.setId, { weight: row.weight, won: row.won });
        const tournamentDate = row.tournamentDate?.toISOString() ?? null;
        const side = p1PlayerId === playerId ? 1 : p2PlayerId === playerId ? 2 : null;
        const singles = row.competitionFormat === 'singles';
        const currentWon =
          singles && side !== null && (resultWinner === 1 || resultWinner === 2)
            ? resultWinner === side
            : null;
        const checkEvidence = verifiedFits && singles && row.setId !== null && !row.isDecay;
        const evidence = checkEvidence
          ? verifiedScorelineEvidence(
              {
                scoresCsv: scoreCsv,
                raw: resultRaw,
                winner: resultWinner,
                eligible:
                  resultState === 'complete' &&
                  resultExcluded === false &&
                  tournamentDate !== null &&
                  p1PlayerId !== null &&
                  p2PlayerId !== null &&
                  p1PlayerId !== p2PlayerId &&
                  row.resultStage !== null &&
                  includesResultStage(resultsMode, row.resultStage),
              },
              row,
              currentWon,
              gamesWeight ?? null,
            )
          : undefined;
        return {
          ...row,
          ...evidence,
          ...(availability &&
            publicPostNightEstimate(
              row,
              tournamentDate !== null &&
                availability.after.has(eventKeyOf(tournamentDate)) &&
                (hasLedger ? matchedNight !== null : matchesFullFit(row, rating)),
            )),
          ...(checkEvidence && currentWon !== null && currentWon !== row.won && { currentWon }),
          ...(checkEvidence &&
            currentWon !== null &&
            unplayedResultOutcome(scoreCsv, resultRaw) === 'forfeit' && { forfeit: true }),
          score:
            currentWon !== null && side !== null && (checkEvidence || row.won === currentWon)
              ? playerSetScore(scoreCsv, resultRaw, side)
              : null,
          tournamentDate,
          opponentName: opponentCanonicalName
            ? publicPlayerName({
                displayName: opponentDisplayName,
                canonicalName: opponentCanonicalName,
              })
            : null,
        };
      },
    );
  }
  return { recomputeId, ratingRow, events, nights, doublesEvidence, gamesWeight };
}
