import type { PoolFlowData, PoolFlowMatch } from './poolFlow';

export function includesPlayer(match: PoolFlowMatch, playerId: string) {
  return match.player1Id === playerId || match.player2Id === playerId;
}

export function matchStation(data: PoolFlowData, match: PoolFlowMatch) {
  const queue = data.stationQueues?.find(item =>
    item.currentMatchId === match.id || item.nextMatchId === match.id || item.upcoming.some(upcoming => upcoming.matchId === match.id));
  const station = data.stations.find(item => item.id === (queue?.stationId ?? match.stationId));
  const call = queue?.currentMatchId === match.id ? 'Playing now' : queue?.nextMatchId === match.id ? 'Play next' : queue ? 'Coming up' : null;
  return { name: station?.name ?? null, call };
}

export function matchStatus(data: PoolFlowData, match: PoolFlowMatch) {
  if (match.status === 'complete') return 'Final result';
  if (match.status === 'playing') return 'Playing now';
  const call = matchStation(data, match).call;
  if (call) return call;
  if (match.status === 'ready') return 'Waiting for station';
  return 'Waiting';
}

export function sortPlayerMatches<T extends PoolFlowMatch>(data: PoolFlowData, matches: T[]): T[] {
  const rank = (match: PoolFlowMatch) => {
    const call = matchStation(data, match).call;
    if (match.status === 'playing' || call === 'Playing now') return 0;
    if (call === 'Play next') return 1;
    if (call === 'Coming up') return 2;
    if (match.status === 'ready') return 3;
    if (match.status === 'complete') return 5;
    return 4;
  };
  return [...matches].sort((a, b) => rank(a) - rank(b));
}
