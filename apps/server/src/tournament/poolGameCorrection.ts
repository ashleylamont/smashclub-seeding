import { hash, requireFact } from './facts';
import { canReviewFrozenPoolResult, poolResultBasis } from './poolOrders';
import type { PoolGameCorrectionInput, TournamentState } from './schemas';

export function reviewPoolGameCorrection(state: TournamentState, input: PoolGameCorrectionInput) {
  const match = state.matches.find(({ id }) => id === input.matchId);
  requireFact(
    match?.revision === input.expectedRevision,
    'This match changed. Reopen its score before reviewing the correction.',
  );
  requireFact(
    match.stage === 'group' &&
      match.status === 'complete' &&
      match.outcome === 'played' &&
      match.player1Id &&
      match.player2Id &&
      match.score1 !== null &&
      match.score2 !== null &&
      input.score1 !== input.score2 &&
      (input.score1 > input.score2 ? match.player1Id : match.player2Id) === match.winnerId &&
      (input.score1 !== match.score1 || input.score2 !== match.score2),
    'Review changed games for a completed pool set with the same winner.',
  );
  const pool = state.pools.find(({ id }) => id === match.poolId);
  requireFact(
    pool && canReviewFrozenPoolResult(state, pool),
    'Review requires a frozen automatic pool order and no pool scores awaiting review.',
  );
  const brackets = state.brackets.filter(
    (bracket) =>
      bracket.strengthSeeding &&
      bracket.qualifierSlots?.some((source) => source.poolId === pool.id),
  );
  return {
    match,
    pool,
    revisionToken: hash({
      input,
      pool: [pool.id, pool.revision, pool.order, pool.orderDecision, pool.qualifierRoster],
      resultBasis: poolResultBasis(state, pool),
      brackets,
    }),
  };
}
