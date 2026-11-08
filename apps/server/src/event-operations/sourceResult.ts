import { scoresIndicateBye, scoresIndicateForfeit } from '@smashclub/shared';
import type { eventMatches, sets } from '@smashclub/db';

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

export function compareImportedResult(
  previous: typeof eventMatches.$inferSelect,
  incoming: typeof eventMatches.$inferInsert,
) {
  const sameRecordedResult =
    previous.status === 'complete' &&
    incoming.status === 'complete' &&
    incoming.player1Id === previous.player1Id &&
    incoming.player2Id === previous.player2Id &&
    incoming.winnerId === previous.winnerId &&
    incoming.outcome === previous.outcome;
  // Challonge's negative DQ sentinel and the local wire placeholder describe
  // the same forfeit once the pairing, winner and outcome agree.
  const sameForfeit =
    sameRecordedResult &&
    incoming.outcome === 'forfeit' &&
    incoming.player1Id &&
    incoming.player2Id &&
    incoming.player1Id !== incoming.player2Id &&
    (incoming.winnerId === incoming.player1Id || incoming.winnerId === incoming.player2Id);
  const score1 = sameForfeit ? previous.score1 : incoming.score1;
  const score2 = sameForfeit ? previous.score2 : incoming.score2;
  return {
    agrees: sameRecordedResult && score1 === previous.score1 && score2 === previous.score2,
    score1: score1 ?? null,
    score2: score2 ?? null,
  };
}
