import { isKnockout } from '@smashclub/shared';
import { Button } from '../../components/ui/Button';
import { matchPresentation } from '../../lib/matchPresentation';
import { useConfirmation } from '../../lib/confirmation';
import { trpc } from '../../lib/trpc';
import { canSoftLockDraw } from './opsEventStatus';

type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
const waitForPreparation = 'Waiting for an admin to prepare the bracket.';

export function MatchDeskDrawCue({
  plan,
  closed,
  onOpenDraw,
}: {
  plan: Overview['plan'];
  closed: boolean;
  onOpenDraw: () => void;
}) {
  if (plan.softLockedAt) return null;
  const knockout = isKnockout(plan.structure);
  if (knockout && (closed || plan.drawPaused)) return null;
  if (knockout && !canSoftLockDraw(plan)) return <p>{waitForPreparation}</p>;
  return (
    <p>
      {knockout ? 'Soft-lock the bracket in' : 'Soft-lock pools in'}{' '}
      <Button size="small" type="submit" onClick={onOpenDraw}>
        Standings / draw
      </Button>{' '}
      to prepare matches.
    </p>
  );
}

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
  const softLocked = data.plan.softLockedAt;
  const knockout = isKnockout(data.plan.structure);
  const drawHeading = knockout ? 'Knockout draw' : 'Pool draw';
  const drawName = drawHeading.toLowerCase();
  const canSoftLock = (!knockout || !closed) && (paused || canSoftLockDraw(data.plan));
  let state = paused ? 'Paused' : softLocked ? 'Soft-locked' : 'Draft';
  let description: string | undefined;
  if (knockout) {
    if (closed) state = data.plan.status === 'cancelled' ? 'Cancelled' : 'Finalized';
    else if (paused) description = 'Play is paused. Review the roster before resuming.';
    else if (!softLocked)
      description = canSoftLock
        ? 'Soft-lock the bracket before starting play.'
        : waitForPreparation;
  } else {
    description = paused
      ? 'Play is paused. Adjust attendance in this desk, then resume the draw.'
      : softLocked
        ? 'The TO has committed to these pools and opponents. Late arrivals and no-shows change only their affected pools.'
        : 'You can still change the roster and rebalance pools in the planner. A TO must explicitly soft-lock the draw before using local attendance changes.';
  }
  const blocker = !paused && !closed ? data.poolDrawPauseBlocker : null;
  const canUnlock = data.plan.liveOwned
    ? !paused && !closed && blocker === null
    : data.plan.status === 'pools_ready' && Boolean(softLocked);
  const calls =
    blocker?.kind === 'untaken_calls' && data.sharedDispatch
      ? data.matches.filter(({ id }) => blocker.matchIds.includes(id))
      : [];
  return (
    <section className="card ops-setup">
      <div className="ops-pool-draw-description">
        <h3>
          {drawHeading}: {state}
        </h3>
        {description && <p className="muted">{description}</p>}
        {softLocked && (
          <p className="muted">Soft-locked {new Date(softLocked).toLocaleString()}.</p>
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
                knockout
                  ? 'Soft-lock this knockout draw? The current bracket and pairings will be prepared for play.'
                  : 'Soft-lock this pool draw? Existing players will keep their pools and opponents, and the initial match queue will be prepared.',
              ))
            )
              return;
            void act(
              () => trpc.eventOps.softLockPools.mutate({ planId, confirm: true }),
              paused ? `${drawHeading} resumed` : `${drawHeading} soft-locked`,
            );
          }}
        >
          {paused ? `Resume ${drawName}` : `Soft-lock ${drawName}`}
        </Button>
      )}
      {canUnlock && (
        <Button
          disabled={pending}
          onClick={async () => {
            if (
              await confirmAction(
                data.plan.liveOwned
                  ? knockout
                    ? 'Pause this unplayed knockout draw? The bracket and match history stay recorded.'
                    : 'Pause this unplayed draw? Pool assignments and match history stay recorded. You can adjust attendance before resuming.'
                  : knockout
                    ? 'Return this knockout draw to draft? This clears unplayed matches. Recorded play and linked brackets cannot be cleared this way.'
                    : 'Return this pool draw to draft? This clears unplayed matches, saved pool assignments, and pool station settings. The planner may rebalance the pools. Recorded play and linked brackets cannot be cleared this way.',
              )
            )
              void act(
                () => trpc.eventOps.unlockPools.mutate({ planId, confirm: true }),
                data.plan.liveOwned
                  ? knockout
                    ? 'Unplayed draw paused. Review the roster before resuming.'
                    : 'Unplayed draw paused. Adjust attendance here before resuming.'
                  : knockout
                    ? 'Knockout draw returned to draft. Review it in the planner.'
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
