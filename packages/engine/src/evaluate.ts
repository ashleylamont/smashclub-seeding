/**
 * Walk-forward evaluation of rating models.
 *
 * The only honest test of a rating system is out-of-sample prediction: fit on
 * events 1..n, predict every set in event n+1, and score how well. A model that
 * merely describes past results well can be badly overfitted; one that predicts
 * future results is genuinely better.
 *
 * Metrics:
 *  - **log loss** (primary). Proper scoring rule, punishes confident mistakes.
 *  - **Brier score.** Also proper, less brutal about extremes.
 *  - **accuracy.** Intuitive but insensitive — a model can improve a lot
 *    without flipping many binary predictions.
 *  - **calibration.** Of the sets predicted at ~70%, did ~70% happen? A model
 *    can rank well yet state probabilities that mean nothing.
 *
 * On this dataset the whole history is ~10 event days and ~600 predictable
 * sets, so differences between decent models carry real uncertainty. Paired
 * bootstrap confidence intervals over per-set log-loss differences are reported
 * so a winner is only declared when the data supports it.
 */

export interface EvalSet {
  p1PlayerId: string;
  p2PlayerId: string;
  winner: 1 | 2;
  /** Chronological event grouping key. */
  tournamentId: string;
  /** Days since an arbitrary origin. */
  time: number;
  trials?: number;
}

/** A model is anything that can be fitted to history and asked for a probability. */
export interface EvalModel {
  name: string;
  fit(trainingSets: readonly EvalSet[]): (set: EvalSet) => number;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  predicted: number;
  observed: number;
}

export interface ModelScore {
  name: string;
  predictions: number;
  logLoss: number;
  brier: number;
  accuracy: number;
  /** Per-set log losses, aligned across models for paired comparison. */
  perSetLogLoss: number[];
  calibration: CalibrationBin[];
  /** Fraction of predictions that were exactly 0.5 (i.e. no information). */
  uninformative: number;
}

function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1 - 1e-9, Math.max(1e-9, p));
}

/**
 * Runs the walk-forward protocol. Each model sees exactly the same folds and
 * the same set order, so their per-set losses can be compared pairwise.
 */
export function walkForward(input: {
  sets: readonly EvalSet[];
  models: readonly EvalModel[];
  /** Skip folds until this many events have been seen (a cold model predicts nothing useful). */
  minTrainingEvents?: number;
}): { scores: ModelScore[]; folds: number; evaluatedSets: number } {
  const minTrainingEvents = input.minTrainingEvents ?? 1;

  // Order events chronologically; ties (same-day main + rookie brackets) are
  // kept as separate folds, ordered deterministically by id.
  const eventTime = new Map<string, number>();
  for (const set of input.sets) {
    const current = eventTime.get(set.tournamentId);
    if (current === undefined || set.time < current) eventTime.set(set.tournamentId, set.time);
  }
  const events = [...eventTime.entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => id);

  const setsByEvent = new Map<string, EvalSet[]>();
  for (const set of input.sets) {
    const list = setsByEvent.get(set.tournamentId) ?? [];
    list.push(set);
    setsByEvent.set(set.tournamentId, list);
  }

  const accumulator = new Map<string, { losses: number[]; briers: number[]; correct: number; probs: number[]; outcomes: number[] }>();
  for (const model of input.models) {
    accumulator.set(model.name, { losses: [], briers: [], correct: 0, probs: [], outcomes: [] });
  }

  let folds = 0;
  let evaluatedSets = 0;

  for (let index = minTrainingEvents; index < events.length; index++) {
    const trainingEvents = new Set(events.slice(0, index));
    const training = input.sets.filter((set) => trainingEvents.has(set.tournamentId));
    const testing = setsByEvent.get(events[index]!) ?? [];
    if (testing.length === 0) continue;
    folds += 1;
    evaluatedSets += testing.length;

    for (const model of input.models) {
      const predict = model.fit(training);
      const bucket = accumulator.get(model.name)!;
      for (const set of testing) {
        const p = clampProbability(predict(set));
        const outcome = set.winner === 1 ? 1 : 0;
        bucket.losses.push(-(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p)));
        bucket.briers.push((p - outcome) ** 2);
        // A 0.5 prediction is a coin flip; count it as half-correct so a
        // no-information model scores 50% rather than 0% or 100%.
        bucket.correct += Math.abs(p - 0.5) < 1e-9 ? 0.5 : (p > 0.5 ? 1 : 0) === outcome ? 1 : 0;
        bucket.probs.push(p);
        bucket.outcomes.push(outcome);
      }
    }
  }

  const scores: ModelScore[] = input.models.map((model) => {
    const bucket = accumulator.get(model.name)!;
    const n = bucket.losses.length || 1;
    return {
      name: model.name,
      predictions: bucket.losses.length,
      logLoss: bucket.losses.reduce((s, x) => s + x, 0) / n,
      brier: bucket.briers.reduce((s, x) => s + x, 0) / n,
      accuracy: bucket.correct / n,
      perSetLogLoss: bucket.losses,
      calibration: calibrate(bucket.probs, bucket.outcomes),
      uninformative: bucket.probs.filter((p) => Math.abs(p - 0.5) < 1e-9).length / n,
    };
  });

  return { scores, folds, evaluatedSets };
}

function calibrate(probs: number[], outcomes: number[], bins = 5): CalibrationBin[] {
  // Predictions are symmetric (p and 1−p describe the same set from either
  // side), so fold onto [0.5, 1] where the bins are interpretable.
  const folded = probs.map((p, i) => (p >= 0.5 ? { p, o: outcomes[i]! } : { p: 1 - p, o: 1 - outcomes[i]! }));
  const out: CalibrationBin[] = [];
  for (let b = 0; b < bins; b++) {
    const lower = 0.5 + (0.5 * b) / bins;
    const upper = 0.5 + (0.5 * (b + 1)) / bins;
    const inBin = folded.filter(({ p }) => p >= lower && (b === bins - 1 ? p <= upper : p < upper));
    out.push({
      lower,
      upper,
      count: inBin.length,
      predicted: inBin.length ? inBin.reduce((s, x) => s + x.p, 0) / inBin.length : NaN,
      observed: inBin.length ? inBin.reduce((s, x) => s + x.o, 0) / inBin.length : NaN,
    });
  }
  return out;
}

/**
 * Paired bootstrap on the per-set log-loss difference. Deterministic: uses a
 * seeded LCG so results are reproducible and no clock or Math.random is needed.
 */
export function pairedBootstrap(
  a: readonly number[],
  b: readonly number[],
  options: { resamples?: number; seed?: number } = {},
): { meanDifference: number; lower: number; upper: number; probabilityANotWorse: number } {
  const resamples = options.resamples ?? 2000;
  let seed = options.seed ?? 12345;
  const n = Math.min(a.length, b.length);
  if (n === 0) return { meanDifference: NaN, lower: NaN, upper: NaN, probabilityANotWorse: NaN };

  const differences = Array.from({ length: n }, (_, i) => a[i]! - b[i]!);
  const mean = differences.reduce((s, x) => s + x, 0) / n;

  const nextRandom = (): number => {
    // Numerical Recipes LCG.
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const means: number[] = [];
  let aNotWorse = 0;
  for (let r = 0; r < resamples; r++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += differences[Math.floor(nextRandom() * n)]!;
    const resampleMean = total / n;
    means.push(resampleMean);
    if (resampleMean <= 0) aNotWorse += 1;
  }
  means.sort((x, y) => x - y);
  return {
    meanDifference: mean,
    lower: means[Math.floor(0.025 * resamples)]!,
    upper: means[Math.floor(0.975 * resamples)]!,
    probabilityANotWorse: aNotWorse / resamples,
  };
}
