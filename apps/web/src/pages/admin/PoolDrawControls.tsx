import { Button } from '../../components/ui/Button';
import { useConfirmation } from '../../lib/confirmation';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export function PoolDrawControls({
  data,
  closed,
  pending,
  act,
}: {
  data: Overview;
  closed: boolean;
  pending: boolean;
  act: (work: () => Promise<unknown>, message: string) => Promise<unknown>;
}) {
  const confirmAction = useConfirmation();
  const planId = data.plan.id;
  const canSoftLock =
    data.plan.drawPaused || (data.plan.status === 'pools_ready' && !data.plan.softLockedAt);
  const canUnlock = data.plan.liveOwned
    ? !data.plan.drawPaused &&
      !closed &&
      !data.reports.length &&
      data.matches.every((m) => !m.started && m.status !== 'complete')
    : data.plan.status === 'pools_ready' && Boolean(data.plan.softLockedAt);
  return (
    <section className="card ops-setup">
      <div>
        <h3>
          Pool draw:{' '}
          {data.plan.drawPaused ? 'Paused' : data.plan.softLockedAt ? 'Soft-locked' : 'Draft'}
        </h3>
        <p className="muted">
          {data.plan.drawPaused
            ? 'Play is paused. Adjust attendance in this desk, then resume the draw.'
            : data.plan.softLockedAt
              ? 'The TO has committed to these pools and opponents. Late arrivals and no-shows change only their affected pools.'
              : 'You can still change the roster and rebalance pools in the planner. A TO must explicitly soft-lock the draw before using local attendance changes.'}
        </p>
        {data.plan.softLockedAt && (
          <p className="muted">Soft-locked {new Date(data.plan.softLockedAt).toLocaleString()}.</p>
        )}
      </div>
      {canSoftLock && (
        <Button
          variant="primary"
          disabled={pending}
          onClick={async () => {
            if (
              await confirmAction(
                data.plan.drawPaused
                  ? 'Resume this draw with its current pools and opponents?'
                  : 'Soft-lock this pool draw? Existing players will keep their pools and opponents, and the initial match queue will be prepared.',
              )
            )
              void act(
                () => trpc.eventOps.softLockPools.mutate({ planId, confirm: true }),
                'Pool draw soft-locked',
              );
          }}
        >
          {data.plan.drawPaused ? 'Resume pool draw' : 'Soft-lock pool draw'}
        </Button>
      )}
      {canUnlock && (
        <Button
          disabled={pending}
          onClick={async () => {
            if (
              await confirmAction(
                data.plan.liveOwned
                  ? 'Pause this unplayed draw? Pool assignments and match history stay recorded. You can adjust attendance before resuming.'
                  : 'Return this pool draw to draft? This clears unplayed matches, saved pool assignments, and pool station settings. The planner may rebalance the pools. Recorded play and linked brackets cannot be cleared this way.',
              )
            )
              void act(
                () => trpc.eventOps.unlockPools.mutate({ planId, confirm: true }),
                data.plan.liveOwned
                  ? 'Unplayed draw paused. Adjust attendance here before resuming.'
                  : 'Pool draw returned to draft. You can rebalance it in the planner.',
              );
          }}
        >
          {data.plan.liveOwned ? 'Pause unplayed draw' : 'Return draw to draft'}
        </Button>
      )}
    </section>
  );
}
