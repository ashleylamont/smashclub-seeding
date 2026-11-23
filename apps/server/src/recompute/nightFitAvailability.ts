import { playerRatings, ratingEvents, ratingNights, tournaments, type Db } from '@smashclub/db';
import { eventKeyOf } from '@smashclub/engine';
import { and, eq, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { currentWhrConvergedPreNightKeys, currentWhrPrefixFingerprints } from './whrProvenance';

const nightKeys = z.array(z.iso.date());

// Tournament dates can change while the previous publication is still served.
// Verify a played-set estimate against the immutable nightly ledger.
export const recordedRatingEventNight = and(
  eq(ratingNights.recomputeId, ratingEvents.recomputeId),
  eq(ratingNights.playerId, ratingEvents.playerId),
  eq(ratingNights.eventKey, sql`(${tournaments.eventDate} at time zone 'UTC')::date`),
  eq(ratingNights.postRating, ratingEvents.postRating),
  eq(ratingNights.postRd, ratingEvents.postRd),
);

export function matchesFullFit(
  row: { postRating: number; postRd: number },
  board: { rating: number; rd: number } | null | undefined,
) {
  return board != null && row.postRating === board.rating && row.postRd === board.rd;
}

/** Reads evidence from the selected completed run, never from its current tournament schedule. */
export async function readNightFitAvailability(db: Db, run: { id: string; stats: unknown }) {
  const fingerprints = currentWhrPrefixFingerprints(run.stats);
  const preNightKeys = fingerprints && currentWhrConvergedPreNightKeys(run.stats, fingerprints);
  const ratedNightKeys = fingerprints && nightKeys.safeParse(Object.keys(fingerprints));
  const before = new Set<string>();
  const after = new Set<string>();
  if (preNightKeys && ratedNightKeys?.success) {
    const ratedNights = ratedNightKeys.data.sort();
    for (const key of preNightKeys) before.add(key);
    for (const [index, night] of ratedNights.entries()) {
      const next = ratedNights[index + 1];
      // The preceding fit for the next rated club night is this night's fit.
      // The last fit is the full run, which must converge before publication.
      if (next === undefined || before.has(next)) after.add(night);
    }
  } else {
    // Older runs can prove only the final fit. The published player snapshot
    // retains the latest rated day, including when this player was absent.
    const [latest] = await db
      .select({ lastPlayedDate: max(playerRatings.lastPlayedDate) })
      .from(playerRatings)
      .where(eq(playerRatings.recomputeId, run.id));
    if (latest?.lastPlayedDate) after.add(eventKeyOf(latest.lastPlayedDate));
  }
  return { before, after };
}

export function publicPostNightEstimate(
  { postRating, postRd }: { postRating: number; postRd: number },
  available: boolean,
) {
  return available ? { postRating, postRd } : { postRating: null, postRd: null };
}
