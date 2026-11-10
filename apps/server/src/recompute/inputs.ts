import { and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { sets, tournamentParticipants, tournaments, type Db } from '@smashclub/db';
import { parseScoresCsv, type EngineSet, type EngineTournament } from '@smashclub/engine';
import { includesResultStage, isPlayedRatingResult, type UnplayedOutcome } from '@smashclub/shared';
import { historicalPlayerIds } from '../identity/playerIds';
import { loadNativeHistory } from '../events/nativeHistory';

interface WhrHistoryBudget {
  before: Date;
  maxTournaments: number;
  maxSets: number;
  maxNativeRows: number;
}

interface WhrHistory {
  engineSets: EngineSet[];
  engineTournaments: EngineTournament[];
}

export async function loadSinglesHistory(db: Db): Promise<WhrHistory> {
  return (await loadHistory(db, false))!;
}

export function loadWhrHistory(db: Db): Promise<WhrHistory>;
export function loadWhrHistory(db: Db, budget: WhrHistoryBudget): Promise<WhrHistory | null>;
export function loadWhrHistory(db: Db, budget?: WhrHistoryBudget) {
  return loadHistory(db, true, budget);
}

const first = alias(tournamentParticipants, 'first_entrant');
const second = alias(tournamentParticipants, 'second_entrant');

async function loadHistory(
  db: Db,
  includeDoubles: boolean,
  budget?: WhrHistoryBudget,
): Promise<WhrHistory | null> {
  const native = await loadNativeHistory(db, budget?.maxNativeRows);
  if (!native) return null;

  const tournamentQuery = db
    .select({
      id: tournaments.id,
      eventDate: tournaments.eventDate,
      isRookie: tournaments.isRookie,
      challongeId: tournaments.challongeId,
      resultsMode: tournaments.resultsMode,
      competitionFormat: tournaments.competitionFormat,
    })
    .from(tournaments)
    .where(
      and(
        isNotNull(tournaments.eventDate),
        includeDoubles ? undefined : eq(tournaments.competitionFormat, 'singles'),
        budget ? lt(tournaments.eventDate, budget.before) : undefined,
      ),
    );
  const tournamentRows = await (budget
    ? tournamentQuery.limit(budget.maxTournaments + 1)
    : tournamentQuery);
  if (budget && tournamentRows.length > budget.maxTournaments) return null;

  const engineTournaments: EngineTournament[] = tournamentRows.map((row) => ({
    id: row.id,
    eventDate: row.eventDate!.toISOString(),
    isRookie: row.isRookie,
    challongeId: row.challongeId,
  }));
  const tournamentIds = engineTournaments.map((t) => t.id);
  const sources = new Map(tournamentRows.map((t) => [t.id, t]));
  const doublesIds = tournamentRows
    .filter((t) => t.competitionFormat === 'doubles')
    .map((t) => t.id);
  const canonical = doublesIds.length ? await historicalPlayerIds(db) : (id: string) => id;

  const setQuery = db
    .select({
      id: sets.id,
      tournamentId: sets.tournamentId,
      p1PlayerId: sets.p1PlayerId,
      p2PlayerId: sets.p2PlayerId,
      firstMembers: first.memberPlayerIds,
      secondMembers: second.memberPlayerIds,
      winner: sets.winner,
      suggestedPlayOrder: sets.suggestedPlayOrder,
      completedAt: sets.completedAt,
      challongeMatchId: sets.challongeMatchId,
      resultStage: sets.resultStage,
      scoresCsv: sets.scoresCsv,
      // Only the recognised top-level outcome reaches the shared classifier.
      // Provider payloads and arbitrary values of `outcome` stay in the database.
      storedOutcome: sql<UnplayedOutcome | null>`case ${sets.raw}->'outcome'
        when '"bye"'::jsonb then 'bye'
        when '"forfeit"'::jsonb then 'forfeit'
      end`,
    })
    .from(sets)
    .leftJoin(
      first,
      and(eq(sets.p1ParticipantId, first.id), eq(sets.tournamentId, first.tournamentId)),
    )
    .leftJoin(
      second,
      and(eq(sets.p2ParticipantId, second.id), eq(sets.tournamentId, second.tournamentId)),
    )
    .where(
      and(
        inArray(sets.tournamentId, tournamentIds),
        eq(sets.state, 'complete'),
        eq(sets.excludedFromRatings, false),
        or(
          and(isNotNull(sets.p1PlayerId), isNotNull(sets.p2PlayerId)),
          doublesIds.length
            ? and(
                inArray(sets.tournamentId, doublesIds),
                isNotNull(first.memberPlayerIds),
                isNotNull(second.memberPlayerIds),
              )
            : undefined,
        ),
        isNotNull(sets.winner),
      ),
    );
  const setRows = tournamentIds.length
    ? await (budget ? setQuery.limit(budget.maxSets + 1) : setQuery)
    : [];
  if (budget && setRows.length > budget.maxSets) return null;

  const engineSets: EngineSet[] = setRows
    .filter((row) => !native.superseded.has(row.tournamentId))
    .filter((row) =>
      includesResultStage(sources.get(row.tournamentId)!.resultsMode, row.resultStage),
    )
    /*
     * A `99-0` is a bye — nobody played it, so it cannot move a rating, and it
     * must not reach the game-count weighting below as the most decisive set in
     * club history. The sync marks these excluded, but that is a stored verdict
     * on rows that may predate the rule; the scoreline is the evidence, so it
     * is re-read here and the ratings come out right on the next recompute
     * rather than on the next re-sync.
     */
    .filter((row) => isPlayedRatingResult(row.scoresCsv, { outcome: row.storedOutcome }))
    .flatMap((row): EngineSet[] => {
      if (row.winner !== 1 && row.winner !== 2) return [];
      let { p1PlayerId, p2PlayerId } = row;
      let partnerIds: EngineSet['partnerIds'];
      if (sources.get(row.tournamentId)!.competitionFormat === 'doubles') {
        const a = row.firstMembers?.map(canonical);
        const b = row.secondMembers?.map(canonical);
        if (!a || !b || a.length !== 2 || b.length !== 2 || new Set([...a, ...b]).size !== 4)
          return [];
        p1PlayerId = a[0]!;
        p2PlayerId = b[0]!;
        partnerIds = [a[1]!, b[1]!];
      }
      if (!p1PlayerId || !p2PlayerId || p1PlayerId === p2PlayerId) return [];
      // Game counts feed WHR's evidence weighting (a 3-0 outrates a 3-2);
      // Unplayed scores were excluded above; unknown played scores count once.
      const score = parseScoresCsv(row.scoresCsv);
      return [
        {
          id: row.id,
          tournamentId: row.tournamentId,
          p1PlayerId,
          p2PlayerId,
          ...(partnerIds ? { partnerIds } : {}),
          winner: row.winner,
          suggestedPlayOrder: row.suggestedPlayOrder,
          completedAt: row.completedAt?.toISOString() ?? null,
          challongeMatchId: row.challongeMatchId,
          p1Games: score.unknown ? null : score.p1,
          p2Games: score.unknown ? null : score.p2,
        },
      ];
    });

  return { engineSets, engineTournaments };
}
