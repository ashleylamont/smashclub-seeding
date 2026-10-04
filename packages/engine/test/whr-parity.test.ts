import { describe, expect, it } from 'vitest';
import { defaultRatingSettings } from '@smashclub/shared';
import fixture from './fixtures/whr-before-removal.json';
import { runWhrModel } from '../src/whrRun';
import type { EngineSet } from '../src/types';

/** Anonymous fixture generated with the pre-removal WHR engine at 1f24143. */
describe('WHR mathematics and policy remain stable', () => {
  it('preserves all fitted ratings, uncertainty, calibration, participation and previous ranks', () => {
    const run = runWhrModel({
      sets: fixture.sets as EngineSet[],
      tournaments: fixture.tournaments,
      settings: { ...defaultRatingSettings, ...fixture.settingsOverrides, leagueBandBasis: 'club' },
    });
    expect(run.converged).toBe(true);
    expect([...run.previousRanks]).toEqual(fixture.expectedPreviousRanks);
    for (const [index, actual] of run.leaderboard.entries()) {
      const expected = fixture.expectedLeaderboard[index]!;
      const keys = Object.keys(expected) as (keyof typeof expected)[];
      for (const key of keys.filter((key) => typeof expected[key] === 'number')) {
        expect(actual[key], `${actual.playerId}.${key}`).toBeCloseTo(expected[key] as number, 9);
      }
      for (const key of keys.filter((key) => typeof expected[key] !== 'number')) {
        expect(actual[key]).toEqual(expected[key]);
      }
    }
    expect(run.leaderboard).toHaveLength(fixture.expectedLeaderboard.length);
  });
});
