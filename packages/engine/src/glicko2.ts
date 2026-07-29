/**
 * Glicko-2 rating math, implemented directly from Glickman's paper
 * (http://www.glicko.net/glicko/glicko2.pdf).
 *
 * The legacy Python CLI wrapped the `glicko2` PyPI package and monkeypatched
 * its volatility iteration function `Player._f`, which used the rating where
 * the paper has phi^2. This implementation uses the corrected formula, so it
 * matches the *patched* legacy behaviour.
 *
 * All public values are in display scale (rating ~1500, RD ~350); the
 * Glicko-2 internal scale is used only inside `updateRating`.
 */

export const GLICKO2_SCALE = 173.7178;

export interface Rating {
  rating: number;
  rd: number;
  vol: number;
}

export interface OpponentSample {
  rating: number;
  rd: number;
  /** 1 = win against this opponent, 0 = loss, 0.5 = draw. */
  outcome: number;
}

const CONVERGENCE_EPSILON = 1e-6;
const MAX_VOLATILITY_ITERATIONS = 1000;

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expectedScore(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Volatility iteration (the paper's step 5, "Illinois algorithm" variant).
 * `f` here is the corrected function: uses phi^2, not the rating.
 */
function nextVolatility(phi: number, v: number, delta: number, vol: number, tau: number): number {
  const a = Math.log(vol * vol);
  const phiSq = phi * phi;
  const deltaSq = delta * delta;

  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num1 = ex * (deltaSq - phiSq - v - ex);
    const denom1 = 2 * (phiSq + v + ex) ** 2;
    return num1 / denom1 - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;
  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) {
      k += 1;
    }
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  let iterations = 0;
  while (Math.abs(B - A) > CONVERGENCE_EPSILON && iterations < MAX_VOLATILITY_ITERATIONS) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
    iterations += 1;
  }
  return Math.exp(A / 2);
}

/**
 * Rate one player against a set of opponents forming a single rating period.
 * Returns the new rating; inputs are not mutated.
 */
export function updateRating(current: Rating, opponents: readonly OpponentSample[], tau: number): Rating {
  if (opponents.length === 0) {
    return applyRatingPeriodWithoutGames(current);
  }

  const mu = (current.rating - 1500) / GLICKO2_SCALE;
  const phi = current.rd / GLICKO2_SCALE;

  let vInv = 0;
  let deltaSum = 0;
  for (const opp of opponents) {
    const muJ = (opp.rating - 1500) / GLICKO2_SCALE;
    const phiJ = opp.rd / GLICKO2_SCALE;
    const gJ = g(phiJ);
    const eJ = expectedScore(mu, muJ, phiJ);
    vInv += gJ * gJ * eJ * (1 - eJ);
    deltaSum += gJ * (opp.outcome - eJ);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  const newVol = nextVolatility(phi, v, delta, current.vol, tau);
  const phiStar = Math.sqrt(phi * phi + newVol * newVol);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = mu + phiPrime * phiPrime * deltaSum;

  return {
    rating: muPrime * GLICKO2_SCALE + 1500,
    rd: phiPrime * GLICKO2_SCALE,
    vol: newVol,
  };
}

/**
 * The paper's step for a player who did not compete during a rating period:
 * RD grows by the volatility, rating and volatility are unchanged.
 */
export function applyRatingPeriodWithoutGames(current: Rating): Rating {
  const phi = current.rd / GLICKO2_SCALE;
  const phiStar = Math.sqrt(phi * phi + current.vol * current.vol);
  return { rating: current.rating, rd: phiStar * GLICKO2_SCALE, vol: current.vol };
}
