import {
  DISPLAY_CENTRE,
  NATURAL_TO_DISPLAY,
  fitWhr,
  probabilityFromRatings,
  whrSetTrials,
  type WhrConfig,
} from './whr';

export type Pair = readonly [string, string];
export interface SkillEstimate {
  rating: number;
  sd: number;
}
export interface DoublesSet {
  id: string;
  time: number;
  p1: Pair;
  p2: Pair;
  winner: 1 | 2;
  p1Games?: number | null;
  p2Games?: number | null;
  outcome?: 'played' | 'forfeit' | 'bye' | 'no_contest';
}

/** Stable across partner order and team labels; namespace other rulesets separately. */
export function doublesPairKey(pair: Pair): string {
  if (pair.length !== 2 || !pair[0] || !pair[1] || pair[0] === pair[1])
    throw new Error('A pair needs two distinct players.');
  return JSON.stringify([...pair].sort());
}

function validSkill(skill: SkillEstimate) {
  if (!Number.isFinite(skill.rating) || !Number.isFinite(skill.sd) || skill.sd < 0)
    throw new Error('Skill mean and nonnegative SD must be finite.');
}

/** Independent-marginal approximation; do not average individual conservative bounds. */
export function averagePairSkill(
  a: SkillEstimate,
  b: SkillEstimate,
): SkillEstimate & { conservativeRating: number } {
  validSkill(a);
  validSkill(b);
  const rating = a.rating / 2 + b.rating / 2;
  const sd = Math.hypot(a.sd, b.sd) / 2;
  return { rating, sd, conservativeRating: rating - 2 * sd };
}

/** A zero-centred pair residual over time-specific singles skill offsets. */
export function fitDoubles(input: {
  sets: readonly DoublesSet[];
  /** Historical fits must supply only information available before each night. */
  skillAt: (playerId: string, time: number) => SkillEstimate;
  config?: Partial<WhrConfig>;
  gamesWeight?: number;
  baselineScale?: number;
}) {
  const scale = input.baselineScale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error('Baseline scale must be positive and finite.');
  const config = { priorSd: 0.25, driftVariancePerDay: 0.00002, ...input.config };
  if (
    !Number.isFinite(config.priorSd) ||
    config.priorSd <= 0 ||
    !Number.isFinite(config.driftVariancePerDay) ||
    config.driftVariancePerDay <= 0
  )
    throw new Error('Doubles prior SD and drift must be positive and finite.');
  if (!Number.isFinite(input.gamesWeight ?? 0.5) || (input.gamesWeight ?? 0.5) < 0)
    throw new Error('Doubles evidence weight must be nonnegative and finite.');
  const baseline = (pair: Pair, time: number) => {
    if (!Number.isFinite(time)) throw new Error('Doubles rating time must be finite.');
    doublesPairKey(pair);
    return averagePairSkill(input.skillAt(pair[0], time), input.skillAt(pair[1], time));
  };
  const sets = input.sets.filter((s) => !s.outcome || s.outcome === 'played');
  const evidence = new Map<string, { playedSets: number; days: Set<number> }>();
  const seen = new Set<string>();
  const fit = fitWhr({
    config,
    sets: sets.map((s) => {
      if (seen.has(s.id)) throw new Error('Duplicate doubles result.');
      seen.add(s.id);
      if (!Number.isFinite(s.time) || (s.winner !== 1 && s.winner !== 2))
        throw new Error('Invalid doubles result.');
      if (new Set([...s.p1, ...s.p2]).size !== 4)
        throw new Error('A doubles match needs four distinct players.');
      const a = baseline(s.p1, s.time),
        b = baseline(s.p2, s.time);
      for (const pair of [s.p1, s.p2]) {
        const key = doublesPairKey(pair);
        const record = evidence.get(key) ?? { playedSets: 0, days: new Set<number>() };
        record.playedSets++;
        record.days.add(s.time);
        evidence.set(key, record);
      }
      return {
        p1PlayerId: doublesPairKey(s.p1),
        p2PlayerId: doublesPairKey(s.p2),
        time: s.time,
        winner: s.winner,
        logOddsOffset: (scale * (a.rating - b.rating)) / NATURAL_TO_DISPLAY,
        trials: whrSetTrials(s, input.gamesWeight ?? 0.5),
      };
    }),
  });
  const rating = (pair: Pair, time: number) => {
    const base = baseline(pair, time),
      residual = fit.at(doublesPairKey(pair), time);
    const adjustment = residual.r * NATURAL_TO_DISPLAY;
    const adjustmentSd = Math.sqrt(residual.variance) * NATURAL_TO_DISPLAY;
    const mean = DISPLAY_CENTRE + scale * (base.rating - DISPLAY_CENTRE) + adjustment;
    const sd = Math.hypot(scale * base.sd, adjustmentSd);
    return {
      rating: mean,
      sd,
      conservativeRating: mean - 2 * sd,
      baseline: base.rating,
      adjustment,
      adjustmentSd,
    };
  };
  return {
    converged: fit.converged,
    iterations: fit.iterations,
    pairs: fit.playerIds(),
    baseline,
    /** Evidence in this fitted history, not a per-query causal/prefix estimate. */
    evidence: (pair: Pair) => {
      const record = evidence.get(doublesPairKey(pair));
      return {
        playedSets: record?.playedSets ?? 0,
        eventDays: record?.days.size ?? 0,
      };
    },
    rating,
    winProbability: (a: Pair, b: Pair, time: number) => {
      if (new Set([...a, ...b]).size !== 4)
        throw new Error('A doubles match needs four distinct players.');
      const ra = rating(a, time),
        rb = rating(b, time);
      return probabilityFromRatings(
        (ra.rating - rb.rating) / NATURAL_TO_DISPLAY,
        0,
        (ra.sd ** 2 + rb.sd ** 2) / NATURAL_TO_DISPLAY ** 2,
      );
    },
  };
}
