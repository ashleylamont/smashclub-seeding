import { ActiveCall, ReadyCall } from './DispatchCall';
import { DispatchSetup } from './DispatchSetup';
import { UntakenCallRecovery, type UntakenCallDesk } from './UntakenCallRecovery';
import type { Overview } from './dispatchTypes';
import type { DispatchCommandController } from './dispatchCommand';
import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Button } from '../../components/ui/Button';
import { Disclosure } from '../../components/ui/Disclosure';
import { Input } from '../../components/ui/Input';
import { Select, SelectItem } from '../../components/ui/Select';
import { DispatchShortcuts } from './DispatchShortcuts';
import { dispatchShortcut, focusDispatchTarget } from './dispatchKeyboard';
import './DispatchDesk.css';

export type DispatchDeskNavigation = { goToReadyQueue: () => boolean };

export function DispatchDesk({
  data,
  dispatch,
  callDesk,
  onMatch,
  onReviewReports,
  shortcutsActive,
  focusScore,
  navigationRef,
}: {
  data: Overview;
  dispatch: DispatchCommandController;
  callDesk: UntakenCallDesk;
  onMatch: (id: string) => void;
  onReviewReports: () => void;
  shortcutsActive: boolean;
  focusScore: () => boolean;
  navigationRef: Ref<DispatchDeskNavigation>;
}) {
  const [search, setSearch] = useState('');
  const [view, setView] = useState('ready');
  const [limit, setLimit] = useState(12);
  const pairingsHeading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const changeView = (value: string) => {
    setView(value);
    setLimit(12);
  };
  const goToReadyQueue = () => {
    if (!pairingsHeading.current) return false;
    if (view !== 'ready') changeView('ready');
    return focusDispatchTarget(pairingsHeading.current);
  };
  useImperativeHandle(navigationRef, () => ({ goToReadyQueue }));
  if (!data.operatorDispatch) return null;
  const desk = data.operatorDispatch;
  const { busy, error, run } = dispatch;
  const shared = desk.mode === 'shared';
  const activeMatches = data.matches.filter((match) => match.status === 'playing');
  const matchesById = new Map(data.matches.map((match) => [match.id, match]));
  const queue = desk.queue.flatMap((row) => {
    const match = matchesById.get(row.matchId);
    return match ? [{ match, row }] : [];
  });
  const queuePairings = queue.filter(({ match }) => match.status === 'ready');
  const heldPairings = queue.filter(({ match }) => match.status === 'blocked');
  const pairingsInView = queuePairings.filter(
    ({ row }) =>
      view === 'all' || (view === 'ready' ? row.state === 'ready' : row.state === 'blocked'),
  );
  const visiblePairings = pairingsInView.filter(({ match }) =>
    `${match.player1Name} ${match.player2Name} ${match.label}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  let emptyMessage = 'No pairings in the queue.';
  if (pairingsInView.length) {
    emptyMessage = 'No pairings match this search. Clear the search to see this view.';
  } else if (queuePairings.length) {
    emptyMessage =
      view === 'ready'
        ? 'No pairings ready to call. Choose Waiting to see what is blocking them.'
        : 'No pairings waiting. Choose Ready to call to see available pairings.';
  } else if (heldPairings.length) {
    emptyMessage = 'No pairings in the queue. Check Held matches and unresolved opponents.';
  }
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
          <section className="card dispatch-pairings">
            <div className="dispatch-pairings-heading">
              <h3
                ref={pairingsHeading}
                tabIndex={-1}
                aria-keyshortcuts={dispatchShortcut('readyQueue')}
              >
                Pairings
              </h3>
              <DispatchShortcuts
                active={shortcutsActive}
                actions={{
                  findPairing: () => focusDispatchTarget(searchInput.current),
                  focusScore,
                  readyQueue: goToReadyQueue,
                }}
              />
            </div>
            <PairingFilters
              search={search}
              searchInput={searchInput}
              view={view}
              onSearchChange={(value) => {
                setSearch(value);
                setLimit(12);
              }}
              onViewChange={changeView}
            />
            <ol className="dispatch-list" hidden={!visiblePairings.length}>
              {visiblePairings.slice(0, limit).map((pairing) => {
                const { match, row } = pairing;
                const index = queuePairings.indexOf(pairing);
                return (
                  <li key={match.id}>
                    <ReadyCall
                      match={match}
                      row={row}
                      desk={desk}
                      run={run}
                      disabled={busy}
                      onMatch={onMatch}
                      onReviewReports={onReviewReports}
                      previous={queuePairings[index - 1]?.match.id}
                      afterNext={queuePairings[index + 2]?.match.id ?? null}
                      last={index === queuePairings.length - 1}
                    />
                  </li>
                );
              })}
            </ol>
            {visiblePairings.length > limit && (
              <Button onClick={() => setLimit(limit + 12)}>Show more pairings</Button>
            )}
            {!visiblePairings.length && <p role="status">{emptyMessage}</p>}
            <Disclosure title="How queue order works">
              <p className="muted">
                Suggested order groups pairings by how long players have waited. Within each group,
                matches with more downstream pairings come first. Move a pairing up or down to
                override the suggested order.
              </p>
            </Disclosure>
          </section>
          {heldPairings.length > 0 && (
            <Disclosure title="Held matches and unresolved opponents" className="card">
              {heldPairings.map(({ match, row }) => (
                <div key={match.id} className="dispatch-row">
                  <strong>
                    {match.player1Name} vs {match.player2Name}
                  </strong>
                  <p>{row.reasons.map((r) => r.message).join(' ')}</p>
                  <Button disabled={busy} onClick={() => onMatch(match.id)}>
                    Review {match.label}
                  </Button>
                </div>
              ))}
            </Disclosure>
          )}
          <Disclosure title="Player availability and pool holds" className="card">
            <p>
              Snooze lasts until a TO marks the player available. Their matches stay in the draw;
              other pairings continue.
            </p>
            <div className="dispatch-availability">
              {desk.entrants.map((entrant) => {
                const matches = activeMatches.filter(
                  (match) => match.player1Id === entrant.id || match.player2Id === entrant.id,
                );
                const availabilityDisabled =
                  busy || matches.length > 0 || entrant.availability === 'withdrawn';
                return (
                  <div className="dispatch-row" key={entrant.id}>
                    <strong>{entrant.name}</strong> · {entrant.availability}
                    <div className="ops-match-actions">
                      <Button
                        size="small"
                        disabled={availabilityDisabled}
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
                              disabled={availabilityDisabled}
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
                    {matches.length > 0 && (
                      <AvailabilityBlocker matches={matches} callDesk={callDesk} busy={busy} />
                    )}
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

function PairingFilters({
  search,
  searchInput,
  view,
  onSearchChange,
  onViewChange,
}: {
  search: string;
  searchInput: Ref<HTMLInputElement>;
  view: string;
  onSearchChange: (value: string) => void;
  onViewChange: (value: string) => void;
}) {
  return (
    <div className="dispatch-call-controls">
      <label>
        Find a pairing
        <Input
          ref={searchInput}
          aria-keyshortcuts={dispatchShortcut('findPairing')}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </label>
      <label>
        Queue view
        <Select value={view} onValueChange={onViewChange}>
          <SelectItem value="ready">Ready to call</SelectItem>
          <SelectItem value="waiting">Waiting</SelectItem>
          <SelectItem value="all">All queue pairings</SelectItem>
        </Select>
      </label>
    </div>
  );
}

function AvailabilityBlocker({
  matches,
  callDesk,
  busy,
}: {
  matches: Overview['matches'];
  callDesk: UntakenCallDesk;
  busy: boolean;
}) {
  if (matches.some((match) => match.started)) {
    return (
      <p className="muted">
        Finish the started match or release its setup before changing availability.
      </p>
    );
  }
  return (
    <>
      <p className="muted">
        Return the untaken {matches.length === 1 ? 'call' : 'calls'} before changing availability.
      </p>
      <UntakenCallRecovery
        matchIds={matches.map(({ id }) => id)}
        desk={callDesk}
        showInstructions={false}
        disabled={busy}
      />
    </>
  );
}
