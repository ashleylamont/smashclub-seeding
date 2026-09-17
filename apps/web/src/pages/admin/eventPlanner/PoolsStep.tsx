import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { trpc } from '../../../lib/trpc';
import type { EventPlanDivision, EventPlanPool, EventPlanView } from '../../../lib/apiTypes';
import { DIVISION_LABEL } from './labels';

/**
 * Step 5 and step 7: the pool cards, and the worksheet that records how each
 * pool actually finished.
 *
 * The worksheet is manual on purpose for the first event. Round-robin ties
 * resolve under whatever tiebreak settings the Challonge tournament was created
 * with, and an admin reading the standings screen is a more trustworthy source
 * than this app re-deriving them from set results it did not referee.
 */

export function PoolsStep({ view, onChanged }: { view: EventPlanView; onChanged: () => void }) {
  return (
    <div>
      <div className="page-header">
        <h3>Pools</h3>
        <span className="muted">
          Balanced pools of three to five players, striped across seed order. Top two advance; everyone else enters consolation.
        </span>
      </div>
      {view.divisions.map((division) => (
        <DivisionPools key={division.division} planId={view.plan.id} division={division} locked={!['pools_ready', 'underway'].includes(view.plan.status) || view.brackets.some((bracket) => bracket.division === division.division && bracket.stage === 'consolation' && bracket.challongeSlug !== null)} onChanged={onChanged} />
      ))}
    </div>
  );
}

function DivisionPools({
  planId,
  division,
  locked,
  onChanged,
}: {
  planId: string;
  division: EventPlanDivision;
  locked: boolean;
  onChanged: () => void;
}) {
  if (division.pools.length === 0) {
    return (
      <div className="card section">
        <h4>{DIVISION_LABEL[division.division]}</h4>
        <p className="muted">No pools yet — freeze the roster and generate pools first.</p>
      </div>
    );
  }

  return (
    <div className="card section">
      <div className="page-header">
        <h4>
          {DIVISION_LABEL[division.division]}{' '}
          <span className="muted">
            {division.poolCount} pools · sizes {division.pools.map((pool) => pool.members.length).join(' / ')}
          </span>
        </h4>
      </div>
      <p className="muted">{division.pools.filter((pool) => pool.members.every((member) => member.place !== null)).length}/{division.poolCount} pools confirmed. Resolve ties using the event rules before confirming.</p>
      {locked && <p className="muted">Placements are read-only while the event is closed or consolation is attached. Reconcile and detach consolation before changing qualifiers.</p>}
      {division.championship.length > 0 && <div className="consolation-preview"><h5>Championship qualifiers</h5><ul>{division.championship.map((entrant) => <li key={entrant.playerId}><span className="chip">{entrant.label}</span> {entrant.name}</li>)}</ul></div>}
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

      {division.consolation ? (
        <div className="consolation-preview">
          <h5>Consolation draw</h5>
          <ol className="consolation-list">
            {division.consolation.roundOne.map((pair, index) => (
              <li key={index}>
                <span className="chip">{pair.a.label}</span> {nameOf(division, pair.a.playerId)}
                {pair.b ? (
                  <>
                    {' v '}
                    <span className="chip">{pair.b.label}</span> {nameOf(division, pair.b.playerId)}
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
          {division.pools.every(pool=>pool.members.every(member=>member.place!==null)) ? 'No active entrants are eligible for consolation.' : 'Confirm every pool’s finishing order to generate the consolation draw and its import list.'}
        </p>
      )}
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
  const [order, setOrder] = useState<Array<string | ''>>(
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
        pools: [{ poolIndex: pool.poolIndex, playerIdsInOrder: order as string[], expectedMatchRevisions:pool.matchRevisions??[], expectedPlacementRevision:pool.placementRevision }],
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
        {pool.members.some(member=>member.withdrawn) && <p className="muted">Include withdrawn entrants in the recorded finishing order. On confirmation, they are excluded from advancement: the first two active entrants advance to championship and remaining active entrants enter consolation. Update linked Challonge brackets to match.</p>}
        {pool.members.map((_, place) => (
          <label key={place} className="pool-place">
            <span>{ordinal(place + 1)}</span>
            <select
              disabled={locked || save.isPending}
              className="select"
              value={order[place] ?? ''}
              aria-label={`${ordinal(place + 1)} place in pool ${pool.label}`}
              onChange={(event) => {
                const next = [...order];
                next[place] = event.target.value;
                setOrder(next);
              }}
            >
              <option value="">—</option>
              {pool.members.map((member) => (
                <option key={member.playerId} value={member.playerId}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button
          type="button"
          className="btn btn-small btn-primary"
          disabled={locked || !complete || save.isPending}
          onClick={() => save.mutate()}
          title={complete ? 'Save this pool’s finishing order' : 'Every entrant needs exactly one place'}
        >
          {save.isPending ? 'Saving…' : 'Confirm pool'}
        </button>
        {save.isError && <p className="error-text">{save.error.message}</p>}
      </div>
    </div>
  );
}

function ordinal(place: number): string {
  return ['1st', '2nd', '3rd', '4th'][place - 1] ?? `${place}th`;
}
