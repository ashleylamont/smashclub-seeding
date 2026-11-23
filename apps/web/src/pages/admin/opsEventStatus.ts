import type { trpc } from '../../lib/trpc';

type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;

export function describeOpsEventStatus(data: Overview) {
  const { status, bracketMode } = data.plan;
  if (status === 'cancelled') return 'Event cancelled.';
  if (status !== 'complete') return status.replaceAll('_', ' ');
  if (bracketMode === 'native' && 'publication' in data && data.publication?.status === 'published')
    return 'Live play ended. Score corrections are in Standings / draw.';
  return 'Live play ended.';
}
