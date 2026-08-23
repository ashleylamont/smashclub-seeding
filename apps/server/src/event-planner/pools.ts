/**
 * Pool generation for a division: pure, deterministic, and the one definition
 * of what "pool B" means.
 */

/**
 * Distribute a ranked list into pools by striping — one entrant per pool per
 * row, reversing direction on alternating rows — rather than filling each pool
 * up before starting the next.
 *
 * For 16 entrants seeded 1..16:
 *
 *     Pool A   Pool B   Pool C   Pool D
 *        1        2        3        4
 *        8        7        6        5
 *        9       10       11       12
 *       16       15       14       13
 *
 * Filling four at a time would put seeds 1-4 in one pool and 13-16 in another:
 * the top pool would eliminate two players better than the winner of the
 * bottom one, and the bottom pool's championship qualifiers would arrive at the
 * bracket having beaten nobody. Striping gives every pool one entrant from each
 * quarter of the field, so the seeds sum to roughly the same total everywhere
 * and each pool's 1st/2nd is worth about the same.
 *
 * Returns pools in display order (A, B, C, ...), each in snake-row order, which
 * is also the order they are exported for Challonge.
 */
export function stripeIntoPools<T>(ordered: readonly T[], poolSize = 4): T[][] {
  if (!Number.isInteger(poolSize) || poolSize < 2) {
    throw new Error(`Pool size must be an integer of at least 2, got ${poolSize}.`);
  }
  if (ordered.length === 0) {
    throw new Error('Cannot build pools from an empty division.');
  }
  if (ordered.length % poolSize !== 0) {
    throw new Error(`${ordered.length} entrants do not divide into pools of ${poolSize}.`);
  }

  const poolCount = ordered.length / poolSize;
  const pools: T[][] = Array.from({ length: poolCount }, () => []);
  for (let row = 0; row < poolSize; row++) {
    for (let column = 0; column < poolCount; column++) {
      // Odd rows run right-to-left, so the pool that took the best entrant of
      // the previous row takes the worst of this one.
      const poolIndex = row % 2 === 0 ? column : poolCount - 1 - column;
      pools[poolIndex]!.push(ordered[row * poolCount + column]!);
    }
  }
  return pools;
}

/** Pool A, B, ... Z, then AA, AB — the club will never need the second case. */
export function poolLabel(poolIndex: number): string {
  let label = '';
  let index = poolIndex;
  do {
    label = String.fromCharCode(65 + (index % 26)) + label;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return label;
}

/** How many pools a division of this size makes. */
export function poolCountFor(divisionSize: number, poolSize = 4): number {
  return divisionSize / poolSize;
}
