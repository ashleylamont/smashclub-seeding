import { isKnockout } from '@smashclub/shared';
import type { trpc } from '../../lib/trpc';

type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;

export function canSoftLockDraw(plan: Overview['plan']) {
  return plan.status === 'pools_ready' && !plan.softLockedAt && !plan.drawPaused;
}

export function describeOpsEventStatus(data: Overview) {
  const { status, bracketMode, structure } = data.plan;
  if (status === 'cancelled') return 'Event cancelled.';
  if (status === 'pools_ready' && isKnockout(structure)) {
    if (canSoftLockDraw(data.plan)) return 'Draw ready to lock.';
    return data.plan.drawPaused ? 'Play paused.' : 'Draw soft-locked.';
  }
  if (status !== 'complete') return status.replaceAll('_', ' ');
  if (bracketMode === 'native' && 'publication' in data && data.publication?.status === 'published')
    return 'Live play ended. Score corrections are in Standings / draw.';
  return 'Live play ended.';
}

export function describeEmptyMatchDesk(data: Overview, visibleMatchCount: number, filter: string) {
  if (data.sharedDispatch || visibleMatchCount > 0) return undefined;
  if (data.matches.length > 0)
    return filter === 'playing'
      ? 'No matches playing. Choose Ready to start to find the next pairing.'
      : 'No matches in this view.';
  if (!isKnockout(data.plan.structure))
    return 'Generate pools in the planner, then prepare the match queue here.';
  // The match desk already gives the bracket preparation state before play.
  return data.plan.softLockedAt ? 'No matches in this draw.' : undefined;
}
