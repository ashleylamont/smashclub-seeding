import { Button } from '../../components/ui/Button';
import { matchPresentation } from '../../lib/matchPresentation';
import { useConfirmation } from '../../lib/confirmation';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export function PoolDrawControls({
  data,
  closed,
  pending,
  act,
  onOpenCall,
}: {
  data: Overview;
  closed: boolean;
  pending: boolean;
  act: (work: () => Promise<unknown>, message: string) => Promise<unknown>;
  onOpenCall: (matchId: string) => void;
}) {
  const confirmAction = useConfirmation();
  const planId = data.plan.id;
  const paused = data.plan.drawPaused;
  const canSoftLock = paused || (data.plan.status === 'pools_ready' && !data.plan.softLockedAt);
  const blocker = !paused && !closed ? data.poolDrawPauseBlocker : null;
  const canUnlock = data.plan.liveOwned
    ? !paused && !closed && blocker === null
    : data.plan.status === 'pools_ready' && Boolean(data.plan.softLockedAt);
  const calls =
    blocker?.kind === 'untaken_calls' && data.sharedDispatch
      ? data.matches.filter(({ id }) => blocker.matchIds.includes(id))
      : [];
  return (
    <section className="card ops-setup">
      <div className="ops-pool-draw-description">
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
        {blocker && <p>{blocker.message}</p>}
        {calls.length > 0 && (
          <ul className="ops-call-links">
            {calls.map((match) => {
              const pairing = matchPresentation(match).title;
              return (
                <li key={match.id}>
                  <span>{pairing}</span>
                  <Button
                    size="small"
                    aria-label={`Open call for ${pairing}`}
                    onClick={() => onOpenCall(match.id)}
                  >
                    Open call
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {canSoftLock && (
        <Button
          variant="primary"
          disabled={pending}
          onClick={async () => {
            if (
              !paused &&
              !(await confirmAction(
                'Soft-lock this pool draw? Existing players will keep their pools and opponents, and the initial match queue will be prepared.',
              ))
            )
              return;
            void act(
              () => trpc.eventOps.softLockPools.mutate({ planId, confirm: true }),
              paused ? 'Pool draw resumed' : 'Pool draw soft-locked',
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
