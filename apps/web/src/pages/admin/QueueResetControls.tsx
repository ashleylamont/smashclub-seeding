import { Button } from '../../components/ui/Button';
import { Disclosure } from '../../components/ui/Disclosure';
import { useConfirmation } from '../../lib/confirmation';
import { trpc } from '../../lib/trpc';
import type { Overview } from './dispatchTypes';

export function QueueResetControls({
  data,
  pending,
  act,
}: {
  data: Overview;
  pending: boolean;
  act: (work: () => Promise<unknown>, message: string) => Promise<unknown>;
}) {
  const confirm = useConfirmation();
  const { liveOwned, softLockedAt, id: planId } = data.plan;
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
      <Button
        type="submit"
        disabled={
          pending ||
          data.matches.some(
            (match) => match.started || match.status === 'playing' || match.status === 'complete',
          ) ||
          data.reports.length > 0 ||
          data.withdrawals.length > 0 ||
          data.brackets.some((bracket) => bracket.slug)
        }
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
