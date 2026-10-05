/**
 * The order sets within one bracket were played in.
 *
 * The keys, in order:
 *
 *  1. `suggestedPlayOrder` — Challonge's own play order. A topological sort of
 *     the bracket: a set never precedes the sets that feed it, and the winners
 *     and losers sides interleave the way they are actually called. This is
 *     complete (every set has one) and stable, which is why it leads.
 *  2. `completedAt` — when the set was reported. Only reachable if two sets
 *     share a play order, but kept because it is the one key that reflects what
 *     actually happened rather than what the bracket planned.
 *  3. `challongeMatchId` — bracket-creation order. Stable, and the last key
 *     that carries any meaning.
 *  4. `id` — so the sort is total. Arbitrary, and reached only when a bracket
 *     gives us nothing else.
 *
 * Nulls sort last at every level, so a set missing a key never displaces one
 * that has it. That matters: roughly one set in seven arrives with no timestamp
 * at all, and before this they either clumped at one end of the list or, under
 * the `?? 0` coalescing the WHR path used, jumped to the front of it.
 *
 * WHR uses this for presentation and the global result sequence.
 */

/** The order-relevant fields. Anything set-shaped structurally satisfies this. */
export interface OrderableSet {
  id: string;
  suggestedPlayOrder?: number | null;
  completedAt?: string | null;
  challongeMatchId?: number | null;
}

export function compareNullableNumbers(
  a: number | null | undefined,
  b: number | null | undefined,
): number {
  const aVal = a ?? Number.POSITIVE_INFINITY;
  const bVal = b ?? Number.POSITIVE_INFINITY;
  return aVal - bVal || 0;
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareNullableStrings(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return compareStrings(a, b);
}

/**
 * Compares two sets *of the same bracket*. Callers spanning several brackets
 * must order by tournament first — this deliberately knows nothing about which
 * bracket a set belongs to.
 */
export function compareSetsInBracket(a: OrderableSet, b: OrderableSet): number {
  return (
    compareNullableNumbers(a.suggestedPlayOrder, b.suggestedPlayOrder) ||
    compareNullableStrings(a.completedAt, b.completedAt) ||
    compareNullableNumbers(a.challongeMatchId, b.challongeMatchId) ||
    compareStrings(a.id, b.id)
  );
}
