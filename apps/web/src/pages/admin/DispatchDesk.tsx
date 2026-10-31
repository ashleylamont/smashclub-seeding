import { ActiveCall, ReadyCall } from './DispatchCall';
import { DispatchSetup } from './DispatchSetup';
import type { Overview, Run } from './dispatchTypes';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { Disclosure } from '../../components/ui/Disclosure';
import { Input } from '../../components/ui/Input';
import { Select, SelectItem } from '../../components/ui/Select';
import { trpc } from '../../lib/trpc';
import './DispatchDesk.css';

export function DispatchDesk({
  data,
  disabled,
  onMatch,
  onReviewReports,
}: {
  data: Overview;
  disabled: boolean;
  onMatch: (id: string) => void;
  onReviewReports: () => void;
}) {
  const cache = useQueryClient();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('ready');
  const [limit, setLimit] = useState(12);
  const retry = useRef<{ input: string; id: string } | null>(null);
  if (!data.operatorDispatch) return null;
  const desk = data.operatorDispatch;
  const busy = disabled || pending;
  const run: Run = async (command) => {
    if (busy) return false;
    setPending(true);
    setError('');
    const input = JSON.stringify(command);
    if (retry.current?.input !== input) retry.current = { input, id: crypto.randomUUID() };
    try {
      await trpc.eventOps.live.command.mutate({
        planId: data.plan.id,
        requestId: retry.current.id,
        command,
      });
      retry.current = null;
      await cache.invalidateQueries({ queryKey: ['eventOps', data.plan.id] });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not change the match queue.');
      return false;
    } finally {
      setPending(false);
    }
  };
  const shared = desk.mode === 'shared';
  const readyIds = desk.queue
    .filter((r) => data.matches.find((m) => m.id === r.matchId)?.status === 'ready')
    .map((r) => r.matchId);
  const visibleIds = readyIds.filter((id) => {
    const row = desk.queue.find((item) => item.matchId === id)!;
    const match = data.matches.find((item) => item.id === id)!;
    return (
      (view === 'all' || (view === 'ready' ? row.state === 'ready' : row.state === 'blocked')) &&
      `${match.player1Name} ${match.player2Name} ${match.label}`
        .toLowerCase()
        .includes(search.toLowerCase())
    );
  });
  return (
    <section className="dispatch-desk" aria-label="TO match queue">
      {error && (
        <p role="alert" className="banner banner-danger">
          {error}
        </p>
      )}
      {shared ? (
        <Disclosure title="Capacity and named stations" className="card">
          <DispatchSetup desk={desk} run={run} disabled={busy} />
        </Disclosure>
      ) : (
        <DispatchSetup desk={desk} run={run} disabled={busy} />
      )}
      {shared && (
        <>
          <section className="card dispatch-summary" aria-label="Shared capacity">
            <h3>Ordinary setups</h3>
            <strong>
              {desk.active} / {desk.capacity} in use
            </strong>
            <p>
              Calls reserve capacity. A score can be reported even if the match was never called.
            </p>
            {desk.overCapacity > 0 && (
              <p role="status" className="banner banner-warning">
                {desk.overCapacity} above the new cap. Existing matches stay in place; new ordinary
                calls wait until space is free.
              </p>
            )}
          </section>
          <section className="card">
            <h3>Called and playing</h3>
            {desk.queue
              .filter((r) => ['called', 'playing'].includes(r.state))
              .map((row) => {
                const match = data.matches.find((m) => m.id === row.matchId);
                if (!match) return null;
                return (
                  <ActiveCall
                    key={match.id}
                    match={match}
                    desk={desk}
                    run={run}
                    disabled={busy}
                    onMatch={onMatch}
                  />
                );
              })}
            {!desk.queue.some((r) => ['called', 'playing'].includes(r.state)) && (
              <p>No current calls.</p>
            )}
          </section>
          <section className="card">
            <h3>Ready and waiting pairings</h3>
            <div className="dispatch-call-controls">
              <label>
                Find a pairing
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setLimit(12);
                  }}
                />
              </label>
              <label>
                Queue view
                <Select
                  value={view}
                  onValueChange={(value) => {
                    setView(value);
                    setLimit(12);
                  }}
                >
                  <SelectItem value="ready">Ready to call</SelectItem>
                  <SelectItem value="waiting">Waiting for players or capacity</SelectItem>
                  <SelectItem value="all">All known pairings</SelectItem>
                </Select>
              </label>
            </div>
            <p className="muted">
              Suggestions favour players waiting longer, then matches that release a later round.
              Move a pairing up or down to change the TO order.
            </p>
            <ol className="dispatch-list">
              {visibleIds.slice(0, limit).map((id) => {
                const index = readyIds.indexOf(id);
                const match = data.matches.find((m) => m.id === id)!;
                const row = desk.queue.find((r) => r.matchId === id)!;
                return (
                  <li key={id}>
                    <ReadyCall
                      match={match}
                      row={row}
                      desk={desk}
                      run={run}
                      disabled={busy}
                      onMatch={onMatch}
                      onReviewReports={onReviewReports}
                      previous={readyIds[index - 1]}
                      afterNext={readyIds[index + 2] ?? null}
                      last={index === readyIds.length - 1}
                    />
                  </li>
                );
              })}
            </ol>
            {visibleIds.length > limit && (
              <Button onClick={() => setLimit(limit + 12)}>Show more pairings</Button>
            )}
            {!visibleIds.length && (
              <p>No known ready pairings. Check held matches and pool qualification.</p>
            )}
          </section>
          <Disclosure title="Held matches and unresolved opponents" className="card">
            {desk.queue
              .filter((r) => data.matches.find((m) => m.id === r.matchId)?.status === 'blocked')
              .map((row) => {
                const match = data.matches.find((m) => m.id === row.matchId)!;
                return (
                  <div key={match.id} className="dispatch-row">
                    <strong>
                      {match.player1Name} vs {match.player2Name}
                    </strong>
                    <p>{row.reasons.map((r) => r.message).join(' ')}</p>
                    <Button disabled={busy} onClick={() => onMatch(match.id)}>
                      Review {match.label}
                    </Button>
                  </div>
                );
              })}
          </Disclosure>
          <Disclosure title="Player availability and pool holds" className="card">
            <p>
              Snooze lasts until a TO marks the player available. Their matches stay in the draw;
              other pairings continue.
            </p>
            <div className="dispatch-availability">
              {desk.entrants.map((entrant) => {
                const playing = data.matches.some(
                  (m) => m.status === 'playing' && [m.player1Id, m.player2Id].includes(entrant.id),
                );
                return (
                  <div className="dispatch-row" key={entrant.id}>
                    <strong>{entrant.name}</strong> · {entrant.availability}
                    <Button
                      size="small"
                      disabled={busy || playing || entrant.availability === 'withdrawn'}
                      onClick={() =>
                        void run({
                          kind: 'availability',
                          playerId: entrant.id,
                          expectedRevision: entrant.revision,
                          availability:
                            entrant.availability === 'snoozed' ? 'available' : 'snoozed',
                          reason:
                            entrant.availability === 'snoozed'
                              ? 'TO marked entrant returned'
                              : 'TO marked entrant away',
                        })
                      }
                    >
                      {entrant.availability === 'snoozed'
                        ? `Return ${entrant.name}`
                        : `Snooze ${entrant.name}`}
                    </Button>
                    {entrant.members.length > 1 &&
                      entrant.members.map((member) => {
                        const name =
                          data.members?.find((m) => m.playerId === member.id)?.name ??
                          'Team member';
                        return (
                          <Button
                            key={member.id}
                            size="small"
                            disabled={busy || playing || entrant.availability === 'withdrawn'}
                            onClick={() =>
                              void run({
                                kind: 'availability',
                                playerId: member.id,
                                expectedRevision: entrant.revision,
                                availability:
                                  member.availability === 'snoozed' ? 'available' : 'snoozed',
                                reason:
                                  member.availability === 'snoozed'
                                    ? 'TO marked member returned'
                                    : 'TO marked member away',
                              })
                            }
                          >
                            {member.availability === 'snoozed' ? 'Return' : 'Snooze'} {name}
                          </Button>
                        );
                      })}
                  </div>
                );
              })}
            </div>
            {desk.pools.map((pool) => (
              <div className="dispatch-row" key={pool.id}>
                <span>
                  {pool.division} Pool {String.fromCharCode(65 + pool.index)} ·{' '}
                  {pool.active ? 'Open' : 'On hold'}
                </span>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    void run({
                      kind: 'poolResources',
                      poolId: pool.id,
                      active: !pool.active,
                      stationIds: [],
                      selfRun: pool.selfRun,
                      autoAcceptScores: pool.autoAcceptScores,
                      expectedResourceRevision: desk.resourceRevision,
                    })
                  }
                >
                  {pool.active ? 'Hold pool' : 'Resume pool'}
                </Button>
              </div>
            ))}
          </Disclosure>
        </>
      )}
    </section>
  );
}
