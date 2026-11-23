import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { recomputes, type Db } from '@smashclub/db';
import { defaultWhrConfig, prepareWhrHistory, type PreparedWhrHistory } from '@smashclub/engine';
import { ratingSettingsSchema, type RatingSettings } from '@smashclub/shared';
import { loadWhrHistory } from './inputs';

const HISTORY_LIMITS = { maxTournaments: 256, maxSets: 4000, maxNativeRows: 512 };

export async function readWhrRunProvenance(db: Db, recomputeId: string) {
  const [run] = await db
    .select({ stats: recomputes.stats, settingsSnapshot: recomputes.settingsSnapshot })
    .from(recomputes)
    .where(eq(recomputes.id, recomputeId));
  const fingerprints = currentWhrPrefixFingerprints(run?.stats);
  const snapshot = run?.settingsSnapshot as { rating?: unknown } | null;
  if (!fingerprints || !snapshot?.rating) return null;
  const settings = ratingSettingsSchema.safeParse(snapshot.rating);
  if (!settings.success) return null;
  return {
    fingerprints,
    settings: settings.data,
    convergedPreNightKeys: currentWhrConvergedPreNightKeys(run?.stats, fingerprints),
  };
}

export async function loadWhrHistoryThroughDay(db: Db, day: Date, settings: RatingSettings) {
  const before = new Date(day);
  before.setUTCHours(24, 0, 0, 0);
  const inputs = await loadWhrHistory(db, { before, ...HISTORY_LIMITS });
  if (!inputs) return null;
  return prepareWhrHistory({
    sets: inputs.engineSets,
    tournaments: inputs.engineTournaments,
    settings,
  });
}

// Bump when the preparation, fitter or omission method changes.
export const WHR_PREFIX_FINGERPRINT_VERSION = 2;

export function currentWhrPrefixFingerprints(stats: unknown): Record<string, string> | null {
  if (
    !stats ||
    typeof stats !== 'object' ||
    !('whrPrefixFingerprintVersion' in stats) ||
    stats.whrPrefixFingerprintVersion !== WHR_PREFIX_FINGERPRINT_VERSION ||
    !('whrPrefixFingerprints' in stats)
  )
    return null;
  const fingerprints = stats.whrPrefixFingerprints;
  return fingerprints && typeof fingerprints === 'object' && !Array.isArray(fingerprints)
    ? (fingerprints as Record<string, string>)
    : null;
}

const convergedPreNightKeysSchema = z.array(z.iso.date());

/** A recorded empty list is valid for a run without qualifying earlier fits. */
export function currentWhrConvergedPreNightKeys(
  stats: unknown,
  fingerprints: Record<string, string>,
): readonly string[] | null {
  const keys =
    stats && typeof stats === 'object' && 'whrConvergedPreNightKeys' in stats
      ? stats.whrConvergedPreNightKeys
      : null;
  const parsed = convergedPreNightKeysSchema.safeParse(keys);
  return parsed.success && parsed.data.every((key) => Object.hasOwn(fingerprints, key))
    ? parsed.data
    : null;
}

/** The latest rated night, if its earlier fit can support a rank comparison. */
export function verifiedRankMovementNight(stats: unknown): string | null {
  const fingerprints = currentWhrPrefixFingerprints(stats);
  if (!fingerprints) return null;
  const latest = Object.keys(fingerprints).sort().at(-1);
  return latest && currentWhrConvergedPreNightKeys(stats, fingerprints)?.includes(latest)
    ? latest
    : null;
}

/** Hash the ordered fit inputs. Each checkpoint excludes later nights and debut priors. */
export function whrPrefixFingerprints(history: PreparedWhrHistory) {
  const hash = createHash('sha256').update(
    JSON.stringify([
      'whr-prefix',
      WHR_PREFIX_FINGERPRINT_VERSION,
      { ...defaultWhrConfig, ...history.fitConfig },
      history.gamesWeight,
      history.rookieDebutPrior,
    ]),
  );
  const byNight = new Map<string, string>();
  for (const [index, { eventKey, set }] of history.rateable.entries()) {
    const fitted = history.fitSets[index]!;
    hash.update(
      JSON.stringify([
        eventKey,
        set.id,
        fitted.p1PlayerId,
        fitted.p2PlayerId,
        fitted.partnerIds ?? null,
        fitted.winner,
        fitted.time,
        fitted.trials ?? 1,
        fitted.logOddsOffset ?? 0,
        history.priorMeans.get(fitted.p1PlayerId) ?? 0,
        history.priorMeans.get(fitted.p2PlayerId) ?? 0,
        fitted.partnerIds?.map((id) => history.priorMeans.get(id) ?? 0) ?? null,
      ]),
    );
    if (index + 1 === history.prefixEnds.get(eventKey))
      byNight.set(eventKey, hash.copy().digest('hex'));
  }
  return byNight;
}
