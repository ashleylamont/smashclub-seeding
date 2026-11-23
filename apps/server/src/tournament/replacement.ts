import {
  recordPlayoffPoolOrder,
  reviewPlayoffPoolOrder,
  usesFrozenMultiPoolFinals,
} from './playoffPoolCorrection';
import { recordReplacementPoolOrder } from './poolOrders';
import { requireFact } from './facts';
import { winner } from './scores';
import type { CommandEnvelope, TournamentState } from './schemas';
export function replaceResult(
  state: TournamentState,
  envelope: CommandEnvelope,
  command: Extract<CommandEnvelope['command'], { kind: 'replaceResult' }>,
  basis: Record<string, number>,
) {
  requireFact(
    state.lifecycle === 'finalized' &&
      state.result?.id === command.resultId &&
      state.publication?.resultId === command.resultId,
    'Publish the current sealed revision before replacing it.',
  );
  if (state.baseline!.structure === 'round_robin') {
    const order = command.roundRobinOrder;
    requireFact(
      order &&
        order.length === state.entrants.length &&
        new Set(order).size === order.length &&
        order.every((id) => state.entrants.some((e) => e.playerId === id)),
      'Review the full round-robin finishing order with this correction.',
    );
    state.pools[0]!.order = [...order];
  }
  const reviewedPoolIds = new Set(
    state.pools
      .filter(
        (pool) =>
          state.baseline!.structure === 'round_robin_finals' ||
          (pool.orderDecision?.source === 'automatic' && usesFrozenMultiPoolFinals(state, pool)),
      )
      .map(({ id }) => id),
  );
  const before = reviewedPoolIds.size
    ? { ...state, matches: structuredClone(state.matches) }
    : null;
  const changedPoolIds = new Set<string>();
  for (const correction of command.corrections) {
    const m = state.matches.find((m) => m.id === correction.matchId);
    requireFact(
      m && m.revision === correction.expectedRevision && m.outcome !== 'bye',
      'Correction refers to a changed match or automatic bye.',
    );
    basis[m.id] = m.revision;
    const correctedWinner = winner({ ...correction, kind: 'score' }, m);
    if (correctedWinner !== m.winnerId) {
      if (m.stage === 'group' && m.poolId && reviewedPoolIds.has(m.poolId))
        changedPoolIds.add(m.poolId);
      requireFact(
        !state.matches.some(
          (child) =>
            child.parent1Id === m.id ||
            child.parent2Id === m.id ||
            child.activation?.matchId === m.id,
        ),
        state.baseline!.structure === 'double_elimination'
          ? 'A winner change would invalidate recorded double-elimination routes or the reset final.'
          : 'A winner change would invalidate a recorded downstream pairing.',
      );
    }
    // A reviewed post-publication ruling changes result facts, never actual opponents or draws.
    Object.assign(m, correction, {
      winnerId: correctedWinner,
      revision: m.revision + 1,
      resultCommandId: envelope.id,
      automaticFromRevision: null,
    });
  }
  if (state.baseline!.structure === 'round_robin') recordReplacementPoolOrder(state, envelope);
  // Review every changed pool against the same sealed order and qualifier evidence.
  const corrections = before
    ? [...changedPoolIds].map((poolId) => reviewPlayoffPoolOrder(before, state, poolId))
    : [];
  for (const { pool, matches, order } of corrections) {
    basis[pool.id] = pool.revision;
    for (const match of matches) basis[match.id] ??= match.revision;
    recordPlayoffPoolOrder(state, pool, order, envelope);
  }
  state.result = {
    ...state.result!,
    id: envelope.id,
    revision: state.result!.revision + 1,
    replacesResultId: command.resultId,
    replacementReason: command.reason,
    sealedAt: envelope.at,
    matches: structuredClone(state.matches),
    ...(state.baseline!.structure === 'round_robin' || corrections.length
      ? { poolOrders: state.pools.map(({ division, order }) => ({ division, order: order ?? [] })) }
      : {}),
  };
  state.publication = null;
}
