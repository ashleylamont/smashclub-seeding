import { describe, expect, it } from 'vitest';
import {
  averagePairSkill,
  doublesPairKey,
  fitDoubles,
  type DoublesSet,
  type Pair,
} from '../src/doubles';
import { fitWhr, NATURAL_TO_DISPLAY } from '../src/whr';

const a: Pair = ['a', 'b'],
  b: Pair = ['c', 'd'];
const equal = () => ({ rating: 1500, sd: 30 });
const history = (wins: number, total: number, time = 0): DoublesSet[] =>
  Array.from({ length: total }, (_, i) => ({
    id: `${time}:${i}`,
    time,
    p1: a,
    p2: b,
    winner: i < wins ? 1 : 2,
  }));

describe('doubles strength and whole-history residuals', () => {
  it('averages skill and propagates variance before calculating the conservative score', () => {
    expect(averagePairSkill({ rating: 1800, sd: 60 }, { rating: 1400, sd: 80 })).toEqual({
      rating: 1600,
      sd: 50,
      conservativeRating: 1500,
    });
    expect(averagePairSkill({ rating: 1400, sd: 80 }, { rating: 1800, sd: 60 })).toEqual({
      rating: 1600,
      sd: 50,
      conservativeRating: 1500,
    });
  });
  it('uses unordered member identities, without collisions between ambiguous strings', () => {
    expect(doublesPairKey(['a', 'b'])).toBe(doublesPairKey(['b', 'a']));
    expect(doublesPairKey(['a:b', 'c'])).not.toBe(doublesPairKey(['a', 'b:c']));
    expect(() => doublesPairKey(['a', 'a'])).toThrow(/distinct/);
  });
  it('starts unseen combinations at their members’ average with a zero-centred correction', () => {
    const fit = fitDoubles({
      sets: [],
      skillAt: (id) => ({ rating: id === 'a' ? 1800 : 1400, sd: 60 }),
    });
    expect(fit.rating(a, 0).rating).toBe(1600);
    expect(fit.rating(a, 0).adjustment).toBe(0);
    expect(fit.winProbability(a, b, 0)).toBeGreaterThan(0.5);
  });
  it('adds prior uncertainty, not a learned mean penalty, to a cold pair seed', () => {
    const fit = fitDoubles({ sets: [], skillAt: () => ({ rating: 1600, sd: 60 }) });
    const base = fit.baseline(a, 0),
      adjusted = fit.rating(a, 0);
    expect(adjusted.rating).toBe(base.rating);
    expect(adjusted.adjustment).toBe(0);
    expect(adjusted.adjustmentSd).toBeCloseTo(0.25 * NATURAL_TO_DISPLAY, 10);
    expect(adjusted.sd ** 2).toBeCloseTo(base.sd ** 2 + (0.25 * NATURAL_TO_DISPLAY) ** 2, 8);
    expect(adjusted.conservativeRating).toBeCloseTo(base.rating - 2 * adjusted.sd, 10);
    expect(adjusted.conservativeRating).toBeLessThan(base.conservativeRating);
    expect(fit.evidence(a)).toEqual({ playedSets: 0, eventDays: 0 });
  });
  it('counts only this unordered pair’s played evidence, independently of margin weights', () => {
    const fit = fitDoubles({
      sets: [
        ...history(2, 3, 0).map((s) => ({ ...s, p1Games: 3, p2Games: 0 })),
        ...history(1, 2, 7),
        { ...history(1, 1, 8)[0]!, outcome: 'forfeit' },
      ],
      skillAt: equal,
    });
    expect(fit.evidence(a)).toEqual({ playedSets: 5, eventDays: 2 });
    expect(fit.evidence(['b', 'a'])).toEqual(fit.evidence(a));
    expect(fit.evidence(['a', 'e'])).toEqual({ playedSets: 0, eventDays: 0 });
    expect(fit.rating(['a', 'e'], 9).adjustment).toBe(0);
  });
  it('recovers an independently solved MAP optimum with a known baseline advantage', () => {
    const tau = 0.4,
      offset = 200 / NATURAL_TO_DISPLAY;
    const fit = fitDoubles({
      sets: history(17, 20),
      skillAt: (id) => ({ rating: a.includes(id) ? 1700 : 1500, sd: 0 }),
      config: { priorSd: tau, tolerance: 1e-10, maxIterations: 1000 },
    });
    // Solve the scalar posterior derivative independently: residuals are +x and -x.
    let lo = -10,
      hi = 10;
    for (let i = 0; i < 100; i++) {
      const x = (lo + hi) / 2,
        p = 1 / (1 + Math.exp(-(offset + 2 * x)));
      if (20 * (0.85 - p) - x / tau ** 2 > 0) lo = x;
      else hi = x;
    }
    expect(fit.converged).toBe(true);
    expect(fit.rating(a, 0).adjustment).toBeCloseTo(((lo + hi) / 2) * NATURAL_TO_DISPLAY, 5);
    expect(fit.rating(b, 0).adjustment).toBeCloseTo((-(lo + hi) / 2) * NATURAL_TO_DISPLAY, 5);
    const p = 1 / (1 + Math.exp(-(offset + lo + hi)));
    const conditionalVariance = 1 / (1 / tau ** 2 + 20 * p * (1 - p));
    expect((fit.rating(a, 0).adjustmentSd / NATURAL_TO_DISPLAY) ** 2).toBeCloseTo(
      conditionalVariance,
      9,
    );
  });
  it('does not call predictable wins a large synergy bonus', () => {
    const fit = fitDoubles({
      sets: history(91, 100),
      skillAt: (id) => ({ rating: a.includes(id) ? 1800 : 1400, sd: 0 }),
    });
    expect(Math.abs(fit.rating(a, 0).adjustment)).toBeLessThan(2);
  });
  it('learns a negative correction when a strong pair underperforms its baseline', () => {
    const fit = fitDoubles({
      sets: history(5, 10),
      skillAt: (id) => ({ rating: a.includes(id) ? 1800 : 1400, sd: 0 }),
    });
    expect(fit.rating(a, 0).adjustment).toBeLessThan(0);
    expect(fit.rating(b, 0).adjustment).toBeGreaterThan(0);
  });
  it('updates a pair without transferring its residual to a new partner', () => {
    const fit = fitDoubles({ sets: history(8, 8), skillAt: equal });
    expect(fit.rating(a, 0).adjustment).toBeGreaterThan(0);
    expect(fit.rating(['a', 'e'], 0).adjustment).toBe(0);
    expect(fit.rating(['b', 'a'], 0)).toEqual(fit.rating(a, 0));
  });
  it('is symmetric under side swapping, partner swapping, and input reordering', () => {
    const sets = history(7, 10);
    const fit = fitDoubles({ sets, skillAt: equal });
    const swap = fitDoubles({
      sets: [...sets].reverse().map((s) => ({
        ...s,
        p1: [s.p2[1], s.p2[0]],
        p2: [s.p1[1], s.p1[0]],
        winner: s.winner === 1 ? 2 : 1,
      })),
      skillAt: equal,
    });
    expect(swap.rating(a, 0).rating).toBeCloseTo(fit.rating(a, 0).rating, 7);
    expect(fit.winProbability(a, b, 0) + fit.winProbability(b, a, 0)).toBeCloseTo(1, 12);
  });
  it('gives balanced evidence zero corrections and more evidence tightens uncertainty', () => {
    const thin = fitDoubles({ sets: history(1, 2), skillAt: equal }),
      rich = fitDoubles({ sets: history(50, 100), skillAt: equal });
    expect(rich.rating(a, 0).adjustment).toBeCloseTo(0, 8);
    expect(rich.rating(a, 0).adjustmentSd).toBeLessThan(thin.rating(a, 0).adjustmentSd);
    expect(rich.winProbability(a, b, 0)).toBe(0.5);
  });
  it('discounts a one-night sweep and never produces extreme probabilities from it', () => {
    const fit = fitDoubles({ sets: history(3, 3), skillAt: equal });
    expect(fit.rating(a, 0).adjustment).toBeGreaterThan(0);
    expect(fit.rating(a, 0).adjustment).toBeLessThan(30);
    expect(fit.winProbability(a, b, 0)).toBeLessThan(0.65);
  });
  it('uses historical baseline offsets at each night rather than one initial prior', () => {
    const fit = fitDoubles({
      sets: [...history(5, 10, 0), ...history(9, 10, 100)],
      skillAt: (id, time) => ({ rating: 1500 + (a.includes(id) && time >= 100 ? 400 : 0), sd: 0 }),
    });
    expect(Math.abs(fit.rating(a, 100).adjustment)).toBeLessThan(3);
    expect(fit.rating(a, 100).rating).toBeGreaterThan(1897);
  });
  it('widens stale pair uncertainty without inventing mean reversion', () => {
    const fit = fitDoubles({ sets: history(7, 10), skillAt: equal });
    expect(fit.rating(a, 365).adjustment).toBe(fit.rating(a, 0).adjustment);
    expect(fit.rating(a, 365).sd).toBeGreaterThan(fit.rating(a, 0).sd);
    expect(fit.rating(a, 365).conservativeRating).toBeLessThan(fit.rating(a, 0).conservativeRating);
  });
  it('records no rating evidence for forfeits, byes, or no contests', () => {
    const fit = fitDoubles({
      sets: history(3, 3).map((s, i) => ({
        ...s,
        outcome: (['forfeit', 'bye', 'no_contest'] as const)[i],
      })),
      skillAt: equal,
    });
    expect(fit.pairs).toEqual([]);
    expect(fit.rating(a, 0).adjustment).toBe(0);
  });
  it('weights decisive played scorelines using the existing capped set evidence rule', () => {
    const close = fitDoubles({
      sets: history(1, 1).map((s) => ({ ...s, p1Games: 3, p2Games: 2 })),
      skillAt: equal,
    });
    const sweep = fitDoubles({
      sets: history(1, 1).map((s) => ({ ...s, p1Games: 3, p2Games: 0 })),
      skillAt: equal,
    });
    const two = fitDoubles({ sets: history(2, 2), skillAt: equal });
    expect(sweep.rating(a, 0).adjustment).toBeGreaterThan(close.rating(a, 0).adjustment);
    expect(sweep.rating(a, 0).adjustment).toBeCloseTo(two.rating(a, 0).adjustment, 8);
  });
  it('reduces confidence in predictions when individual skills are uncertain', () => {
    const confident = fitDoubles({
      sets: [],
      skillAt: (id) => ({ rating: a.includes(id) ? 1700 : 1500, sd: 0 }),
    });
    const uncertain = fitDoubles({
      sets: [],
      skillAt: (id) => ({ rating: a.includes(id) ? 1700 : 1500, sd: 300 }),
    });
    expect(uncertain.winProbability(a, b, 0)).toBeGreaterThan(0.5);
    expect(uncertain.winProbability(a, b, 0)).toBeLessThan(confident.winProbability(a, b, 0));
  });
  it('rejects invalid membership, duplicate evidence, and non-finite numerical inputs', () => {
    expect(() =>
      fitDoubles({ sets: [{ ...history(1, 1)[0]!, p2: ['b', 'c'] }], skillAt: equal }),
    ).toThrow(/four distinct/);
    expect(() =>
      fitDoubles({ sets: [...history(1, 1), ...history(1, 1)], skillAt: equal }),
    ).toThrow(/Duplicate/);
    expect(() => fitDoubles({ sets: [], skillAt: equal, baselineScale: NaN })).toThrow(/finite/);
    expect(() => averagePairSkill({ rating: Infinity, sd: 1 }, equal())).toThrow(/finite/);
    expect(() => averagePairSkill({ rating: 1500, sd: -1 }, equal())).toThrow(/nonnegative/);
  });
  it('preserves singles numerical results when the new WHR offset is absent or zero', () => {
    const sets = history(7, 10).map((s) => ({
      p1PlayerId: 'a',
      p2PlayerId: 'b',
      time: s.time,
      winner: s.winner,
    }));
    const original = fitWhr({ sets }),
      explicit = fitWhr({ sets: sets.map((s) => ({ ...s, logOddsOffset: 0 })) });
    expect(explicit.track('a')).toEqual(original.track('a'));
    expect(explicit.track('b')).toEqual(original.track('b'));
  });
  it('improves held-out predictions on a reproducible multi-night club with persistent pair effects', () => {
    const pairs: Pair[] = Array.from({ length: 6 }, (_, i) => [`p${i}a`, `p${i}b`]);
    const effects = [0.8, -0.5, 0.4, -0.8, 0.6, -0.5];
    let seed = 7241;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const skillAt = (id: string) => ({ rating: 1500 + (Number(id[1]) - 2.5) * 55, sd: 0 });
    const sample = (count: number, firstNight: number): DoublesSet[] =>
      Array.from({ length: count }, (_, i) => {
        const x = Math.floor(random() * 6);
        let y = Math.floor(random() * 5);
        if (y >= x) y++;
        const offset =
          (skillAt(pairs[x]![0]).rating - skillAt(pairs[y]![0]).rating) / NATURAL_TO_DISPLAY;
        const p = 1 / (1 + Math.exp(-(offset + effects[x]! - effects[y]!)));
        return {
          id: `${firstNight}:${i}`,
          time: (firstNight + Math.floor(i / 60)) * 7,
          p1: pairs[x]!,
          p2: pairs[y]!,
          winner: random() < p ? 1 : 2,
        };
      });
    const training = sample(600, 0),
      testing = sample(1000, 10);
    const learned = fitDoubles({ sets: training, skillAt }),
      baseline = fitDoubles({ sets: [], skillAt });
    const loss = (model: ReturnType<typeof fitDoubles>) =>
      testing.reduce((sum, s) => {
        const p = model.winProbability(s.p1, s.p2, s.time);
        return sum - Math.log(s.winner === 1 ? p : 1 - p);
      }, 0) / testing.length;
    expect(learned.converged).toBe(true);
    expect(loss(learned)).toBeLessThan(loss(baseline) - 0.015);
    for (const pair of pairs) expect(learned.rating(pair, 70).sd).toBeGreaterThan(0);
  });
  it('rejects invalid residual priors, drift, evidence weights, and prediction times', () => {
    expect(() => fitDoubles({ sets: [], skillAt: equal, config: { priorSd: 0 } })).toThrow(
      /positive/,
    );
    expect(() =>
      fitDoubles({ sets: [], skillAt: equal, config: { driftVariancePerDay: -1 } }),
    ).toThrow(/positive/);
    expect(() => fitDoubles({ sets: [], skillAt: equal, gamesWeight: NaN })).toThrow(/weight/);
    expect(() => fitDoubles({ sets: [], skillAt: equal }).rating(a, Infinity)).toThrow(/time/);
  });
});
