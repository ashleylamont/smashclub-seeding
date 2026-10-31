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
  for (const correction of command.corrections) {
    const m = state.matches.find((m) => m.id === correction.matchId);
    requireFact(
      m && m.revision === correction.expectedRevision && m.outcome !== 'bye',
      'Correction refers to a changed match or automatic bye.',
    );
    basis[m.id] = m.revision;
    const correctedWinner = winner({ ...correction, kind: 'score' }, m);
    if (state.baseline!.structure === 'double_elimination' && correctedWinner !== m.winnerId)
      requireFact(
        !state.matches.some(
          (child) =>
            child.parent1Id === m.id ||
            child.parent2Id === m.id ||
            child.activation?.matchId === m.id,
        ),
        'A winner change would invalidate recorded double-elimination routes or the reset final.',
      );
    // A reviewed post-publication ruling changes result facts, never actual opponents or draws.
    Object.assign(m, correction, {
      winnerId: correctedWinner,
      revision: m.revision + 1,
      resultCommandId: envelope.id,
      automaticFromRevision: null,
    });
  }
  if (state.baseline!.structure === 'round_robin') recordReplacementPoolOrder(state, envelope);
  state.result = {
    ...state.result!,
    id: envelope.id,
    revision: state.result!.revision + 1,
    replacesResultId: command.resultId,
    replacementReason: command.reason,
    sealedAt: envelope.at,
    matches: structuredClone(state.matches),
    ...(state.baseline!.structure === 'round_robin'
      ? { poolOrders: state.pools.map((p) => ({ division: p.division, order: p.order! })) }
      : {}),
  };
  state.publication = null;
}
