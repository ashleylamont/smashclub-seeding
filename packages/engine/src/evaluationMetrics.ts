export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  predicted: number;
  observed: number;
}

export function clampProbability(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1 - 1e-9, Math.max(1e-9, p));
}

export function predictionErrors(p: number, outcome: number) {
  return {
    logLoss: -(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p)),
    brier: (p - outcome) ** 2,
  };
}

export function calibrate(
  probs: number[],
  outcomes: number[],
  { splitTies = false }: { splitTies?: boolean } = {},
): CalibrationBin[] {
  const bins = 5;
  // Predictions are symmetric (p and 1−p describe the same set from either
  // side), so fold onto [0.5, 1] where the bins are interpretable.
  const folded = probs.map((p, i) => {
    if (splitTies && p === 0.5) return { p, o: 0.5 };
    return p >= 0.5 ? { p, o: outcomes[i]! } : { p: 1 - p, o: 1 - outcomes[i]! };
  });
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
 * Bootstrap paired differences over aligned observations or cluster means.
 * A seeded generator makes the interval reproducible.
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
