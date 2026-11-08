import { createHash } from 'node:crypto';
import { defaultWhrConfig, type PreparedWhrHistory } from '@smashclub/engine';

// Bump when the preparation, fitter or omission method changes.
export const WHR_PREFIX_FINGERPRINT_VERSION = 1;

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
        fitted.winner,
        fitted.time,
        fitted.trials ?? 1,
        fitted.logOddsOffset ?? 0,
        history.priorMeans.get(fitted.p1PlayerId) ?? 0,
        history.priorMeans.get(fitted.p2PlayerId) ?? 0,
      ]),
    );
    if (index + 1 === history.prefixEnds.get(eventKey))
      byNight.set(eventKey, hash.copy().digest('hex'));
  }
  return byNight;
}
