import { poolKey, poolPath, poolTitle, type PoolFlowData } from './poolFlow';

export type FloorSheetData = PoolFlowData & {
  plan: PoolFlowData['plan'] & { name: string; bracketMode: string };
  settings: { published: boolean };
  withdrawals: { playerId: string }[];
};
/** A printable snapshot of native pairings, never a second scheduler or reporting credential. */
export function poolFloorSheets(data: FloorSheetData, origin: string) {
  if (data.plan.bracketMode !== 'native') return [];
  const withdrawn = new Set(data.withdrawals.map(player => player.playerId));
  return [...(data.poolRounds ?? [])].sort((a, b) => {
    const [ad, ai] = a.poolKey.split(':'), [bd, bi] = b.poolKey.split(':');
    return (ad === bd ? 0 : ad === 'upper' ? -1 : 1) || Number(ai) - Number(bi);
  }).map(pool => {
    const matches = data.matches.filter(match => poolKey(match) === pool.poolKey);
    const schedule = data.poolSchedules.find(item => `${item.division}:${item.poolIndex}` === pool.poolKey);
    const names = new Map(matches.flatMap(match => [[match.player1Id, match.player1Name], [match.player2Id, match.player2Name]] as const));
    const resolved = (match: typeof matches[number]) => match.status === 'complete' || match.blockedReason === 'Both players withdrawn: no contest; no winner or score recorded';
    const finished = matches.length > 0 && matches.every(resolved);
    return {
      key: pool.poolKey, title: poolTitle(pool.poolKey),
      status: finished ? 'Finished' : ['complete', 'cancelled'].includes(data.plan.status) ? 'Event closed' : schedule?.active === false ? 'Later wave — wait to be called' : 'Pool open',
      stations: data.stations.filter(station => schedule?.stationIds.includes(station.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(station => station.name),
      boardUrl: data.settings.published ? new URL(poolPath(`/live/${data.plan.id}`, pool.poolKey), origin).href : null,
      roster: [...names].filter(([id]) => !!id).map(([id, name]) => ({ id: id!, name: name ?? 'Player', withdrawn: withdrawn.has(id!) })).sort((a, b) => a.name.localeCompare(b.name)),
      instructions: finished || ['complete', 'cancelled'].includes(data.plan.status) ? 'This pool is read-only. Check the live board for final results.' : schedule?.selfRun ? `Use the live station queue to find your next match. Start it online when both players and the station are free. ${schedule.autoAcceptScores ? 'Submitted results are confirmed immediately.' : 'Submitted results need TO approval.'}` : 'Follow the live station queue. Ask a TO to start your match and confirm how to report results.',
      rounds: pool.rounds.map(round => ({ round: round.round,
        resting: round.restingPlayerIds.map(id => `${names.get(id) ?? 'Player'}${withdrawn.has(id) ? ' (withdrawn)' : ''}`),
        matches: round.matchIds.flatMap(id => {
          const match = matches.find(item => item.id === id);
          if (!match) return [];
          const result = match.status === 'complete' ? match.outcome === 'forfeit' || match.outcome === 'bye' ? `${match.outcome === 'forfeit' ? 'Forfeit' : 'Bye'} · ${names.get(match.winnerId) ?? 'winner not recorded'}` : `${match.score1 ?? '–'} – ${match.score2 ?? '–'}` : resolved(match) ? 'No contest' : match.status === 'playing' ? `Playing · ${match.score1 ?? 0} – ${match.score2 ?? 0}` : match.status === 'blocked' ? 'Blocked · ask TO' : '_____ – _____';
          return [{ id, label: match.label, player1: `${match.player1Name ?? 'Player'}${match.player1Id && withdrawn.has(match.player1Id) ? ' (withdrawn)' : ''}`, player2: `${match.player2Name ?? 'Player'}${match.player2Id && withdrawn.has(match.player2Id) ? ' (withdrawn)' : ''}`, result }];
        }),
      })),
    };
  });
}
