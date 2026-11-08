import { createHash } from 'node:crypto';
import { defaultWhrConfig, type PreparedWhrHistory } from '@smashclub/engine';

/** Hash the ordered fit inputs. Each checkpoint excludes later nights and debut priors. */
export function whrPrefixFingerprints(history: PreparedWhrHistory) {
  const hash = createHash('sha256').update(
    JSON.stringify([
      'whr-prefix-v1',
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
