import type { Match, SupersededPlayedSet, TournamentResult, TournamentState } from './schemas';

type MatchEvidence = { match: Match; superseded?: SupersededPlayedSet };

/** Actual history includes a superseded set before its replay. Advancement uses
 * only the active matches in the sealed draw. */
export function resultMatchEvidence(result: TournamentResult): MatchEvidence[] {
  const byReplacement = new Map(
    result.supersededPlayedSets?.map((entry) => [entry.replacementMatchId, entry]),
  );
  return result.matches.flatMap((match) => {
    const superseded = byReplacement.get(match.id);
    return superseded ? [{ match: superseded.match, superseded }, { match }] : [{ match }];
  });
}

export function supersededPlayedSetViews(
  state: TournamentState,
  names: ReadonlyMap<string, string>,
) {
  return state.supersededPlayedSets?.map(({ match, label, replacementMatchId }) => ({
    matchId: match.id,
    replacementMatchId,
    label,
    bracketId: match.bracketId,
    division: match.division,
    stage: match.stage,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    player1Name: names.get(match.player1Id ?? '') ?? 'Player',
    player2Name: names.get(match.player2Id ?? '') ?? 'Player',
    score1: match.score1,
    score2: match.score2,
    winnerId: match.winnerId,
    completedAt: match.completedAt === null ? null : new Date(match.completedAt).toISOString(),
    advancementDisposition: 'superseded' as const,
  }));
}

/** Only native publication sets can carry an explicit superseded route. */
export function hasSupersededAdvancement(raw: unknown) {
  return Boolean(
    raw &&
    typeof raw === 'object' &&
    'provider' in raw &&
    raw.provider === 'native' &&
    'advancementDisposition' in raw &&
    raw.advancementDisposition === 'superseded',
  );
}
