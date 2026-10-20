import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { sets, tournaments, type Db } from '@smashclub/db';
import { parseScoresCsv, type EngineSet, type EngineTournament } from '@smashclub/engine';
import { includesResultStage, isPlayedRatingResult } from '@smashclub/shared';
import { nativeHistory } from '../events/nativeHistory';

export async function loadSinglesHistory(db: Db) {
  const { superseded } = await nativeHistory(db);

  const tournamentRows = await db
    .select({
      id: tournaments.id,
      eventDate: tournaments.eventDate,
      isRookie: tournaments.isRookie,
      challongeId: tournaments.challongeId,
      resultsMode: tournaments.resultsMode,
    })
    .from(tournaments)
    .where(and(isNotNull(tournaments.eventDate), eq(tournaments.competitionFormat, 'singles')));

  const engineTournaments: EngineTournament[] = tournamentRows.map((row) => ({
    id: row.id,
    eventDate: row.eventDate!.toISOString(),
    isRookie: row.isRookie,
    challongeId: row.challongeId,
  }));
  const tournamentIds = engineTournaments.map((t) => t.id);
  const modes = new Map(tournamentRows.map((t) => [t.id, t.resultsMode]));

  const setRows = tournamentIds.length
    ? await db
        .select()
        .from(sets)
        .where(
          and(
            inArray(sets.tournamentId, tournamentIds),
            eq(sets.state, 'complete'),
            eq(sets.excludedFromRatings, false),
            isNotNull(sets.p1PlayerId),
            isNotNull(sets.p2PlayerId),
            isNotNull(sets.winner),
          ),
        )
    : [];

  const engineSets: EngineSet[] = setRows
    .filter((row) => !superseded.has(row.tournamentId))
    .filter((row) => includesResultStage(modes.get(row.tournamentId) ?? 'auto', row.resultStage))
    .filter((row) => row.p1PlayerId !== row.p2PlayerId)
    /*
     * A `99-0` is a bye — nobody played it, so it cannot move a rating, and it
     * must not reach the game-count weighting below as the most decisive set in
     * club history. The sync marks these excluded, but that is a stored verdict
     * on rows that may predate the rule; the scoreline is the evidence, so it
     * is re-read here and the ratings come out right on the next recompute
     * rather than on the next re-sync.
     */
    .filter((row) => isPlayedRatingResult(row.scoresCsv, row.raw))
    .map((row) => {
      // Game counts feed WHR's evidence weighting (a 3-0 outrates a 3-2);
      // Unplayed scores were excluded above; unknown played scores count once.
      const score = parseScoresCsv(row.scoresCsv);
      return {
        id: row.id,
        tournamentId: row.tournamentId,
        p1PlayerId: row.p1PlayerId!,
        p2PlayerId: row.p2PlayerId!,
        winner: row.winner as 1 | 2,
        suggestedPlayOrder: row.suggestedPlayOrder,
        completedAt: row.completedAt?.toISOString() ?? null,
        challongeMatchId: row.challongeMatchId,
        p1Games: score.unknown ? null : score.p1,
        p2Games: score.unknown ? null : score.p2,
      };
    });

  return { engineSets, engineTournaments };
}
