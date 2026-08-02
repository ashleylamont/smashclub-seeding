/**
 * The rating models under comparison, wrapped in the evaluation interface so
 * they can be scored against each other and against naive baselines on
 * identical folds.
 */
import type { GlickoSettings } from '@smashclub/shared';
import { updateRating, type Rating } from './glicko2';
import { DISPLAY_CENTRE, NATURAL_TO_DISPLAY, defaultWhrConfig, fitWhr, probabilityFromRatings, type WhrConfig } from './whr';
import type { EvalModel, EvalSet } from './evaluate';

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
      ] as Array<[string, boolean]>) {
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

interface SequentialOptions {
  name: string;
  settings: GlickoSettings;
  /** One rating period per tournament (correct) vs per set (legacy). */
  batchByTournament: boolean;
  /** Clamp the applied weight to at most 1 (legacy allowed 1.25). */
  clampWeight: boolean;
  /** Apply the per-tournament inverse-diminishing weight at all. */
  applyWeights: boolean;
}

/**
 * Sequential Glicko-2, parameterised so the legacy behaviour and the corrected
 * behaviour can be evaluated side by side.
 *
 * Prediction uses the Glicko attenuation of the rating difference by both
 * players' uncertainty, so thin evidence yields appropriately humble
 * probabilities.
 */
function sequentialGlickoModel(options: SequentialOptions): EvalModel {
  const { settings } = options;
  return {
    name: options.name,
    fit: (training) => {
      const states = new Map<string, Rating>();
      const initial = (): Rating => ({
        rating: settings.initialRating,
        rd: settings.initialRd,
        vol: settings.initialVol,
      });
      const get = (id: string): Rating => {
        const existing = states.get(id);
        if (existing) return existing;
        const fresh = initial();
        states.set(id, fresh);
        return fresh;
      };

      // Group into rating periods.
      const periods = new Map<string, EvalSet[]>();
      for (const set of training) {
        const key = options.batchByTournament ? set.tournamentId : `${set.tournamentId}|${periods.size}`;
        const list = periods.get(key) ?? [];
        list.push(set);
        periods.set(key, list);
      }
      const orderedPeriods = [...periods.entries()].sort((a, b) => {
        const ta = Math.min(...a[1].map((s) => s.time));
        const tb = Math.min(...b[1].map((s) => s.time));
        return ta - tb || (a[0] < b[0] ? -1 : 1);
      });

      for (const [, periodSets] of orderedPeriods) {
        // Count each player's sets in the period, for the weight denominator.
        const totals = new Map<string, number>();
        for (const set of periodSets) {
          totals.set(set.p1PlayerId, (totals.get(set.p1PlayerId) ?? 0) + 1);
          totals.set(set.p2PlayerId, (totals.get(set.p2PlayerId) ?? 0) + 1);
        }
        // Snapshot pre-period ratings so every result in the period is judged
        // against the same opponent state — this is what a rating period means.
        const snapshot = new Map<string, Rating>();
        for (const id of totals.keys()) snapshot.set(id, { ...get(id) });

        const samples = new Map<string, Array<{ rating: number; rd: number; outcome: number; weight: number }>>();
        const seen = new Map<string, number>();
        for (const set of periodSets) {
          for (const [id, opponentId, won] of [
            [set.p1PlayerId, set.p2PlayerId, set.winner === 1],
            [set.p2PlayerId, set.p1PlayerId, set.winner === 2],
          ] as Array<[string, string, boolean]>) {
            const index = (seen.get(id) ?? 0) + 1;
            seen.set(id, index);
            let weight = 1;
            if (options.applyWeights) {
              weight = (index / totals.get(id)!) ** settings.inverseDiminishingExponent;
              if (options.clampWeight) weight = Math.min(1, weight);
            }
            const opponent = snapshot.get(opponentId) ?? initial();
            const list = samples.get(id) ?? [];
            list.push({ rating: opponent.rating, rd: opponent.rd, outcome: won ? 1 : 0, weight });
            samples.set(id, list);
          }
        }

        for (const [id, list] of samples) {
          const pre = snapshot.get(id)!;
          const updated = updateRating(pre, list, settings.tau);
          // Weight the movement by the mean applied weight of the period's sets.
          const meanWeight = list.reduce((s, x) => s + x.weight, 0) / list.length;
          states.set(id, {
            rating: pre.rating + (updated.rating - pre.rating) * meanWeight,
            rd: pre.rd + (updated.rd - pre.rd) * meanWeight,
            vol: updated.vol,
          });
        }
      }

      const naturalScale = 400 / Math.LN10;
      return (set) => {
        const a = states.get(set.p1PlayerId) ?? initial();
        const b = states.get(set.p2PlayerId) ?? initial();
        const varianceSum = ((a.rd / naturalScale) ** 2 + (b.rd / naturalScale) ** 2);
        return probabilityFromRatings(
          (a.rating - settings.initialRating) / naturalScale,
          (b.rating - settings.initialRating) / naturalScale,
          varianceSum,
        );
      };
    },
  };
}

/** The behaviour the club has today: per-set periods, unclamped weights. */
export function legacyGlickoModel(settings: GlickoSettings): EvalModel {
  return sequentialGlickoModel({
    name: 'glicko-2 (legacy: per-set periods)',
    settings,
    batchByTournament: false,
    clampWeight: false,
    applyWeights: true,
  });
}

/** Corrected sequential Glicko: one period per tournament, weights clamped. */
export function tournamentGlickoModel(settings: GlickoSettings): EvalModel {
  return sequentialGlickoModel({
    name: 'glicko-2 (per-tournament periods)',
    settings,
    batchByTournament: true,
    clampWeight: true,
    applyWeights: true,
  });
}

/** Corrected periods with the weighting hack removed entirely. */
export function unweightedTournamentGlickoModel(settings: GlickoSettings): EvalModel {
  return sequentialGlickoModel({
    name: 'glicko-2 (per-tournament, no weights)',
    settings,
    batchByTournament: true,
    clampWeight: true,
    applyWeights: false,
  });
}

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

export function whrModel(config?: Partial<WhrConfig>, label = 'whr', options?: WhrModelOptions): EvalModel {
  const rookiePriorNatural =
    options?.rookieDebutPrior === undefined ? 0 : (options.rookieDebutPrior - DISPLAY_CENTRE) / NATURAL_TO_DISPLAY;
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
        if (rookiePriorNatural === 0) return fit.winProbability(set.p1PlayerId, set.p2PlayerId, set.time);
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
