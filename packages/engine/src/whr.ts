/**
 * Whole-History Rating (Coulom, 2008) — a batch maximum-a-posteriori
 * Bradley-Terry model with Brownian-motion time dynamics.
 *
 * Why this suits the club's data specifically:
 *
 *  - **Small dataset.** ~1,000 sets over ~10 event days. Sequential systems
 *    (Elo, Glicko) update once per result and never revisit; WHR re-fits every
 *    rating from all evidence at once, which extracts far more from few games.
 *  - **Weakly-connected brackets.** Main and rookie events are separate
 *    tournaments linked only by the players who appear in both. WHR represents
 *    that honestly: where the linkage is thin, cross-bracket comparisons come
 *    out with *wide uncertainty* rather than a confident-but-arbitrary gap. The
 *    legacy engine needed a tower of hand-tuned corrections (rookie weight
 *    scale, isolation factor, rookie-island penalty, rating anchor) to fake
 *    this; here it falls out of the model.
 *  - **Long tail of one-event players.** 39 of 92 players attended exactly one
 *    event. Their rating is simply prior-dominated — no special case needed.
 *  - **Order independence.** The fit is a global optimum, so the class of bug
 *    where input order changed ratings cannot exist here by construction.
 *
 * Ratings live in natural (log-odds) units internally, where
 * `P(a beats b) = 1 / (1 + exp(-(r_a - r_b)))`, and are converted to the
 * familiar 1500-centred scale for display using the same 400/ln(10) constant
 * Glicko-2 uses.
 */

export const NATURAL_TO_DISPLAY = 400 / Math.LN10; // 173.7178…
export const DISPLAY_CENTRE = 1500;

export interface WhrConfig {
  /**
   * Skill drift: variance added per day, in natural units. Larger means
   * ratings track recent form more closely and old results decay faster.
   * Replaces the legacy engine's ad-hoc inactivity decay.
   */
  driftVariancePerDay: number;
  /**
   * Standard deviation of the prior on a player's rating, in natural units.
   * Also what anchors the scale: without it, ratings would only be identified
   * up to an additive constant per connected component, and the main and
   * rookie pools could drift apart arbitrarily.
   */
  priorSd: number;
  maxIterations: number;
  /** Convergence threshold on the largest rating step, in natural units. */
  tolerance: number;
}

export const defaultWhrConfig: WhrConfig = {
  // ~0.0002/day ⇒ about 55 rating points of drift over a year.
  driftVariancePerDay: 0.0002,
  priorSd: 1.2,
  maxIterations: 200,
  tolerance: 1e-6,
};

export interface WhrSet {
  p1PlayerId: string;
  p2PlayerId: string;
  winner: 1 | 2;
  /** Time in days (any consistent origin). */
  time: number;
  /**
   * How many independent trials this set represents. Defaults to 1. Game
   * counts can raise it (a 3-0 carries more information than a 2-1), with a
   * discount for the fact that games within a set are correlated.
   */
  trials?: number;
}

interface PlayerTrack {
  playerId: string;
  /** Distinct times at which the player has results, ascending. */
  times: number[];
  /** Rating in natural units at each time. */
  r: number[];
  /** Posterior variance at each time, natural units squared. */
  variance: number[];
  /** Games indexed by time position. */
  games: Array<Array<{ opponentId: string; opponentTimeIndex: number; won: boolean; trials: number }>>;
}

export interface PlayerRatingAt {
  /** Natural units. */
  r: number;
  /** Natural units squared. */
  variance: number;
}

export interface WhrFit {
  readonly config: WhrConfig;
  readonly iterations: number;
  readonly converged: boolean;
  playerIds(): string[];
  /** Rating and variance at the player's last observed time. */
  latest(playerId: string): PlayerRatingAt | null;
  /** Rating projected to `time`, with drift variance added for the gap. */
  at(playerId: string, time: number): PlayerRatingAt;
  /** Full trajectory, for charting. */
  track(playerId: string): Array<{ time: number } & PlayerRatingAt> | null;
  /** Calibrated probability that `p1` beats `p2` at `time`. */
  winProbability(p1PlayerId: string, p2PlayerId: string, time: number): number;
  /** Display-scale rating (1500-centred) and standard deviation. */
  display(playerId: string, time?: number): { rating: number; sd: number };
}

/**
 * Attenuation of a rating difference by the uncertainty in it — the same
 * device Glicko uses. Without this, predictions from thin evidence are
 * over-confident and the model scores badly on held-out results.
 */
function g(variance: number): number {
  return 1 / Math.sqrt(1 + (3 * variance) / (Math.PI * Math.PI));
}

export function probabilityFromRatings(rA: number, rB: number, varianceSum: number): number {
  return 1 / (1 + Math.exp(-g(varianceSum) * (rA - rB)));
}

export function fitWhr(input: { sets: readonly WhrSet[]; config?: Partial<WhrConfig> }): WhrFit {
  const config: WhrConfig = { ...defaultWhrConfig, ...input.config };
  const sets = input.sets;

  // ---- build per-player tracks ----
  const timesByPlayer = new Map<string, Set<number>>();
  for (const set of sets) {
    for (const id of [set.p1PlayerId, set.p2PlayerId]) {
      const times = timesByPlayer.get(id) ?? new Set<number>();
      times.add(set.time);
      timesByPlayer.set(id, times);
    }
  }

  const tracks = new Map<string, PlayerTrack>();
  for (const [playerId, timeSet] of timesByPlayer) {
    const times = [...timeSet].sort((a, b) => a - b);
    tracks.set(playerId, {
      playerId,
      times,
      r: times.map(() => 0),
      variance: times.map(() => config.priorSd * config.priorSd),
      games: times.map(() => []),
    });
  }

  const timeIndex = (track: PlayerTrack, time: number): number => {
    // Times are few (one per event), so a scan is cheaper than a map here.
    for (let i = 0; i < track.times.length; i++) if (track.times[i] === time) return i;
    throw new Error(`time ${time} missing for ${track.playerId}`);
  };

  for (const set of sets) {
    const trials = set.trials ?? 1;
    const t1 = tracks.get(set.p1PlayerId)!;
    const t2 = tracks.get(set.p2PlayerId)!;
    const i1 = timeIndex(t1, set.time);
    const i2 = timeIndex(t2, set.time);
    t1.games[i1]!.push({ opponentId: set.p2PlayerId, opponentTimeIndex: i2, won: set.winner === 1, trials });
    t2.games[i2]!.push({ opponentId: set.p1PlayerId, opponentTimeIndex: i1, won: set.winner === 2, trials });
  }

  // ---- iterative conditional modes: Newton step per player until settled ----
  const order = [...tracks.keys()].sort();
  let iterations = 0;
  let converged = false;
  for (; iterations < config.maxIterations; iterations++) {
    let maxStep = 0;
    for (const playerId of order) {
      maxStep = Math.max(maxStep, newtonUpdatePlayer(tracks.get(playerId)!, tracks, config));
    }
    if (maxStep < config.tolerance) {
      converged = true;
      iterations += 1;
      break;
    }
  }

  // Variances only need computing once the ratings have settled.
  for (const track of tracks.values()) computeVariances(track, tracks, config);

  const latest = (playerId: string): PlayerRatingAt | null => {
    const track = tracks.get(playerId);
    if (!track || track.times.length === 0) return null;
    const last = track.times.length - 1;
    return { r: track.r[last]!, variance: track.variance[last]! };
  };

  const at = (playerId: string, time: number): PlayerRatingAt => {
    const track = tracks.get(playerId);
    // Unknown player: the prior, centred.
    if (!track || track.times.length === 0) return { r: 0, variance: config.priorSd * config.priorSd };
    // Find the last observation at or before `time`.
    let index = -1;
    for (let i = 0; i < track.times.length; i++) if (track.times[i]! <= time) index = i;
    if (index === -1) {
      // Before their first appearance: prior, plus drift back to that point.
      const gap = Math.max(0, track.times[0]! - time);
      return { r: track.r[0]!, variance: track.variance[0]! + gap * config.driftVariancePerDay };
    }
    const gap = Math.max(0, time - track.times[index]!);
    return { r: track.r[index]!, variance: track.variance[index]! + gap * config.driftVariancePerDay };
  };

  return {
    config,
    iterations,
    converged,
    playerIds: () => [...tracks.keys()],
    latest,
    at,
    track: (playerId) => {
      const track = tracks.get(playerId);
      if (!track) return null;
      return track.times.map((time, i) => ({ time, r: track.r[i]!, variance: track.variance[i]! }));
    },
    winProbability: (p1, p2, time) => {
      const a = at(p1, time);
      const b = at(p2, time);
      return probabilityFromRatings(a.r, b.r, a.variance + b.variance);
    },
    display: (playerId, time) => {
      const value = time === undefined ? (latest(playerId) ?? { r: 0, variance: config.priorSd ** 2 }) : at(playerId, time);
      return {
        rating: DISPLAY_CENTRE + value.r * NATURAL_TO_DISPLAY,
        sd: Math.sqrt(value.variance) * NATURAL_TO_DISPLAY,
      };
    },
  };
}

/**
 * One Newton step over a single player's whole rating trajectory, holding all
 * opponents fixed. The system is tridiagonal — the likelihood contributes only
 * to the diagonal, and the Brownian prior couples consecutive times — so it
 * solves in linear time.
 */
function newtonUpdatePlayer(track: PlayerTrack, tracks: Map<string, PlayerTrack>, config: WhrConfig): number {
  const n = track.times.length;
  if (n === 0) return 0;

  const gradient = new Float64Array(n);
  const diagonal = new Float64Array(n);
  const offDiagonal = new Float64Array(Math.max(0, n - 1));

  // Likelihood: d/dr Σ (outcome − E), d²/dr² = −Σ E(1−E).
  for (let i = 0; i < n; i++) {
    for (const game of track.games[i]!) {
      const opponent = tracks.get(game.opponentId)!;
      const rOpp = opponent.r[game.opponentTimeIndex]!;
      const expected = 1 / (1 + Math.exp(-(track.r[i]! - rOpp)));
      gradient[i]! += game.trials * ((game.won ? 1 : 0) - expected);
      diagonal[i]! -= game.trials * expected * (1 - expected);
    }
  }

  // Prior on the first rating, which anchors the scale and keeps disconnected
  // components from floating away from 1500.
  const priorPrecision = 1 / (config.priorSd * config.priorSd);
  gradient[0]! -= priorPrecision * track.r[0]!;
  diagonal[0]! -= priorPrecision;

  // Brownian drift between consecutive appearances.
  for (let i = 0; i < n - 1; i++) {
    const gapDays = Math.max(track.times[i + 1]! - track.times[i]!, 1e-6);
    const precision = 1 / (gapDays * config.driftVariancePerDay);
    const delta = track.r[i + 1]! - track.r[i]!;
    gradient[i]! += precision * delta;
    gradient[i + 1]! -= precision * delta;
    diagonal[i]! -= precision;
    diagonal[i + 1]! -= precision;
    offDiagonal[i]! += precision;
  }

  // Solve H·step = −gradient for the negative-definite tridiagonal H.
  const step = solveTridiagonal(diagonal, offDiagonal, gradient);
  let maxStep = 0;
  for (let i = 0; i < n; i++) {
    // Damp large steps so early iterations cannot overshoot wildly.
    const bounded = Math.max(-1, Math.min(1, step[i]!));
    track.r[i]! -= bounded;
    maxStep = Math.max(maxStep, Math.abs(bounded));
  }
  return maxStep;
}

/** Thomas algorithm for a symmetric tridiagonal system H·x = rhs. */
function solveTridiagonal(diagonal: Float64Array, offDiagonal: Float64Array, rhs: Float64Array): Float64Array {
  const n = diagonal.length;
  const c = new Float64Array(Math.max(0, n - 1));
  const d = new Float64Array(n);
  let denominator = diagonal[0]!;
  if (Math.abs(denominator) < 1e-12) denominator = -1e-12;
  if (n > 1) c[0]! = offDiagonal[0]! / denominator;
  d[0]! = rhs[0]! / denominator;
  for (let i = 1; i < n; i++) {
    let den = diagonal[i]! - offDiagonal[i - 1]! * c[i - 1]!;
    if (Math.abs(den) < 1e-12) den = -1e-12;
    if (i < n - 1) c[i]! = offDiagonal[i]! / den;
    d[i]! = (rhs[i]! - offDiagonal[i - 1]! * d[i - 1]!) / den;
  }
  const x = new Float64Array(n);
  x[n - 1]! = d[n - 1]!;
  for (let i = n - 2; i >= 0; i--) x[i]! = d[i]! - c[i]! * x[i + 1]!;
  return x;
}

/**
 * Posterior variance per time point: the diagonal of the inverse of the
 * negative Hessian, via the standard forward/backward recursions for a
 * tridiagonal matrix.
 */
function computeVariances(track: PlayerTrack, tracks: Map<string, PlayerTrack>, config: WhrConfig): void {
  const n = track.times.length;
  if (n === 0) return;

  const diagonal = new Float64Array(n);
  const offDiagonal = new Float64Array(Math.max(0, n - 1));

  for (let i = 0; i < n; i++) {
    for (const game of track.games[i]!) {
      const opponent = tracks.get(game.opponentId)!;
      const expected = 1 / (1 + Math.exp(-(track.r[i]! - opponent.r[game.opponentTimeIndex]!)));
      diagonal[i]! += game.trials * expected * (1 - expected);
    }
  }
  const priorPrecision = 1 / (config.priorSd * config.priorSd);
  diagonal[0]! += priorPrecision;
  for (let i = 0; i < n - 1; i++) {
    const gapDays = Math.max(track.times[i + 1]! - track.times[i]!, 1e-6);
    const precision = 1 / (gapDays * config.driftVariancePerDay);
    diagonal[i]! += precision;
    diagonal[i + 1]! += precision;
    offDiagonal[i]! -= precision;
  }

  // theta: forward elimination; phi: backward elimination.
  const theta = new Float64Array(n);
  const phi = new Float64Array(n);
  theta[0]! = diagonal[0]!;
  for (let i = 1; i < n; i++) {
    theta[i]! = diagonal[i]! - (offDiagonal[i - 1]! * offDiagonal[i - 1]!) / Math.max(theta[i - 1]!, 1e-12);
  }
  phi[n - 1]! = diagonal[n - 1]!;
  for (let i = n - 2; i >= 0; i--) {
    phi[i]! = diagonal[i]! - (offDiagonal[i]! * offDiagonal[i]!) / Math.max(phi[i + 1]!, 1e-12);
  }

  for (let i = 0; i < n; i++) {
    let precision = diagonal[i]!;
    if (i > 0) precision -= (offDiagonal[i - 1]! * offDiagonal[i - 1]!) / Math.max(theta[i - 1]!, 1e-12);
    if (i < n - 1) precision -= (offDiagonal[i]! * offDiagonal[i]!) / Math.max(phi[i + 1]!, 1e-12);
    track.variance[i]! = 1 / Math.max(precision, 1e-12);
  }
}
