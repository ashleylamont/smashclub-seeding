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

import {
  calibrate,
  clampProbability,
  predictionErrors,
  type CalibrationBin,
} from './evaluationMetrics';

export { pairedBootstrap, type CalibrationBin } from './evaluationMetrics';

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
  /**
   * Expected accuracy if this model's stated probabilities were perfectly
   * calibrated: mean(max(p, 1−p)).
   *
   * This is the honest ceiling, and it is the number that makes raw accuracy
   * interpretable. Bracket sets are seeded to be competitive, so many are
   * genuinely close to even — and a set the model *correctly* calls at 55% is
   * still lost 45% of the time. Comparing accuracy to 50% asks "is it better
   * than guessing"; comparing it to this asks "is it extracting what is there",
   * which is the answerable question.
   */
  accuracyCeiling: number;
  /** Accuracy over only the predictions where the model had information. */
  informedAccuracy: number;
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

  const accumulator = new Map<
    string,
    { losses: number[]; briers: number[]; correct: number; probs: number[]; outcomes: number[] }
  >();
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
        const { logLoss, brier } = predictionErrors(p, outcome);
        bucket.losses.push(logLoss);
        bucket.briers.push(brier);
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
      accuracyCeiling: bucket.probs.reduce((s, p) => s + Math.max(p, 1 - p), 0) / n,
      informedAccuracy: (() => {
        let informed = 0;
        let right = 0;
        bucket.probs.forEach((p, i) => {
          if (Math.abs(p - 0.5) < 1e-9) return;
          informed += 1;
          if ((p > 0.5 ? 1 : 0) === bucket.outcomes[i]) right += 1;
        });
        return informed === 0 ? 0.5 : right / informed;
      })(),
    };
  });

  return { scores, folds, evaluatedSets };
}
