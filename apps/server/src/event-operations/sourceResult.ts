import { scoresIndicateBye, scoresIndicateForfeit } from '@smashclub/shared';
import type { sets } from '@smashclub/db';

export function importedOutcome(s: typeof sets.$inferSelect): 'played' | 'bye' | 'forfeit' | null {
  if (s.state !== 'complete') return null;
  return scoresIndicateBye(s.scoresCsv)
    ? 'bye'
    : scoresIndicateForfeit(s.scoresCsv)
      ? 'forfeit'
      : !s.p1PlayerId || !s.p2PlayerId
        ? 'bye'
        : 'played';
}
export function remoteValues(s: typeof sets.$inferSelect, firstPlayerId: string) {
  const scores = s.scoresCsv?.match(/^(-?\d+)-(-?\d+)$/);
  const flipped = s.p1PlayerId !== firstPlayerId;
  return {
    sourceSetId: s.id,
    outcome: importedOutcome(s),
    status: s.state === 'complete' ? ('complete' as const) : ('ready' as const),
    score1: scores ? Number(scores[flipped ? 2 : 1]) : null,
    score2: scores ? Number(scores[flipped ? 1 : 2]) : null,
    winnerId: s.winner === 1 ? s.p1PlayerId : s.winner === 2 ? s.p2PlayerId : null,
    syncState: 'synced' as const,
  };
}
