import { describe, expect, it } from 'vitest';
import { pairedBootstrap, walkForward, type EvalModel, type EvalSet } from '../src/evaluate';
import { coinFlipModel, whrModel } from '../src/models';

/**
 * The evaluation harness decides which rating model ships, so it needs its own
 * tests: a scorer that flatters a model would be worse than no scorer at all.
 */

function makeSets(): EvalSet[] {
  // Two events. 'strong' beats 'weak' consistently, so a model that learns
  // anything should out-predict a coin flip on the second event.
  const sets: EvalSet[] = [];
  for (let event = 0; event < 3; event++) {
    for (let i = 0; i < 12; i++) {
      sets.push({
        p1PlayerId: i % 2 === 0 ? 'strong' : 'weak',
        p2PlayerId: i % 2 === 0 ? 'weak' : 'strong',
        winner: i % 2 === 0 ? 1 : 2, // strong always wins
        tournamentId: `event-${event}`,
        time: event * 30,
      });
    }
  }
  return sets;
}

describe('walkForward', () => {
  it('scores a coin flip at exactly ln 2', () => {
    const { scores } = walkForward({ sets: makeSets(), models: [coinFlipModel], minTrainingEvents: 1 });
    expect(scores[0]!.logLoss).toBeCloseTo(Math.LN2, 10);
    expect(scores[0]!.brier).toBeCloseTo(0.25, 10);
    expect(scores[0]!.accuracy).toBeCloseTo(0.5, 10);
    expect(scores[0]!.uninformative).toBe(1);
  });

  it('rewards a model that learns the pattern', () => {
    const { scores } = walkForward({
      sets: makeSets(),
      models: [coinFlipModel, whrModel()],
      minTrainingEvents: 1,
    });
    const flip = scores.find((s) => s.name === coinFlipModel.name)!;
    const whr = scores.find((s) => s.name === 'whr')!;
    expect(whr.logLoss).toBeLessThan(flip.logLoss);
    expect(whr.accuracy).toBeGreaterThan(flip.accuracy);
  });

  it('never trains on the fold it predicts', () => {
    // This model can only answer when the set it is being asked about was in
    // its own training data — i.e. only if the harness leaked the test fold.
    // Given a leak it would score ~0; blind it must fall back to 0.5 and score
    // exactly ln 2.
    const key = (set: EvalSet): string =>
      `${set.tournamentId}|${set.p1PlayerId}|${set.p2PlayerId}|${set.winner}`;
    const leakDetector: EvalModel = {
      name: 'leak detector',
      fit: (training) => {
        const seen = new Set(training.map(key));
        return (set) => (seen.has(key(set)) ? (set.winner === 1 ? 0.999 : 0.001) : 0.5);
      },
    };
    const { scores } = walkForward({ sets: makeSets(), models: [leakDetector], minTrainingEvents: 1 });
    expect(scores[0]!.logLoss).toBeCloseTo(Math.LN2, 9);
    expect(scores[0]!.uninformative).toBe(1);
  });

  it('excludes the first events from scoring and counts folds correctly', () => {
    const sets = makeSets(); // 3 events
    const { folds, evaluatedSets } = walkForward({ sets, models: [coinFlipModel], minTrainingEvents: 2 });
    expect(folds).toBe(1); // only the third event is predicted
    expect(evaluatedSets).toBe(12);
  });

  it('folds calibration onto the upper half so bins are interpretable', () => {
    const { scores } = walkForward({
      sets: makeSets(),
      models: [whrModel()],
      minTrainingEvents: 1,
    });
    const bins = scores[0]!.calibration;
    expect(bins.every((bin) => bin.lower >= 0.5 && bin.upper <= 1)).toBe(true);
    const counted = bins.reduce((sum, bin) => sum + bin.count, 0);
    expect(counted).toBe(scores[0]!.predictions);
  });
});

describe('pairedBootstrap', () => {
  it('reports a clear win when one series is uniformly lower', () => {
    const a = Array.from({ length: 200 }, (_, i) => 0.4 + (i % 7) * 0.01);
    const b = a.map((x) => x + 0.15);
    const result = pairedBootstrap(a, b);
    expect(result.meanDifference).toBeLessThan(0);
    expect(result.upper).toBeLessThan(0); // whole interval below zero
    expect(result.probabilityANotWorse).toBeGreaterThan(0.99);
  });

  it('reports no distinguishable difference for interleaved noise', () => {
    const a = Array.from({ length: 200 }, (_, i) => 0.5 + ((i * 37) % 11) * 0.01);
    const b = Array.from({ length: 200 }, (_, i) => 0.5 + ((i * 53) % 11) * 0.01);
    const result = pairedBootstrap(a, b);
    expect(result.lower).toBeLessThan(0);
    expect(result.upper).toBeGreaterThan(0); // interval straddles zero
  });

  it('is deterministic for a given seed', () => {
    const a = Array.from({ length: 50 }, (_, i) => i / 100);
    const b = Array.from({ length: 50 }, (_, i) => (i + 3) / 100);
    expect(pairedBootstrap(a, b, { seed: 99 })).toEqual(pairedBootstrap(a, b, { seed: 99 }));
  });
});
