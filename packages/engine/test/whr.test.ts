import { describe, expect, it } from 'vitest';
import { fitWhr, probabilityFromRatings, NATURAL_TO_DISPLAY, type WhrSet } from '../src/whr';

/**
 * WHR is validated on data with a known answer: synthetic leagues generated from
 * fixed "true" skills, where a correct implementation must recover the ordering
 * and express sensible uncertainty. Deterministic throughout — no clock, no RNG.
 */

/** Simple LCG so the simulations are reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

interface SimOptions {
  players: number;
  events: number;
  setsPerEvent: number;
  seed?: number;
  /** Restrict pairing to a sub-range, for the disconnected-pools test. */
  poolFor?: (eventIndex: number, playerCount: number) => [number, number];
}

function simulate(options: SimOptions): { sets: WhrSet[]; trueSkill: number[] } {
  const random = makeRandom(options.seed ?? 7);
  // True skills spread across ~600 display points, in natural units.
  const trueSkill = Array.from({ length: options.players }, (_, i) => (i - options.players / 2) * (300 / options.players / NATURAL_TO_DISPLAY) * 2);
  const sets: WhrSet[] = [];
  for (let event = 0; event < options.events; event++) {
    const [lo, hi] = options.poolFor ? options.poolFor(event, options.players) : [0, options.players];
    const time = event * 60; // an event every 60 days
    for (let s = 0; s < options.setsPerEvent; s++) {
      const a = lo + Math.floor(random() * (hi - lo));
      let b = lo + Math.floor(random() * (hi - lo));
      if (a === b) b = lo + ((a + 1 - lo) % (hi - lo));
      const p = 1 / (1 + Math.exp(-(trueSkill[a]! - trueSkill[b]!)));
      sets.push({
        p1PlayerId: `p${a}`,
        p2PlayerId: `p${b}`,
        winner: random() < p ? 1 : 2,
        time,
      });
    }
  }
  return { sets, trueSkill };
}

function spearman(a: number[], b: number[]): number {
  const rank = (values: number[]): number[] => {
    const order = values.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
    const ranks = new Array<number>(values.length);
    order.forEach(([, index], position) => (ranks[index] = position));
    return ranks;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const mean = (n - 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i]! - mean) * (rb[i]! - mean);
    da += (ra[i]! - mean) ** 2;
    db += (rb[i]! - mean) ** 2;
  }
  return num / Math.sqrt(da * db);
}

describe('fitWhr', () => {
  it('recovers the true skill ordering from simulated play', () => {
    const { sets, trueSkill } = simulate({ players: 24, events: 6, setsPerEvent: 90, seed: 11 });
    const fit = fitWhr({ sets });
    expect(fit.converged).toBe(true);

    const ids = trueSkill.map((_, i) => `p${i}`);
    const estimated = ids.map((id) => fit.latest(id)?.r ?? 0);
    // With this much data the recovered ordering should track truth closely.
    expect(spearman(trueSkill, estimated)).toBeGreaterThan(0.9);
  });

  it('is invariant to the order sets are supplied in', () => {
    const { sets } = simulate({ players: 12, events: 3, setsPerEvent: 40, seed: 5 });
    const forward = fitWhr({ sets });
    const reversed = fitWhr({ sets: [...sets].reverse() });
    for (const id of forward.playerIds()) {
      expect(reversed.latest(id)!.r).toBeCloseTo(forward.latest(id)!.r, 6);
    }
  });

  it('gives a one-event player wider uncertainty than a regular', () => {
    const sets = [
      // A regular with many results across several events.
      ...simulate({ players: 8, events: 4, setsPerEvent: 40, seed: 3 }).sets,
      // A newcomer with a single set at the last event.
      { p1PlayerId: 'newcomer', p2PlayerId: 'p1', winner: 1 as const, time: 180 },
    ];
    const fit = fitWhr({ sets });
    const newcomer = fit.latest('newcomer')!;
    const regular = fit.latest('p1')!;
    expect(newcomer.variance).toBeGreaterThan(regular.variance);
  });

  it('keeps disconnected pools near the prior instead of inventing a gap', () => {
    // Two pools that never play each other: 0-9 and 10-19.
    const { sets } = simulate({
      players: 20,
      events: 6,
      setsPerEvent: 80,
      seed: 21,
      poolFor: (event, count) => (event % 2 === 0 ? [0, count / 2] : [count / 2, count]),
    });
    const fit = fitWhr({ sets });
    const poolA = Array.from({ length: 10 }, (_, i) => fit.latest(`p${i}`)!.r);
    const poolB = Array.from({ length: 10 }, (_, i) => fit.latest(`p${i + 10}`)!.r);
    const meanA = poolA.reduce((s, x) => s + x, 0) / poolA.length;
    const meanB = poolB.reduce((s, x) => s + x, 0) / poolB.length;
    // Neither pool can be shown stronger, so both centre near the prior (0).
    expect(Math.abs(meanA)).toBeLessThan(0.6);
    expect(Math.abs(meanB)).toBeLessThan(0.6);
  });

  it('widens uncertainty for time since a player was last seen', () => {
    const { sets } = simulate({ players: 8, events: 2, setsPerEvent: 40, seed: 9 });
    const fit = fitWhr({ sets });
    const atLastEvent = fit.at('p1', 60);
    const muchLater = fit.at('p1', 60 + 365);
    expect(muchLater.variance).toBeGreaterThan(atLastEvent.variance);
    expect(muchLater.r).toBeCloseTo(atLastEvent.r, 9); // drift adds doubt, not movement
  });

  it('converts to the familiar 1500-centred display scale', () => {
    const sets: WhrSet[] = [{ p1PlayerId: 'a', p2PlayerId: 'b', winner: 1, time: 0 }];
    const fit = fitWhr({ sets });
    const a = fit.display('a');
    const b = fit.display('b');
    expect(a.rating).toBeGreaterThan(1500);
    expect(b.rating).toBeLessThan(1500);
    expect(a.sd).toBeGreaterThan(0);
  });
});

describe('probabilityFromRatings', () => {
  it('is 0.5 for equal ratings and monotonic in the difference', () => {
    expect(probabilityFromRatings(0, 0, 0)).toBeCloseTo(0.5, 12);
    expect(probabilityFromRatings(1, 0, 0)).toBeGreaterThan(0.5);
    expect(probabilityFromRatings(2, 0, 0)).toBeGreaterThan(probabilityFromRatings(1, 0, 0));
  });

  it('pulls predictions toward 0.5 as uncertainty grows', () => {
    const confident = probabilityFromRatings(1, 0, 0.01);
    const unsure = probabilityFromRatings(1, 0, 4);
    expect(unsure).toBeLessThan(confident);
    expect(unsure).toBeGreaterThan(0.5);
  });
});
