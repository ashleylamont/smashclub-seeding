import type { trpc } from './trpc';

type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export type FinderData = Pick<Overview, 'plan' | 'entrants' | 'matches' | 'stations' | 'stationQueues' | 'poolSchedules' | 'withdrawals' | 'reports'>;
export type FinderMatch = FinderData['matches'][number];
const includesPlayer = (match: FinderMatch, playerId: string) => match.player1Id === playerId || match.player2Id === playerId;
export const finderPoolKey = (match: FinderMatch) => match.stage === 'group' && match.poolIndex !== null ? `${match.division}:${match.poolIndex}` : null;

/** Only event entrants and public match names; duplicate names stay separate by ID. */
export function findEventPlayers(data: Pick<FinderData, 'entrants' | 'matches'>, query: string) {
  const players = new Map(data.entrants.map(player => [player.id, player]));
  for (const match of data.matches) {
    if (match.player1Id && !players.has(match.player1Id)) players.set(match.player1Id, { id: match.player1Id, name: match.player1Name });
    if (match.player2Id && !players.has(match.player2Id)) players.set(match.player2Id, { id: match.player2Id, name: match.player2Name });
  }
  const text = query.trim().toLocaleLowerCase();
  if (!text) return [];
  return [...players.values()].filter(player => player.name.toLocaleLowerCase().includes(text)).sort((a, b) => {
    const score = (name: string) => name.toLocaleLowerCase() === text ? 2 : name.toLocaleLowerCase().startsWith(text) ? 1 : 0;
    return score(b.name) - score(a.name) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

export function playerEventStatus(data: FinderData, playerId: string) {
  const matches = data.matches.filter(match => includesPlayer(match, playerId));
  const withdrawnIds = new Set(data.withdrawals.map(row => row.playerId));
  const withdrawn = withdrawnIds.has(playerId);
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  // Double-withdrawal no-contests have no winner and stay blocked in storage.
  const noContest = (match: FinderMatch) => match.status === 'blocked' && match.blockedReason === 'Both players withdrawn: no contest; no winner or score recorded' && !!match.player1Id && !!match.player2Id && withdrawnIds.has(match.player1Id) && withdrawnIds.has(match.player2Id);
  const outstanding = matches.filter(match => match.status !== 'complete' && !noContest(match));
  const playing = outstanding.filter(match => match.status === 'playing');
  const next = closed || withdrawn || playing.length ? [] : data.stationQueues.flatMap(queue => {
    const match = outstanding.find(match => match.id === queue.nextMatchId && match.status === 'ready' && match.availability.canStart);
    const station = data.stations.find(station => station.id === queue.stationId);
    return match && station ? [{ match, station }] : [];
  });
  const pools = [...new Set(matches.flatMap(match => { const key = finderPoolKey(match); return key ? [key] : []; }))].map(key => {
    const schedule = data.poolSchedules.find(pool => `${pool.division}:${pool.poolIndex}` === key);
    const poolMatches = matches.filter(match => finderPoolKey(match) === key);
    return { key, held: schedule?.active === false, stationNames: data.stations.filter(station => schedule?.stationIds.includes(station.id)).map(station => station.name), remaining: poolMatches.filter(match => match.status !== 'complete' && !noContest(match)).length };
  });
  const pending = data.reports.filter(report => report.status === 'pending' && matches.some(match => match.id === report.matchId));
  return { matches, outstanding, playing, next, pools, pending, withdrawn, closed, completed: matches.filter(match => match.status === 'complete').length, noContests: matches.filter(noContest).length };
}
