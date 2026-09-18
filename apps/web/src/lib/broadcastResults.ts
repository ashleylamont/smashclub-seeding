import type { LiveMatch } from './eventDisplay';

export type ResultMatch = LiveMatch & {
  outcome?: 'played' | 'bye' | 'forfeit' | null;
  resultUpdatedAt?: string | Date | null;
};
export type ResultNotice = { matchId: string; fingerprint: string; kind: 'result' | 'correction' };
export function resultFingerprint(match: ResultMatch): string {
  return JSON.stringify([match.status, match.player1Id, match.player2Id, match.score1, match.score2, match.winnerId, match.outcome]);
}
export function recentResults(matches: readonly ResultMatch[], limit = 3): ResultMatch[] {
  const time = (match: ResultMatch) => match.resultUpdatedAt ? new Date(match.resultUpdatedAt).getTime() || 0 : 0;
  return matches.filter(match => match.status === 'complete' && match.winnerId)
    .sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id)).slice(0, limit);
}
/** Initial data is a baseline, never a burst of old celebrations after an OBS reload. */
export function newResultNotices(previous: readonly ResultMatch[] | null, next: readonly ResultMatch[]): ResultNotice[] {
  if (!previous) return [];
  const before = new Map(previous.map(match => [match.id, match]));
  return recentResults(next, next.length).reverse().flatMap(match => {
    const old = before.get(match.id);
    const fingerprint = resultFingerprint(match);
    if (old && resultFingerprint(old) === fingerprint) return [];
    return [{ matchId: match.id, fingerprint, kind: old?.status === 'complete' ? 'correction' as const : 'result' as const }];
  });
}
export function resultHeadline(match: ResultMatch): string {
  const first = match.winnerId === match.player1Id;
  const winner = (first ? match.player1Name : match.player2Name) || 'Player';
  const loser = (first ? match.player2Name : match.player1Name) || 'Opponent';
  if (match.outcome === 'bye') return `${winner} advances · bye`;
  if (match.outcome === 'forfeit') return `${winner} advances · ${loser} forfeits`;
  return `${winner} ${first ? match.score1 : match.score2}–${first ? match.score2 : match.score1} ${loser}`;
}
