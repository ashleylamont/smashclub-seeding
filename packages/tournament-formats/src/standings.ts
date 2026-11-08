export interface EliminationResult {
  id: string;
  round: number;
  player1Id: string | null;
  player2Id: string | null;
  winnerId: string | null;
  status: string;
  skipped?: boolean;
}

/** One definition of structural finishing places for live views and history. */
export function eliminationStandings(
  entrantIds: readonly string[],
  matches: readonly EliminationResult[],
  doubleElimination = false,
) {
  const ordered = [...matches].sort((a, b) => a.round - b.round || a.id.localeCompare(b.id));
  const final = [...ordered].reverse().find((m) => !m.skipped);
  const complete =
    entrantIds.length === 0 ||
    Boolean(final && final.status === 'complete' && matches.every((m) => m.status === 'complete'));
  const winnerId = complete ? (final?.winnerId ?? null) : null;
  const places = new Map<string, number>();
  if (complete) {
    if (doubleElimination) {
      const losses = new Map<string, number>();
      const eliminated = new Map<number, string[]>();
      for (const match of ordered) {
        if (match.skipped || !match.winnerId || !match.player1Id || !match.player2Id) continue;
        const loser = match.winnerId === match.player1Id ? match.player2Id : match.player1Id;
        const count = (losses.get(loser) ?? 0) + 1;
        losses.set(loser, count);
        if (count === 2) {
          const group = eliminated.get(match.round) ?? [];
          group.push(loser);
          eliminated.set(match.round, group);
        }
      }
      let remaining = entrantIds.length;
      for (const group of eliminated.values()) {
        remaining -= group.length;
        for (const id of group) places.set(id, remaining + 1);
      }
    } else {
      const maxRound = final?.round ?? 0;
      for (const match of ordered)
        if (match.player1Id && match.player2Id && match.winnerId)
          places.set(
            match.winnerId === match.player1Id ? match.player2Id : match.player1Id,
            2 ** (maxRound - match.round) + 1,
          );
    }
    if (winnerId) places.set(winnerId, 1);
  }
  return {
    complete,
    winnerId,
    standings: [...places]
      .map(([playerId, place]) => ({ playerId, place }))
      .sort((a, b) => a.place - b.place || a.playerId.localeCompare(b.playerId)),
  };
}
