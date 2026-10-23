import type { StructureMatch } from '@smashclub/engine';
import { stableId } from './facts';
import type { Match } from './schemas';

/** Assign durable identities and operational fields to chosen engine matches. */
export function instantiateElimination(
  tree: readonly StructureMatch[],
  bracketId: string,
  division: 'upper' | 'lower',
  stage: 'main' | 'consolation',
): Match[] {
  const ids = new Map(tree.map((m) => [m.id, stableId(`${bracketId}:${m.round}:${m.slot}`)]));
  return tree.map((m) => {
    const [a, b] = m.sides;
    const parent = (s: typeof a) =>
      s.kind === 'winner' || s.kind === 'loser' ? ids.get(s.matchId)! : null;
    const player1Id = a.kind === 'entrant' ? a.entrantId : null;
    const player2Id = b.kind === 'entrant' ? b.entrantId : null;
    return {
      id: ids.get(m.id)!,
      sourceKey: `native:${division}:${stage}:${m.round}:${m.slot}`,
      division,
      stage,
      poolId: null,
      bracketId,
      round: m.round,
      slot: m.slot,
      label: m.bracketLane
        ? `${m.bracketLane === 'reset' ? 'Reset final (if needed)' : m.bracketLane === 'final' ? 'Grand final' : `${m.bracketLane} R${m.bracketRound}`} · M${m.slot + 1}`
        : `${division} ${stage} · R${m.round} M${m.slot + 1}`,
      parent1Id: parent(a),
      parent2Id: parent(b),
      ...(a.kind === 'loser' ? { parent1Outcome: 'loser' as const } : {}),
      ...(b.kind === 'loser' ? { parent2Outcome: 'loser' as const } : {}),
      ...(m.activation
        ? { activation: { ...m.activation, matchId: ids.get(m.activation.matchId)! } }
        : {}),
      ...(m.bracketLane ? { bracketLane: m.bracketLane, bracketRound: m.bracketRound } : {}),
      player1Id,
      player2Id,
      status: player1Id && player2Id ? 'ready' : 'blocked',
      outcome: null,
      score1: null,
      score2: null,
      winnerId: null,
      stationId: null,
      revision: 0,
      started: false,
      completedAt: null,
      automaticFromRevision: null,
      resultCommandId: null,
      liveScore1: null,
      liveScore2: null,
      progressRevision: 0,
      blockedReason: null,
    };
  });
}
