import type { LiveMatch, PoolQualifier } from './eventDisplay';
import type { trpc } from './trpc';

type EventSnapshot = Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>;
export type PublicFinalsField = NonNullable<EventSnapshot['pendingFinals']>[number];

export function qualifierLabel(source: PoolQualifier) {
  const division = source.division === 'upper' ? 'Upper' : 'Lower';
  return `${division} Pool ${String.fromCharCode(65 + source.poolIndex)} · place ${source.place}`;
}

export const plannedFinalsSeeding = 'Planned seeding combines pool place and frozen WHR rating.';

export function finalsFieldLabel({
  division,
  stage,
}: Pick<PublicFinalsField, 'division' | 'stage'>) {
  return `${division === 'upper' ? 'Upper' : 'Lower'} ${stage === 'main' ? 'Championship' : 'Consolation'}`;
}

export function qualifierDetail(
  { status, entrantId }: PublicFinalsField['slots'][number],
  names: ReadonlyMap<string, string>,
) {
  if (status === 'review_pending') return 'Under score review';
  return status === 'resolved' ? (entrantId && names.get(entrantId)) || 'Confirmed' : null;
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
