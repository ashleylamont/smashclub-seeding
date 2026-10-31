import type { LiveMatch, PoolQualifier } from './eventDisplay';

export function qualifierLabel(source: PoolQualifier) {
  const division = source.division === 'upper' ? 'Upper' : 'Lower';
  return `${division} Pool ${String.fromCharCode(65 + source.poolIndex)} · place ${source.place}`;
}

/** Public source facts explain a hold without exposing reports or guessing an entrant. */
export function qualificationSummary(
  match: Pick<LiveMatch, 'player1Qualifier' | 'player2Qualifier' | 'qualificationBlocks'>,
) {
  const sources = new Map<string, PoolQualifier>();
  for (const source of [
    ...(match.qualificationBlocks ?? []),
    match.player1Qualifier,
    match.player2Qualifier,
  ]) {
    if (!source || source.status === 'resolved') continue;
    const key = `${source.poolId}:${source.place}`;
    if (sources.get(key)?.status !== 'review_pending') sources.set(key, source);
  }
  return sources.size
    ? `Waiting for ${[...sources.values()]
        .map(
          (source) =>
            `${qualifierLabel(source)}${source.status === 'review_pending' ? ' (under review)' : ''}`,
        )
        .join('; ')}.`
    : null;
}
