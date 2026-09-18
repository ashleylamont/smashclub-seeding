import { useEffect, useState } from 'react';
import type { LiveMatch } from './eventDisplay';

export type PoolFlowMatch = LiveMatch & { revision: number };
export type PoolPolicy = { division: string; poolIndex: number; active: boolean; stationIds: string[]; selfRun?: boolean; autoAcceptScores?: boolean };
export type StationQueue = { stationId: string; poolKey: string | null; currentMatchId: string | null; nextMatchId: string | null; upcoming: { matchId: string; round: number }[]; waitingReason: string | null };
export type PoolRounds = { poolKey: string; rounds: { round: number; matchIds: string[]; restingPlayerIds: string[] }[] };
export type PoolFlowData = {
  plan: { id: string; status: string };
  matches: PoolFlowMatch[];
  stations: { id: string; name: string; currentMatchId?: string | null }[];
  poolSchedules: PoolPolicy[];
  stationQueues?: StationQueue[];
  poolRounds?: PoolRounds[];
};
export type StartPoolMatch = { matchId: string; stationId: string; expectedRevision: number };
export const poolKey = (match: Pick<LiveMatch, 'stage' | 'division' | 'poolIndex'>) => match.stage === 'group' && match.poolIndex !== null ? `${match.division}:${match.poolIndex}` : null;
export const matchesPool = (match: Pick<LiveMatch, 'stage' | 'division' | 'poolIndex'>, selected: string) => !selected || poolKey(match) === selected;
export function poolTitle(key: string) {
  const [division, index] = key.split(':');
  return `${division === 'upper' ? 'Upper' : 'Lower'} Pool ${String.fromCharCode(65 + Number(index))}`;
}
export function poolPolicy(data: Pick<PoolFlowData, 'poolSchedules'>, match: LiveMatch) {
  return match.stage === 'group' ? data.poolSchedules.find(pool => pool.division === match.division && pool.poolIndex === match.poolIndex) : undefined;
}
export function poolPath(path: string, selected: string) { return selected ? `${path}?pool=${encodeURIComponent(selected)}` : path; }
export function usePoolFilter() {
  const read = () => { const key = new URLSearchParams(window.location.search).get('pool') ?? ''; return /^(upper|lower):\d+$/.test(key) ? key : ''; };
  const [selected, setSelected] = useState(read);
  useEffect(() => { const refresh = () => setSelected(read()); window.addEventListener('popstate', refresh); return () => window.removeEventListener('popstate', refresh); }, []);
  const update = (value: string) => {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set('pool', value); else url.searchParams.delete('pool');
    window.history.replaceState(window.history.state, '', url);
    setSelected(value);
  };
  return [selected, update] as const;
}
/** A station may have an immediate next match or only a provisional order while occupied. */
export function stationPreview(queue: StationQueue, matches: readonly PoolFlowMatch[], limit = 3) {
  const ids = [...new Set([queue.nextMatchId, ...queue.upcoming.map(item => item.matchId)].filter((id): id is string => !!id && id !== queue.currentMatchId))];
  return ids.flatMap(id => { const match = matches.find(item => item.id === id); return match && match.status !== 'complete' ? [match] : []; }).slice(0, limit);
}
export function queueScoringIds(data: Pick<PoolFlowData, 'matches' | 'stationQueues'>) {
  return new Set([...data.matches.filter(match => match.status === 'playing').map(match => match.id), ...(data.stationQueues ?? []).flatMap(queue => queue.nextMatchId ? [queue.nextMatchId] : [])]);
}
