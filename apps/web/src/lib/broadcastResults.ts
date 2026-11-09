import type { LiveMatch } from './eventDisplay';
import { linkedFinalCaption } from './linkedFinalCaption';
import { recordedByeWinner } from './matchPresentation';

export type ResultMatch = LiveMatch & {
  resultUpdatedAt?: string | Date | null;
};
export type ResultNotice = { matchId: string; fingerprint: string; kind: 'result' | 'correction' };
export function resultFingerprint(match: ResultMatch): string {
  return JSON.stringify([
    match.status,
    match.player1Id,
    match.player2Id,
    match.score1,
    match.score2,
    match.winnerId,
    match.outcome,
  ]);
}
export function recentResults(matches: readonly ResultMatch[], limit = 3): ResultMatch[] {
  return newestCompleted(matches, (match) => Boolean(match.winnerId)).slice(0, limit);
}

function newestCompleted(
  matches: readonly ResultMatch[],
  include: (match: ResultMatch) => boolean,
) {
  const time = (match: ResultMatch) =>
    match.resultUpdatedAt ? new Date(match.resultUpdatedAt).getTime() || 0 : 0;
  return matches
    .filter((match) => match.status === 'complete' && include(match))
    .sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
}
/** Prefer confirmed competitive outcomes when automatic advances are also recent. */
export function intermissionRecentResults(matches: readonly ResultMatch[]) {
  const confirmed = newestCompleted(matches, (match) => {
    if (!match.resultUpdatedAt || !Number.isFinite(new Date(match.resultUpdatedAt).getTime()))
      return false;
    if (match.outcome === 'bye') return recordedByeWinner(match) !== null;
    if (!match.winnerId)
      return match.outcome == null && match.score1 == null && match.score2 == null;
    if (
      !match.player1Id ||
      !match.player2Id ||
      match.player1Id === match.player2Id ||
      (match.winnerId !== match.player1Id && match.winnerId !== match.player2Id)
    )
      return false;
    return (
      match.outcome === 'forfeit' ||
      (match.score1 != null &&
        match.score2 != null &&
        Number.isInteger(match.score1) &&
        Number.isInteger(match.score2) &&
        match.score1 >= 0 &&
        match.score2 >= 0)
    );
  });
  const results = confirmed.filter((match) => match.outcome !== 'bye').slice(0, 2);
  return [
    ...results,
    ...confirmed.filter((match) => match.outcome === 'bye').slice(0, 2 - results.length),
  ];
}

/** Initial data is a baseline, never a burst of old celebrations after an OBS reload. */
export function newResultNotices(
  previous: readonly ResultMatch[] | null,
  next: readonly ResultMatch[],
): ResultNotice[] {
  if (!previous) return [];
  const before = new Map(previous.map((match) => [match.id, match]));
  return recentResults(next, next.length)
    .reverse()
    .flatMap((match) => {
      if (match.outcome === 'bye' && !recordedByeWinner(match)) return [];
      const old = before.get(match.id);
      const fingerprint = resultFingerprint(match);
      if (old && resultFingerprint(old) === fingerprint) return [];
      return [
        {
          matchId: match.id,
          fingerprint,
          kind: old?.status === 'complete' ? ('correction' as const) : ('result' as const),
        },
      ];
    });
}
export function verifiedResultCaption(match: ResultMatch) {
  return match.labelFromStructure ? match.label : linkedFinalCaption(match)?.text;
}

export function resultHeadline(match: ResultMatch): string {
  if (match.outcome === 'bye') {
    const winner = recordedByeWinner(match);
    return winner ? `${winner} advances · bye` : 'Bye recorded';
  }
  const first = match.winnerId === match.player1Id;
  const winner = (first ? match.player1Name : match.player2Name) || 'Player';
  const loser = (first ? match.player2Name : match.player1Name) || 'Opponent';
  if (match.outcome === 'forfeit') return `${winner} advances · ${loser} forfeits`;
  return `${winner} ${first ? match.score1 : match.score2}–${first ? match.score2 : match.score1} ${loser}`;
}
