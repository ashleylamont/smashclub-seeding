import {
  averagePairSkill,
  doublesPairKey,
  fitDoubles,
  type DoublesSet,
  type SkillEstimate,
} from './doubles';
import {
  calibrate,
  clampProbability,
  pairedBootstrap,
  predictionErrors,
  type CalibrationBin,
} from './evaluationMetrics';
import { NATURAL_TO_DISPLAY, probabilityFromRatings } from './whr';

export interface DoublesEvaluationInput {
  /** Latest eligible results. Each set's `time` is its integer UTC day since 1970-01-01. */
  sets: readonly DoublesSet[];
  /** One map per UTC day, derived from strictly earlier singles results. */
  preNightSingles: ReadonlyMap<number, ReadonlyMap<string, SkillEstimate>>;
  /** Pair model game-margin weight. Defaults to the engine's 0.5. */
  whrGamesWeight?: number;
}

interface DoublesModelScore {
  logLoss: number;
  brier: number;
  calibration: CalibrationBin[];
}

interface DifferenceInterval {
  meanDifference: number;
  lower: number;
  upper: number;
}

export type DoublesEvaluationComparison =
  | { status: 'insufficient-data'; nights: 0; sets: 0 }
  | {
      status: 'available';
      nights: number;
      sets: number;
      averageSingles: DoublesModelScore;
      pairResidual: DoublesModelScore;
      /**
       * Descriptive percentile intervals of equal-weight night means, pair minus singles.
       * Requires at least two held-out nights. With two nights, the bounds are their two differences.
       */
      pairedNightIntervals: { logLoss: DifferenceInterval; brier: DifferenceInterval } | null;
    };

function prediction(probability: number, outcome: number) {
  if (!Number.isFinite(probability)) throw new Error('Non-finite doubles prediction.');
  const p = clampProbability(probability);
  return { probability: p, ...predictionErrors(p, outcome) };
}

interface HeldOutSet {
  outcome: number;
  bothPreviouslyObserved: boolean;
  averageSingles: ReturnType<typeof prediction>;
  pairResidual: ReturnType<typeof prediction>;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compare(nights: HeldOutSet[][]): DoublesEvaluationComparison {
  const observedNights = nights.filter((night) => night.length > 0);
  const sets = observedNights.flat();
  if (!sets.length) return { status: 'insufficient-data', nights: 0, sets: 0 };

  const outcomes = sets.map(({ outcome }) => outcome);
  const score = (arm: 'averageSingles' | 'pairResidual'): DoublesModelScore => ({
    logLoss: mean(sets.map((set) => set[arm].logLoss)),
    brier: mean(sets.map((set) => set[arm].brier)),
    calibration: calibrate(
      sets.map((set) => set[arm].probability),
      outcomes,
      { splitTies: true },
    ).filter((bin) => bin.count > 0),
  });
  const interval = (metric: 'logLoss' | 'brier'): DifferenceInterval => {
    const { meanDifference, lower, upper } = pairedBootstrap(
      observedNights.map((night) => mean(night.map((set) => set.pairResidual[metric]))),
      observedNights.map((night) => mean(night.map((set) => set.averageSingles[metric]))),
    );
    return { meanDifference, lower, upper };
  };

  return {
    status: 'available',
    nights: observedNights.length,
    sets: sets.length,
    averageSingles: score('averageSingles'),
    pairResidual: score('pairResidual'),
    pairedNightIntervals:
      observedNights.length >= 2
        ? { logLoss: interval('logLoss'), brier: interval('brier') }
        : null,
  };
}

/**
 * Compare the pair residual model with average singles on identical held-out sets.
 * The caller supplies the historical singles snapshots. A snapshot's provenance cannot
 * be inferred from its estimates. All results from the target day enter the fit together
 * only after both arms predict that day.
 */
export function evaluateDoubles({ sets, preNightSingles, whrGamesWeight }: DoublesEvaluationInput) {
  const skillAt = (id: string, day: number) => {
    const skill = preNightSingles.get(day)?.get(id);
    if (!skill) throw new Error(`Missing pre-night singles estimate for ${id} on UTC day ${day}.`);
    return skill;
  };
  const byDay = new Map<number, DoublesSet[]>();
  const seen = new Set<string>();
  for (const set of sets) {
    if (set.outcome && set.outcome !== 'played') continue;
    if (!Number.isSafeInteger(set.time))
      throw new Error('Doubles result needs an integer UTC day.');
    if (seen.has(set.id)) throw new Error('Duplicate doubles result.');
    if (!set.id || (set.winner !== 1 && set.winner !== 2))
      throw new Error('Invalid doubles result.');
    doublesPairKey(set.p1);
    doublesPairKey(set.p2);
    const players = new Set([...set.p1, ...set.p2]);
    if (players.size !== 4) throw new Error('A doubles match needs four distinct players.');
    for (const player of players) skillAt(player, set.time);
    seen.add(set.id);
    const night = byDay.get(set.time);
    if (night) night.push(set);
    else byDay.set(set.time, [set]);
  }

  const earlier: DoublesSet[] = [];
  const heldOut: HeldOutSet[][] = [];
  for (const [day, night] of [...byDay].sort(([a], [b]) => a - b)) {
    night.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (earlier.length) {
      const fit = fitDoubles({ sets: earlier, skillAt, gamesWeight: whrGamesWeight });
      if (!fit.converged)
        throw new Error(`Doubles pair fit did not converge before UTC day ${day}.`);
      heldOut.push(
        night.map((set) => {
          const first = averagePairSkill(skillAt(set.p1[0], day), skillAt(set.p1[1], day));
          const second = averagePairSkill(skillAt(set.p2[0], day), skillAt(set.p2[1], day));
          const baseline = probabilityFromRatings(
            (first.rating - second.rating) / NATURAL_TO_DISPLAY,
            0,
            (first.sd ** 2 + second.sd ** 2) / NATURAL_TO_DISPLAY ** 2,
          );
          const outcome = set.winner === 1 ? 1 : 0;
          return {
            outcome,
            averageSingles: prediction(baseline, outcome),
            pairResidual: prediction(fit.winProbability(set.p1, set.p2, day), outcome),
            bothPreviouslyObserved:
              fit.evidence(set.p1).eventDays > 0 && fit.evidence(set.p2).eventDays > 0,
          };
        }),
      );
    }
    for (const set of night) earlier.push(set);
  }

  return {
    eligibleNights: byDay.size,
    eligibleSets: seen.size,
    overall: compare(heldOut),
    bothPairsPreviouslyObserved: compare(
      heldOut.map((night) => night.filter((set) => set.bothPreviouslyObserved)),
    ),
    anyNewPair: compare(heldOut.map((night) => night.filter((set) => !set.bothPreviouslyObserved))),
  };
}
