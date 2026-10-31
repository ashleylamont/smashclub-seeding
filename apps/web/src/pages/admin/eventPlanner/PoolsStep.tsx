import { isKnockout } from '@smashclub/shared';
import { Select, SelectItem } from '../../../components/ui/Select';
import { Button } from '../../../components/ui/Button';
import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { trpc } from '../../../lib/trpc';
import type { EventPlanDivision, EventPlanPool, EventPlanView } from '../../../lib/apiTypes';
import { DIVISION_LABEL } from './labels';

/**
 * Step 5 and step 7: the pool cards, and the worksheet that records how each
 * pool actually finished.
 *
 * New native draws decide distinct set-win orders at the official result boundary.
 * This worksheet remains the explicit ruling path for ties and legacy/remote draws.
 */

export function PoolsStep({ view, onChanged }: { view: EventPlanView; onChanged: () => void }) {
  if (isKnockout(view.plan.structure))
    return (
      <section className="card section">
        <h3>Knockout draw ready</h3>
        <p>
          Open the event desk to lock the seeded draw and start matches. Winners and losers advance
          along the chosen bracket; automatic byes use no played games.
        </p>
        <a className="btn btn-primary" href={`/admin/event-operations?plan=${view.plan.id}`}>
          Open event desk
        </a>
      </section>
    );

  return (
    <div>
      <div className="page-header">
        <h3>Pools</h3>
        <span className="muted">
          {view.plan.structure === 'round_robin'
            ? 'Every entrant plays every other entrant. Confirm the finishing order after resolving ties, then finalize the event.'
            : view.plan.structure === 'round_robin_finals'
              ? `Every entrant plays every other entrant. Confirm the finishing order, then advance ${view.plan.structureOptions?.playoffSize ?? 'everyone'} to playoffs${view.plan.structureOptions?.consolation ? ' with consolation for the remaining entrants' : ''}.`
              : `Balanced pools of three to five ${view.plan.competitionFormat === 'doubles' ? 'teams' : 'players'}, striped across seed order. The upper half, rounded up, advances${view.plan.structureOptions?.consolation === false ? '.' : '; everyone else enters consolation.'}`}
        </span>
      </div>
      {view.divisions.map((division) => (
        <DivisionPools
          key={division.division}
          planId={view.plan.id}
          division={division}
          open={Boolean(view.plan.structure && view.plan.structure !== 'dual_division')}
          roundRobin={view.plan.structure === 'round_robin'}
          locked={
            !['pools_ready', 'underway'].includes(view.plan.status) ||
            view.brackets.some(
              (bracket) =>
                bracket.division === division.division &&
                bracket.stage === 'consolation' &&
                bracket.challongeSlug !== null,
            )
          }
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function DivisionPools({
  planId,
  division,
  locked,
  open,
  roundRobin,
  onChanged,
}: {
  open?: boolean;
  roundRobin?: boolean;
  planId: string;
  division: EventPlanDivision;
  locked: boolean;
  onChanged: () => void;
}) {
  if (division.pools.length === 0) {
    return (
      <div className="card section">
        <h4>{open ? 'Open' : DIVISION_LABEL[division.division]}</h4>
        <p className="muted">No pools yet — freeze the roster and generate pools first.</p>
      </div>
    );
  }

  return (
    <div className="card section">
      <div className="page-header">
        <h4>
          {open ? 'Open' : DIVISION_LABEL[division.division]}{' '}
          <span className="muted">
            {division.poolCount} pools · sizes{' '}
            {division.pools.map((pool) => pool.members.length).join(' / ')}
          </span>
        </h4>
      </div>
      <p className="muted">
        {
          division.pools.filter((pool) => pool.members.every((member) => member.place !== null))
            .length
        }
        /{division.poolCount} pools confirmed. Resolve ties using the event rules before confirming.
      </p>
      {locked && (
        <p className="muted">
          Placements are read-only while the event is closed or consolation is attached. Reconcile
          and detach consolation before changing qualifiers.
        </p>
      )}
      {division.championship.length > 0 && (
        <div className="consolation-preview">
          <h5>Championship qualifiers</h5>
          <ul>
            {division.championship.map((entrant) => (
              <li key={entrant.playerId}>
                <span className="chip">{entrant.label}</span> {entrant.name}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="pool-grid">
        {division.pools.map((pool) => (
          <PoolCard
            key={pool.poolIndex}
            planId={planId}
            divisionKey={division.division}
            pool={pool}
            locked={locked}
            onChanged={onChanged}
          />
        ))}
      </div>

      {!roundRobin &&
        (division.consolation ? (
          <div className="consolation-preview">
            <h5>Consolation draw</h5>
            <ol className="consolation-list">
              {division.consolation.roundOne.map((pair, index) => (
                <li key={index}>
                  <span className="chip">{pair.a.label}</span> {nameOf(division, pair.a.playerId)}
                  {pair.b ? (
                    <>
                      {' v '}
                      <span className="chip">{pair.b.label}</span>{' '}
                      {nameOf(division, pair.b.playerId)}
                    </>
                  ) : (
                    <span className="muted"> — bye</span>
                  )}
                </li>
              ))}
            </ol>
            {division.consolation.rematches.length > 0 && (
              <p className="error-text">
                Pool rematch in round one — review the draw before creating consolation.
              </p>
            )}
          </div>
        ) : (
          <p className="muted">
            {division.pools.every((pool) => pool.members.every((member) => member.place !== null))
              ? 'No active entrants are eligible for consolation.'
              : 'Confirm every pool’s finishing order to generate the consolation draw and its import list.'}
          </p>
        ))}
    </div>
  );
}

function nameOf(division: EventPlanDivision, playerId: string): string {
  for (const pool of division.pools) {
    const member = pool.members.find((entry) => entry.playerId === playerId);
    if (member) return member.name;
  }
  return '?';
}

/**
 * One pool: the card you print, and the worksheet you fill in afterwards.
 * Places are chosen with selects rather than drag rows so the whole thing works
 * on a phone at the venue and from a keyboard.
 */
function PoolCard({
  planId,
  divisionKey,
  pool,
  locked,
  onChanged,
}: {
  planId: string;
  divisionKey: 'upper' | 'lower';
  pool: EventPlanPool;
  locked: boolean;
  onChanged: () => void;
}) {
  const saved = useMemo(
    () =>
      pool.members.every((member) => member.place !== null)
        ? [...pool.members].sort((a, b) => a.place! - b.place!).map((member) => member.playerId)
        : [],
    [pool.members],
  );
  const [order, setOrder] = useState<(string | '')[]>(
    saved.length > 0 ? saved : pool.members.map(() => ''),
  );
  const [lastSaved, setLastSaved] = useState(saved);
  if (saved !== lastSaved) {
    setLastSaved(saved);
    setOrder(saved.length > 0 ? saved : pool.members.map(() => ''));
  }

  const save = useMutation({
    mutationFn: () =>
      trpc.admin.eventPlanner.savePoolPlacements.mutate({
        planId,
        division: divisionKey,
        pools: [
          {
            poolIndex: pool.poolIndex,
            playerIdsInOrder: order as string[],
            expectedMatchRevisions: pool.matchRevisions ?? [],
            expectedPlacementRevision: pool.placementRevision,
          },
        ],
      }),
    onSuccess: onChanged,
  });

  const chosen = order.filter((id) => id !== '');
  const complete = chosen.length === pool.members.length && new Set(chosen).size === chosen.length;

  return (
    <div className="pool-card">
      <h5>Pool {pool.label}</h5>
      <ol className="pool-members">
        {pool.members.map((member) => (
          <li key={member.playerId}>
            <span className="seed-number">{member.seed}</span> {member.name}
            {member.withdrawn && <span className="chip">Withdrawn</span>}
            {member.place !== null && <span className="chip">{ordinal(member.place)}</span>}
          </li>
        ))}
      </ol>

      <div className="pool-worksheet">
        <span className="form-label">Final order</span>
        {pool.orderStatus && <p className="muted">{pool.orderStatus.reason}</p>}
        {pool.qualifierRoster && (
          <p className="muted">
            The finals field is fixed. Later withdrawals use availability or forfeits; returning
            excluded entrants do not add finals places.
          </p>
        )}
        {pool.orderLockedReason && <p className="muted">{pool.orderLockedReason}</p>}
        {pool.members.some((member) => member.withdrawn) && (
          <p className="muted">
            Include withdrawn entrants in the recorded finishing order. On confirmation, they are
            excluded from advancement: the upper half of active entrants, rounded up, advance to
            championship. Update linked Challonge brackets to match.
          </p>
        )}
        {pool.members.map((_, place) => (
          <label key={place} className="pool-place">
            <span>{ordinal(place + 1)}</span>
            <Select
              disabled={locked || save.isPending || Boolean(pool.orderLockedReason)}
              value={order[place] ?? ''}
              aria-label={`${ordinal(place + 1)} place in pool ${pool.label}`}
              onValueChange={(selectedValue) => {
                const next = [...order];
                next[place] = selectedValue;
                setOrder(next);
              }}
            >
              <SelectItem value="">—</SelectItem>
              {pool.members.map((member) => (
                <SelectItem key={member.playerId} value={member.playerId}>
                  {member.name}
                </SelectItem>
              ))}
            </Select>
          </label>
        ))}
        <Button
          variant="primary"
          size="small"
          type="button"
          disabled={locked || !complete || save.isPending || Boolean(pool.orderLockedReason)}
          onClick={() => save.mutate()}
          title={
            complete ? 'Save this pool’s finishing order' : 'Every entrant needs exactly one place'
          }
        >
          {save.isPending
            ? 'Saving…'
            : pool.orderStatus?.status === 'automatic'
              ? 'Record organiser ruling'
              : 'Confirm pool'}
        </Button>
        {save.isError && <p className="error-text">{save.error.message}</p>}
      </div>
    </div>
  );
}

function ordinal(place: number): string {
  return ['1st', '2nd', '3rd', '4th'][place - 1] ?? `${place}th`;
}
