import { Button } from '../../components/ui/Button';
import { Disclosure } from '../../components/ui/Disclosure';
import { useConfirmation } from '../../lib/confirmation';
import { trpc } from '../../lib/trpc';
import type { Overview } from './dispatchTypes';
import { UntakenCallRecovery, type UntakenCallDesk } from './UntakenCallRecovery';

function queueResetBlocker(data: Overview) {
  if (data.matches.some((match) => match.started || match.status === 'complete'))
    return 'Play has started or a result has been recorded. The queue cannot be reset.';
  if (data.reports.length) return 'Score reports have been recorded. The queue cannot be reset.';
  if (data.withdrawals.length) return 'A withdrawal has been recorded. The queue cannot be reset.';
  if (
    (data.plan.liveOwned && data.nativeBrackets.length) ||
    data.brackets.some((bracket) => bracket.slug)
  )
    return 'A bracket is attached. The queue cannot be reset.';
  return null;
}

export function QueueResetControls({
  data,
  pending,
  act,
  callDesk,
}: {
  data: Overview;
  pending: boolean;
  act: (work: () => Promise<unknown>, message: string) => Promise<unknown>;
  callDesk: UntakenCallDesk;
}) {
  const confirm = useConfirmation();
  const { liveOwned, softLockedAt, id: planId } = data.plan;
  const blocker = queueResetBlocker(data);
  const activeMatchIds = data.matches
    .filter(({ status }) => status === 'playing')
    .map(({ id }) => id);
  const copy = liveOwned
    ? {
        details:
          'Reset pool orders, station assignments and pool scoring settings. Existing matches and pairings stay in the queue.',
        confirmation:
          'Reset the setup for this unplayed queue? Its matches and pairings will stay in place.',
        success: 'Queue setup reset. Existing matches and pairings were kept.',
      }
    : softLockedAt
      ? {
          details:
            'Clear unplayed matches while keeping the soft-locked pool assignments. Prepare matches again to restore the queue.',
          confirmation: 'Clear this unplayed match queue? Soft-locked pools will stay in place.',
          success: 'Unplayed queue cleared. Pool assignments were kept.',
        }
      : {
          details:
            'Clear an unplayed queue before reopening the planner. This is unavailable once a match starts, a score is reported, someone withdraws, or a bracket is attached.',
          confirmation:
            'Clear this unplayed match queue? You can then reopen the roster in the planner.',
          success: 'Unplayed queue cleared. Reopen the roster in the planner to reshuffle.',
        };
  return (
    <Disclosure
      title={
        liveOwned || softLockedAt
          ? 'Before play: reset match queue'
          : 'Before play: rebuild the roster'
      }
      className="card"
    >
      <p className="muted">{copy.details}</p>
      {liveOwned && blocker && <p>{blocker}</p>}
      {liveOwned && !blocker && activeMatchIds.length > 0 && (
        <>
          <p>
            Return {activeMatchIds.length === 1 ? 'the untaken call' : 'all untaken calls'} before
            resetting the queue.
          </p>
          <UntakenCallRecovery matchIds={activeMatchIds} desk={callDesk} showInstructions={false} />
        </>
      )}
      <Button
        type="submit"
        disabled={pending || blocker !== null || activeMatchIds.length > 0}
        onClick={async () => {
          if (await confirm(copy.confirmation))
            void act(() => trpc.eventOps.resetOperations.mutate({ planId }), copy.success);
        }}
      >
        Reset unplayed queue
      </Button>
    </Disclosure>
  );
}
