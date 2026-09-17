export interface QueueMatch {
  id: string; status: string; player1Id: string | null; player2Id: string | null;
  player1Name: string | null; player2Name: string | null;
  division: string; stage: string; poolIndex: number | null;
  score1: number | null; score2: number | null; winnerId: string | null;
  outcome?: string | null;
}
/** A ready bracket match is not callable while either player is on another setup. */
export function availableMatches<T extends QueueMatch>(matches: readonly T[]): T[] {
  const busy = new Set(matches.filter(m => m.status === 'playing').flatMap(m => [m.player1Id, m.player2Id]));
  const played = new Map<string, number>();
  for (const m of matches.filter(m => m.status === 'complete')) {
    for (const id of [m.player1Id, m.player2Id]) if (id) played.set(id, (played.get(id) ?? 0) + 1);
  }
  return matches.filter(m => m.status === 'ready' && m.player1Id && m.player2Id && !busy.has(m.player1Id) && !busy.has(m.player2Id))
    .sort((a, b) => ((played.get(a.player1Id!) ?? 0) + (played.get(a.player2Id!) ?? 0)) - ((played.get(b.player1Id!) ?? 0) + (played.get(b.player2Id!) ?? 0)));
}
export function poolStandings(matches: readonly QueueMatch[]) {
  const pools = new Map<string, { division: string; poolIndex: number; complete: number; total: number; players: Map<string, { id: string; name: string; wins: number; losses: number; differential: number; remaining: number }> }>();
  for (const m of matches) {
    if (m.stage !== 'group' || m.poolIndex === null) continue;
    const key = `${m.division}:${m.poolIndex}`;
    const pool = pools.get(key) ?? { division: m.division, poolIndex: m.poolIndex, complete: 0, total: 0, players: new Map() };
    pool.total++; if (m.status === 'complete') pool.complete++;
    for (const [id, name, own, opponent] of [[m.player1Id, m.player1Name, m.score1, m.score2], [m.player2Id, m.player2Name, m.score2, m.score1]] as const) {
      if (!id) continue;
      const player = pool.players.get(id) ?? { id, name: name ?? 'Player', wins: 0, losses: 0, differential: 0, remaining: 0 };
      if (m.status !== 'complete') player.remaining++;
      else if (m.winnerId && m.outcome !== 'bye') {
        if (m.winnerId === id) player.wins++; else player.losses++;
        if (m.outcome !== 'forfeit' && own !== null && opponent !== null) player.differential += own - opponent;
      }
      pool.players.set(id, player);
    }
    pools.set(key, pool);
  }
  return [...pools.values()].map(pool => ({ ...pool, players: [...pool.players.values()].sort((a, b) => b.wins - a.wins || b.differential - a.differential || a.name.localeCompare(b.name)) }));
}
