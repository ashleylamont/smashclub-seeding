/**
 * The rating models under comparison, wrapped in the evaluation interface so
 * they can be scored against each other and against naive baselines on
 * identical folds.
 */
import {
  DISPLAY_CENTRE,
  NATURAL_TO_DISPLAY,
  defaultWhrConfig,
  fitWhr,
  probabilityFromRatings,
  type WhrConfig,
} from './whr';
import type { EvalModel } from './evaluate';

/** Always 50/50 — the floor any useful model must beat. */
export const coinFlipModel: EvalModel = {
  name: 'baseline: coin flip',
  fit: () => () => 0.5,
};

/**
 * Predicts the more experienced player, where experience is prior sets played.
 * A deliberately dumb baseline that nonetheless captures something real in a
 * club where regulars beat newcomers.
 */
export const experienceModel: EvalModel = {
  name: 'baseline: more experienced',
  fit: (training) => {
    const counts = new Map<string, number>();
    for (const set of training) {
      counts.set(set.p1PlayerId, (counts.get(set.p1PlayerId) ?? 0) + 1);
      counts.set(set.p2PlayerId, (counts.get(set.p2PlayerId) ?? 0) + 1);
    }
    return (set) => {
      const a = counts.get(set.p1PlayerId) ?? 0;
      const b = counts.get(set.p2PlayerId) ?? 0;
      if (a === b) return 0.5;
      // Deliberately mild: experience is a weak signal, so don't overclaim.
      return a > b ? 0.62 : 0.38;
    };
  },
};

/** Win rate over prior sets, ignoring who the opponents were. */
export const winRateModel: EvalModel = {
  name: 'baseline: raw win rate',
  fit: (training) => {
    const wins = new Map<string, number>();
    const games = new Map<string, number>();
    for (const set of training) {
      for (const [id, won] of [
        [set.p1PlayerId, set.winner === 1],
        [set.p2PlayerId, set.winner === 2],
      ] as [string, boolean][]) {
        games.set(id, (games.get(id) ?? 0) + 1);
        if (won) wins.set(id, (wins.get(id) ?? 0) + 1);
      }
    }
    // Laplace smoothing keeps a 1-0 player from being called a certainty.
    const rate = (id: string): number => ((wins.get(id) ?? 0) + 2) / ((games.get(id) ?? 0) + 4);
    return (set) => {
      const a = rate(set.p1PlayerId);
      const b = rate(set.p2PlayerId);
      return a + b === 0 ? 0.5 : a / (a + b);
    };
  },
};

export interface WhrModelOptions {
  /**
   * Display-scale prior mean for players who debut in a rookie bracket.
   * Applied both inside the fit (training-fold debuts) and to players first
   * seen in the predicted set itself, so the out-of-sample fold measures the
   * prior exactly where it matters — a newcomer's first night.
   */
  rookieDebutPrior?: number;
  /** How to tell a rookie bracket from its tournament id. */
  isRookieTournament?: (tournamentId: string) => boolean;
}

export function whrModel(
  config?: Partial<WhrConfig>,
  label = 'whr',
  options?: WhrModelOptions,
): EvalModel {
  const rookiePriorNatural =
    options?.rookieDebutPrior === undefined
      ? 0
      : (options.rookieDebutPrior - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY;
  const isRookie = options?.isRookieTournament ?? (() => false);
  return {
    name: label,
    fit: (training) => {
      const priorMeans = new Map<string, number>();
      if (rookiePriorNatural !== 0) {
        for (const set of [...training].sort((a, b) => a.time - b.time)) {
          for (const playerId of [set.p1PlayerId, set.p2PlayerId]) {
            if (priorMeans.has(playerId)) continue;
            priorMeans.set(playerId, isRookie(set.tournamentId) ? rookiePriorNatural : 0);
          }
        }
      }
      const fit = fitWhr({
        sets: training.map((set) => ({
          p1PlayerId: set.p1PlayerId,
          p2PlayerId: set.p2PlayerId,
          winner: set.winner,
          time: set.time,
          trials: set.trials,
        })),
        config,
        priorMeans,
      });
      return (set) => {
        if (rookiePriorNatural === 0)
          return fit.winProbability(set.p1PlayerId, set.p2PlayerId, set.time);
        // A player unseen in training debuts in the predicted set: give them
        // the same prior the fit would have.
        const debutMean = isRookie(set.tournamentId) ? rookiePriorNatural : 0;
        const a = fit.latest(set.p1PlayerId) ? fit.at(set.p1PlayerId, set.time) : null;
        const b = fit.latest(set.p2PlayerId) ? fit.at(set.p2PlayerId, set.time) : null;
        const priorVariance = (config?.priorSd ?? defaultWhrConfig.priorSd) ** 2;
        const ra = a ?? { r: debutMean, variance: priorVariance };
        const rb = b ?? { r: debutMean, variance: priorVariance };
        return probabilityFromRatings(ra.r, rb.r, ra.variance + rb.variance);
      };
    },
  };
}
