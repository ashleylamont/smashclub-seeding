import { describe, expect, it } from 'vitest';
import { distributePoolStations, nextPoolWave, type SavedPoolSetting } from '../src/lib/poolStationPlan';
const pools = Array.from({ length: 4 }, (_, poolIndex) => ({ division: 'upper', poolIndex, complete: 0, total: 6 }));
const policy = { selfRun: true, autoAcceptScores: false };
describe('pool station setup', () => {
  it('divides explicit banks and schedules extra pools into later waves', () => {
    const plan = distributePoolStations(pools, ['s1', 's2', 's3', 's4'], 2, [], policy);
    expect(plan.map(pool => [pool.stationIds, pool.wave, pool.active])).toEqual([
      [['s1', 's2'], 1, true], [['s3', 's4'], 1, true], [['s1', 's2'], 2, false], [['s3', 's4'], 2, false],
    ]);
    expect(plan.every(pool => pool.expectedRevision === 0 && !pool.autoAcceptScores)).toBe(true);
  });
  it('uses an uneven last bank and retains revision guards', () => {
    const previous = [{ division: 'upper', poolIndex: 0, active: false, stationIds: [], revision: 4, ...policy }] as SavedPoolSetting[];
    const plan = distributePoolStations(pools, ['s1', 's2', 's3'], 2, previous, policy);
    expect(plan[0]!.expectedRevision).toBe(4);
    expect(plan[1]!.stationIds).toEqual(['s3']);
    expect(distributePoolStations(pools, [], 2, [], policy)).toEqual([]);
  });
  it('opens the next pool only on a completed free bank without interrupting another pool', () => {
    const saved = distributePoolStations(pools, ['s1', 's2', 's3', 's4'], 2, [], policy).map(pool => ({ division: pool.division, poolIndex: pool.poolIndex, active: pool.active, stationIds: pool.stationIds, selfRun: pool.selfRun, autoAcceptScores: pool.autoAcceptScores, revision: 1 }));
    const progress = pools.map(pool => ({ ...pool, complete: pool.poolIndex === 0 ? 6 : 0 }));
    const wave = nextPoolWave(progress, saved, ['s3']);
    expect(wave.map(pool => [pool.poolIndex, pool.active])).toEqual([[0, false], [2, true]]);
    expect(nextPoolWave(progress, saved, ['s1'])).toEqual([]);
    expect(nextPoolWave(pools, saved, [])).toEqual([]);
  });
});

it('includes release of finished banks when redistributing the remaining pools', () => {
  const saved: SavedPoolSetting[] = [{ division: 'upper', poolIndex: 0, active: true, stationIds: ['s1', 's2'], revision: 5, ...policy }];
  const plan = distributePoolStations(pools.map(pool => ({ ...pool, complete: pool.poolIndex === 0 ? 6 : 0 })), ['s1', 's2'], 2, saved, policy);
  expect(plan[0]).toMatchObject({ poolIndex: 0, active: false, expectedRevision: 5, wave: 0 });
  expect(plan[1]).toMatchObject({ poolIndex: 1, active: true, wave: 1 });
});
