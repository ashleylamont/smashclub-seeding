export type PoolProgress = { division: string; poolIndex: number; complete: number; total: number };
export type PoolPolicy = { selfRun: boolean; autoAcceptScores: boolean };
export type PoolSetting = PoolPolicy & { division: 'upper' | 'lower'; poolIndex: number; active: boolean; stationIds: string[]; expectedRevision: number };
export type SavedPoolSetting = Omit<PoolSetting, 'expectedRevision'> & { revision: number };
export const poolKey = (pool: Pick<PoolProgress, 'division' | 'poolIndex'>) => `${pool.division}:${pool.poolIndex}`;
export const poolLabel = (pool: Pick<PoolProgress, 'division' | 'poolIndex'>) => `${pool.division === 'upper' ? 'Upper' : 'Lower'} Pool ${String.fromCharCode(65 + pool.poolIndex)}`;
const ordered = (pools: PoolProgress[]) => [...pools].sort((a, b) => (a.division === b.division ? a.poolIndex - b.poolIndex : a.division === 'upper' ? -1 : 1));
const setting = (pool: PoolProgress, saved: SavedPoolSetting[]) => saved.find(item => poolKey(item) === poolKey(pool));

/** A reviewed batch: disjoint station groups now, the same groups reused by later waves. */
export function distributePoolStations(pools: PoolProgress[], stationIds: string[], perPool: number, saved: SavedPoolSetting[], policy: PoolPolicy) {
  if (!stationIds.length || new Set(stationIds).size !== stationIds.length || !Number.isInteger(perPool) || perPool < 1) return [];
  const groups: string[][] = [];
  for (let index = 0; index < stationIds.length; index += perPool) groups.push(stationIds.slice(index, index + perPool));
  const assignments = ordered(pools.filter(pool => pool.complete < pool.total)).map((pool, index): PoolSetting & { wave: number } => ({
    division: pool.division as 'upper' | 'lower', poolIndex: pool.poolIndex, active: index < groups.length,
    stationIds: groups[index % groups.length]!, expectedRevision: setting(pool, saved)?.revision ?? 0,
    ...policy, autoAcceptScores: policy.selfRun && policy.autoAcceptScores, wave: Math.floor(index / groups.length) + 1,
  }));
  const finished = new Set(pools.filter(pool => pool.complete === pool.total).map(poolKey));
  const releases = saved.filter(pool => pool.active && finished.has(poolKey(pool))).map(({ revision, ...pool }) => ({ ...pool, active: false, expectedRevision: revision, wave: 0 }));
  return [...releases, ...assignments];
}

/** Advance only banks whose previous pool has finished; other pools keep playing. */
export function nextPoolWave(pools: PoolProgress[], saved: SavedPoolSetting[], occupiedStationIds: string[]): PoolSetting[] {
  const unfinished = new Set(pools.filter(pool => pool.complete < pool.total).map(poolKey));
  const occupied = new Set(occupiedStationIds);
  for (const pool of saved) if (pool.active && unfinished.has(poolKey(pool))) pool.stationIds.forEach(id => occupied.add(id));
  const changes: PoolSetting[] = saved.filter(pool => pool.active && !unfinished.has(poolKey(pool))).map(({ revision, ...pool }) => ({ ...pool, active: false, expectedRevision: revision }));
  for (const pool of ordered(pools)) {
    const previous = setting(pool, saved);
    if (!previous || previous.active || !unfinished.has(poolKey(pool)) || !previous.stationIds.length || previous.stationIds.some(id => occupied.has(id))) continue;
    previous.stationIds.forEach(id => occupied.add(id));
    const { revision, ...values } = previous;
    changes.push({ ...values, active: true, expectedRevision: revision });
  }
  return changes.some(pool => pool.active) ? changes : [];
}
