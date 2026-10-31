import { buildDoubleEliminationTree } from '../../../../packages/engine/src/tournament/doubleElimination';
import { buildEliminationTree } from '../../../../packages/engine/src/tournament/elimination';
import type { LiveMatch } from '../../src/lib/eventDisplay';

export const TEAM_ALIAS =
  'The very long doubles team (Alex with a long tournament alias / Beatrice with another long tournament alias)';

/** Synthetic renderer rehearsal data, generated from the real engine's source graph. */
export function bracketFixture(size: number, double = true): LiveMatch[] {
  const entrants = Array.from({ length: size }, (_, i) => ({
    kind: 'entrant' as const,
    entrantId: `entrant-${i}`,
  }));
  const tree = (double ? buildDoubleEliminationTree : buildEliminationTree)('rehearsal', entrants);
  return tree.map((match): LiveMatch => {
    const [a, b] = match.sides;
    const player1Id = a.kind === 'entrant' ? a.entrantId : null;
    const player2Id = b.kind === 'entrant' ? b.entrantId : null;
    const bye = a.kind === 'bye' || b.kind === 'bye';
    const winnerId = bye ? (player1Id ?? player2Id) : null;
    return {
      id: match.id,
      division: 'upper',
      stage: 'main',
      poolIndex: null,
      label:
        match.bracketLane === 'final'
          ? 'Grand final'
          : match.bracketLane === 'reset'
            ? 'Reset final'
            : `${match.bracketLane ?? 'Round'} ${match.bracketRound ?? match.round} · M${match.slot + 1}`,
      player1Id,
      player2Id,
      player1Name: player1Id === 'entrant-0' ? TEAM_ALIAS : player1Id,
      player2Name: player2Id === 'entrant-0' ? TEAM_ALIAS : player2Id,
      score1: null,
      score2: null,
      winnerId,
      status: bye ? 'complete' : player1Id && player2Id ? 'ready' : 'blocked',
      outcome: bye ? 'bye' : null,
      stationId: null,
      nativeBracketId: 'rehearsal',
      nativeRound: match.round,
      nativeSlot: match.slot,
      bracketLane: match.bracketLane,
      bracketRound: match.bracketRound,
      parent1MatchId: a.kind === 'winner' || a.kind === 'loser' ? a.matchId : null,
      parent2MatchId: b.kind === 'winner' || b.kind === 'loser' ? b.matchId : null,
      parent1Outcome: a.kind === 'loser' ? 'loser' : 'winner',
      parent2Outcome: b.kind === 'loser' ? 'loser' : 'winner',
    };
  });
}
