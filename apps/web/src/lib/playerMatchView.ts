import { matchesPool, type PoolFlowData, type PoolFlowMatch } from './poolFlow';

export function includesPlayer(match: PoolFlowMatch, playerId: string) {
  return match.player1Id === playerId || match.player2Id === playerId;
}

export function matchStation(data: PoolFlowData, match: PoolFlowMatch) {
  const queue = data.stationQueues?.find(
    (item) =>
      item.currentMatchId === match.id ||
      item.nextMatchId === match.id ||
      item.upcoming.some((upcoming) => upcoming.matchId === match.id),
  );
  const station = data.stations.find((item) => item.id === (queue?.stationId ?? match.stationId));
  const call =
    queue?.currentMatchId === match.id
      ? 'Playing now'
      : queue?.nextMatchId === match.id
        ? 'Play next'
        : queue
          ? 'Coming up'
          : null;
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

type GuestMatchFilters = {
  stationId: string;
  stationMatchIds: ReadonlySet<string | null | undefined>;
  selectedMatch: string | null;
  selectedPool: string;
  playerId: string;
  view: string;
  search: string;
  disputeMode: boolean;
  reportedIds: ReadonlySet<string>;
  queuedIds: ReadonlySet<string>;
};

export function guestVisibleMatches(data: PoolFlowData | undefined, filters: GuestMatchFilters) {
  if (!data) return [];
  const {
    stationId,
    stationMatchIds,
    selectedMatch,
    selectedPool,
    playerId,
    view,
    search,
    disputeMode,
    reportedIds,
    queuedIds,
  } = filters;
  const matching = data.matches.filter(
    (match) =>
      (!stationId ||
        match.stationId === stationId ||
        stationMatchIds.has(match.id) ||
        selectedMatch === match.id) &&
      matchesPool(match, selectedPool) &&
      (!playerId || includesPlayer(match, playerId)) &&
      (view === 'results'
        ? match.status === 'complete'
        : view === 'mine'
          ? Boolean(playerId)
          : view === 'reports'
            ? reportedIds.has(match.id)
            : view === 'matches' || search
              ? (match.status === 'ready' ||
                  match.status === 'playing' ||
                  (disputeMode && match.status === 'complete') ||
                  reportedIds.has(match.id)) &&
                match.player1Id &&
                match.player2Id
              : queuedIds.has(match.id) ||
                reportedIds.has(match.id) ||
                selectedMatch === match.id) &&
      `${match.player1Name} ${match.player2Name} ${match.label} ${match.division} ${match.poolIndex === null ? '' : `Pool ${String.fromCharCode(65 + match.poolIndex)}`}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return playerId ? sortPlayerMatches(data, matching) : matching;
}
