import { z } from 'zod';
import type { Pair } from '@smashclub/engine';
import type { loadDoublesRatings } from '../recompute/doubles';

const breakdown = z.object({
  enabled: z.boolean(),
  baselineMean: z.number().finite(),
  baselineSd: z.number().finite().nonnegative(),
  adjustment: z.number().finite(),
  adjustmentSd: z.number().finite().nonnegative(),
  playedSets: z.number().int().nonnegative(),
  eventDays: z.number().int().nonnegative(),
});
export type PairRatingBreakdown = z.infer<typeof breakdown>;

export function describePairRating(
  fit: Awaited<ReturnType<typeof loadDoublesRatings>>,
  pair: Pair,
  time: number,
  enabled: boolean,
): PairRatingBreakdown {
  const base = fit.baseline(pair, time);
  const adjusted = enabled ? fit.rating(pair, time) : null;
  return {
    enabled,
    baselineMean: base.rating,
    baselineSd: base.sd,
    adjustment: adjusted?.adjustment ?? 0,
    adjustmentSd: adjusted?.adjustmentSd ?? 0,
    ...fit.evidence(pair),
  };
}

/** Old frozen provenance has no breakdown; never substitute today's evidence. */
export function frozenPairRating(context: Record<string, unknown> | null, entryId: string) {
  const saved = z
    .array(z.object({ entryId: z.string(), rating: breakdown }))
    .safeParse(context?.pairs);
  return saved.success ? saved.data.find((pair) => pair.entryId === entryId)?.rating : undefined;
}
