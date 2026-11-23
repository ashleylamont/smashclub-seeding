import { describe, expect, it } from 'vitest';
import {
  evaluateDoubles,
  fitDoubles,
  NATURAL_TO_DISPLAY,
  probabilityFromRatings,
  type DoublesSet,
  type SkillEstimate,
} from '../src/index';

const firstNight = 20_000;
const secondNight = 20_002;
const thirdNight = 20_005;
const neutral = new Map<string, SkillEstimate>(
  ['a', 'b', 'c', 'd', 'e'].map((id) => [id, { rating: 1500, sd: 0 }]),
);
const singles = new Map([firstNight, secondNight, thirdNight].map((day) => [day, neutral]));

function played(id: string, time: number, overrides: Partial<DoublesSet> = {}): DoublesSet {
  return { id, time, p1: ['a', 'b'], p2: ['c', 'd'], winner: 1, outcome: 'played', ...overrides };
}

describe('evaluateDoubles', () => {
  it('does not treat two brackets on the same UTC night as held-out history', () => {
    const results = evaluateDoubles({
      sets: [played('upper-round-1', firstNight), played('lower-round-1', firstNight)],
      preNightSingles: singles,
    });

    expect(results).toMatchObject({
      eligibleNights: 1,
      eligibleSets: 2,
      overall: { status: 'insufficient-data', nights: 0, sets: 0 },
    });
  });

  it('predicts both brackets from the preceding night and uses each night’s own singles', () => {
    const earlier = played('first', firstNight);
    const target = [played('upper', secondNight), played('lower', secondNight, { p1: ['b', 'a'] })];
    const stronger = new Map(neutral);
    stronger.set('a', { rating: 1700, sd: 60 });
    stronger.set('c', { rating: 1500, sd: 80 });
    const preNightSingles = new Map(singles).set(secondNight, stronger);
    const results = evaluateDoubles({ sets: [target[1]!, earlier, target[0]!], preNightSingles });

    const trained = fitDoubles({
      sets: [earlier],
      skillAt: (id, day) => preNightSingles.get(day)!.get(id)!,
    });
    const pairProbability = trained.winProbability(['a', 'b'], ['c', 'd'], secondNight);
    const singlesProbability = probabilityFromRatings(
      100 / NATURAL_TO_DISPLAY,
      0,
      (30 ** 2 + 40 ** 2) / NATURAL_TO_DISPLAY ** 2,
    );

    expect(results.overall).toMatchObject({
      status: 'available',
      nights: 1,
      sets: 2,
      pairedNightIntervals: null,
      averageSingles: { logLoss: expect.closeTo(-Math.log(singlesProbability), 10) },
      pairResidual: { logLoss: expect.closeTo(-Math.log(pairProbability), 10) },
    });
  });

  it('counts recurring and new combinations using only earlier played nights', () => {
    const sets = [
      played('first', firstNight),
      played('recurring', secondNight, { p1: ['b', 'a'] }),
      played('new-a', secondNight, { p2: ['c', 'e'] }),
      played('new-b', secondNight, { p2: ['e', 'c'] }),
      played('next', thirdNight, { p2: ['e', 'c'] }),
      played('ignored', firstNight, { p2: ['c', 'e'], outcome: 'forfeit' }),
      played('unplayed-night', thirdNight + 1, { outcome: 'bye' }),
    ];
    const results = evaluateDoubles({ sets, preNightSingles: singles });

    expect(results).toMatchObject({
      eligibleNights: 3,
      eligibleSets: 5,
      overall: { status: 'available', nights: 2, sets: 4 },
      bothPairsPreviouslyObserved: { status: 'available', nights: 2, sets: 2 },
      anyNewPair: { status: 'available', nights: 1, sets: 2, pairedNightIntervals: null },
    });
    expect(evaluateDoubles({ sets: [...sets].reverse(), preNightSingles: singles })).toEqual(
      results,
    );
  });

  it('counts a tied forecast as half a realization whichever side is first', () => {
    const training = [played('first-a', firstNight), played('first-b', firstNight, { winner: 2 })];
    const target = played('target', secondNight);
    const swapped = { ...target, p1: target.p2, p2: target.p1, winner: 2 } as const;
    const normal = evaluateDoubles({ sets: [...training, target], preNightSingles: singles });
    const reversed = evaluateDoubles({ sets: [...training, swapped], preNightSingles: singles });
    const calibration = [{ lower: 0.5, upper: 0.6, count: 1, predicted: 0.5, observed: 0.5 }];

    expect(normal).toEqual(reversed);
    expect(normal.overall).toMatchObject({
      status: 'available',
      averageSingles: { calibration },
      pairResidual: { calibration },
    });
  });

  it('can match the production WHR games weight without changing the singles baseline', () => {
    const sweep = played('sweep', firstNight, { p1Games: 3, p2Games: 0 });
    const target = played('target', secondNight);
    const input = { sets: [sweep, target], preNightSingles: singles };
    const defaultScore = evaluateDoubles(input).overall;
    const unweighted = evaluateDoubles({ ...input, whrGamesWeight: 0 }).overall;
    if (defaultScore.status !== 'available' || unweighted.status !== 'available')
      throw new Error('Expected held-out predictions.');

    const expectedLogLoss = (gamesWeight: number) => {
      const fit = fitDoubles({ sets: [sweep], skillAt: (id) => neutral.get(id)!, gamesWeight });
      return -Math.log(fit.winProbability(target.p1, target.p2, target.time));
    };
    expect(defaultScore.pairResidual.logLoss).toBeCloseTo(expectedLogLoss(0.5), 12);
    expect(unweighted.pairResidual.logLoss).toBeCloseTo(expectedLogLoss(0), 12);
    expect(unweighted.pairResidual.logLoss).toBeGreaterThan(defaultScore.pairResidual.logLoss);
    expect(unweighted.averageSingles).toEqual(defaultScore.averageSingles);
  });

  it('reports paired whole-night uncertainty separately from set-weighted metrics', () => {
    const sets = [
      played('first', firstNight),
      ...Array.from({ length: 5 }, (_, i) => played(`second-${i}`, secondNight)),
      played('third', thirdNight, { winner: 2 }),
    ];
    const result = evaluateDoubles({ sets, preNightSingles: singles }).overall;
    const secondNightOnly = evaluateDoubles({
      sets: sets.slice(0, -1),
      preNightSingles: singles,
    }).overall;
    if (result.status !== 'available' || secondNightOnly.status !== 'available')
      throw new Error('Expected held-out predictions.');

    expect(result.averageSingles.logLoss).toBeCloseTo(Math.LN2);
    expect(result.averageSingles.brier).toBeCloseTo(0.25);
    expect(result.pairResidual.calibration.reduce((count, bin) => count + bin.count, 0)).toBe(6);
    expect(result.pairResidual.calibration.every((bin) => Number.isFinite(bin.observed))).toBe(
      true,
    );

    const secondDelta = secondNightOnly.pairResidual.logLoss - Math.LN2;
    const thirdDelta = 6 * (result.pairResidual.logLoss - Math.LN2) - 5 * secondDelta;
    expect(secondDelta).toBeLessThan(0);
    expect(thirdDelta).toBeGreaterThan(0);
    expect(result.pairedNightIntervals?.logLoss).toMatchObject({
      meanDifference: expect.closeTo((secondDelta + thirdDelta) / 2, 10),
      lower: expect.closeTo(secondDelta, 10),
      upper: expect.closeTo(thirdDelta, 10),
    });
    expect(result.pairedNightIntervals?.brier.lower).toBeLessThan(0);
    expect(result.pairedNightIntervals?.brier.upper).toBeGreaterThan(0);
  });

  it('rejects fractional days, duplicate sets and missing singles instead of silently changing evidence', () => {
    const sets = [played('first', firstNight), played('then', secondNight)];
    expect(() =>
      evaluateDoubles({ sets: [played('fractional', firstNight + 0.5)], preNightSingles: singles }),
    ).toThrow('UTC day');
    expect(() => evaluateDoubles({ sets: [...sets, sets[0]!], preNightSingles: singles })).toThrow(
      'Duplicate doubles result',
    );
    const withoutSecond = new Map<number, ReadonlyMap<string, SkillEstimate>>([
      [firstNight, neutral],
    ]);
    expect(() => evaluateDoubles({ sets, preNightSingles: withoutSecond })).toThrow(
      'Missing pre-night singles estimate',
    );
  });
});
