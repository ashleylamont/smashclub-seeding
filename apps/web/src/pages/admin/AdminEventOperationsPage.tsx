import { OpsMatchSummary } from './OpsMatchSummary';
import { OpsAnnouncements } from './OpsAnnouncements';
import { OpsAccessControls } from './OpsAccessControls';
import { Tabs, TabList, Tab, TabPanel } from '../../components/ui/Tabs';
import { LoadingState, Notice } from '../../components/ui/Feedback';
import { OPS_SECTIONS, useOpsWorkspace } from '../../lib/opsWorkspace';
import { MatchCard } from './OpsMatchCard';
import { PlayerReports, AuditList } from './OpsPlayerReports';
import { ScorePolicyControls } from './ScorePolicyControls';
import { StationPoolControls } from './StationPoolControls';
import { NativeBracketControls } from './NativeBracketControls';
import { useState } from 'react';
import { ToPlayerFinder } from './ToPlayerFinder';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch, useParams } from '@tanstack/react-router';
import { trpc } from '../../lib/trpc';
import { authClient, useCurrentUser } from '../../lib/auth';
import './EventOperations.css';
import { ScoreHandoff } from './ScoreHandoff';
import { AttendanceControls } from './AttendanceControls';
import { AttendeeList } from './AttendeeList';
import { GuestReportingControls } from './GuestReportingControls';
import { availableMatches, poolStandings } from '../../lib/eventQueue';
import { OpsAttentionDesk } from './OpsAttentionDesk';

export function AdminEventOperationsPage() {
  const search = useSearch({ strict: false }) as { plan?: string };
  const plans = useQuery({
    queryKey: ['admin', 'eventPlanner', 'plans'],
    queryFn: () => trpc.admin.eventPlanner.plans.query(),
  });
  if (search.plan) return <EventOperationsPanel planId={search.plan} />;
  return (
    <section className="card">
      <h2>Run an event</h2>
      <p>Select an event.</p>
      {plans.isPending && <p>Loading events…</p>}
      {plans.isError && <p role="alert">{plans.error.message}</p>}
      <div className="ops-event-list">
        {plans.data?.map((plan) => (
          <a
            className="ops-event-link"
            href={`/admin/event-operations?plan=${plan.id}`}
            key={plan.id}
          >
            <strong>{plan.name}</strong>
            <span>
              {plan.status.replaceAll('_', ' ')} · {plan.entryCount} entrants
            </span>
          </a>
        ))}
      </div>
      {plans.data?.length === 0 && <a href="/admin/event-planner">Create your first event plan</a>}
    </section>
  );
}

export function AssignedEventOperationsPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  return <EventOperationsPanel planId={planId} />;
}

export function EventOperationsPanel({ planId }: { planId: string }) {
  const workspace = useOpsWorkspace();
  const [stageStationId, setStageStationId] = useState('');
  const cache = useQueryClient();
  const { data: session } = authClient.useSession();
  const currentUser = useCurrentUser(session);
  const admin = currentUser.data?.role === 'admin';
  const event = useQuery({
    queryKey: ['eventOps', planId],
    queryFn: () => trpc.eventOps.overview.query({ planId }),
    refetchInterval: 2500,
  });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState('playing');
  const [division, setDivision] = useState('all');
  const [search, setSearch] = useState('');
  const [poolFilter, setPoolFilter] = useState('all');
  const [focusedMatchId, setFocusedMatchId] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>, message = 'Saved') => {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(message);
      await cache.invalidateQueries({ queryKey: ['eventOps', planId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save. Please try again.');
    } finally {
      setPending(false);
    }
  };
  if (event.isPending) return <LoadingState>Opening event…</LoadingState>;
  if (!event.data)
    return (
      <section className="card">
        <h2>Event control</h2>
        <Notice tone="danger">{event.error?.message ?? 'Event unavailable'}</Notice>
        <button className="btn" onClick={() => void event.refetch()}>
          Try again
        </button>
        <a href="/login">Sign in</a>
      </section>
    );
  const data = event.data;
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const canSoftLock = data.plan.status === 'pools_ready' && !data.plan.softLockedAt;
  const canUnlock = data.plan.status === 'pools_ready' && Boolean(data.plan.softLockedAt);
  const disputes = data.reports.filter(
    (report) => report.status === 'pending' && report.isDispute,
  ).length;
  const available = availableMatches(data.matches).filter((match) => match.availability.canStart);
  const callable = new Set(available.map((match) => match.id));
  const pools = poolStandings(data.matches);
  const matches = focusedMatchId
    ? data.matches.filter((match) => match.id === focusedMatchId)
    : (filter === 'ready' ? available : data.matches).filter(
        (match) =>
          (division === 'all' || match.division === division) &&
          (filter === 'all' ||
            (filter === 'active'
              ? match.status !== 'complete'
              : filter === 'waiting'
                ? match.status === 'blocked' ||
                  (match.status === 'ready' && !callable.has(match.id))
                : match.status === filter)) &&
          (poolFilter === 'all' ||
            (match.stage === 'group' && `${match.division}:${match.poolIndex}` === poolFilter)) &&
          `${match.player1Name} ${match.player2Name} ${match.label}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      );
  const stageStation =
    data.stations.find((station) => station.id === stageStationId) ?? data.stations[0];
  const stageMatch = data.matches.find((match) => match.id === stageStation?.currentMatchId);
  return (
    <div className="ops-page">
      <header className="ops-heading">
        <div>
          <span className="ops-eyebrow">TO desk</span>
          <h2>{data.plan.name}</h2>
          <p className="muted">
            {closed ? 'Event closed · read only' : data.plan.status.replaceAll('_', ' ')}
          </p>
        </div>
        <nav className="ops-links" aria-label="Event links">
          <button
            className="btn btn-small"
            onClick={() => void workspace.openControl('station-controls')}
          >
            Stations
          </button>
          {data.plan.resultsSlug && (
            <a href={`/events/${encodeURIComponent(data.plan.resultsSlug)}`}>Final results</a>
          )}
          {admin && <a href={`/admin/event-planner?plan=${planId}`}>Planner</a>}
          <a href={`/live/${planId}`} target="_blank" rel="noreferrer">
            Public board ↗
          </a>
          <a href={`/overlay/${planId}`} target="_blank" rel="noreferrer">
            OBS overlay ↗
          </a>
          <a href={`/play/${planId}`}>Player reporting</a>
        </nav>
      </header>
      <OpsAttentionDesk
        data={data}
        onJump={(id) => void workspace.openControl(id)}
        onMatch={(id) => {
          setFocusedMatchId(id);
          setDivision('all');
          setPoolFilter('all');
          setSearch('');
          setFilter('all');
          void workspace.openControl('match-desk');
        }}
      />
      {event.isError && (
        <div className="banner banner-warning" role="alert">
          Live updates interrupted. Last loaded data is shown. {event.error.message}
        </div>
      )}
      {error && (
        <div className="banner banner-danger" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p className="ops-notice" role="status">
          {notice}
        </p>
      )}
      {disputes > 0 && (
        <p className="banner banner-warning" role="status">
          <strong>
            {disputes} conflicting {disputes === 1 ? 'score needs' : 'scores need'} TO review.
          </strong>{' '}
          Recorded results stay in place.{' '}
          <button
            className="btn btn-small"
            onClick={() => void workspace.openControl('score-submissions')}
          >
            Review disagreements
          </button>
        </p>
      )}
      <Tabs
        value={workspace.section}
        onValueChange={(value) => void workspace.changeSection(value)}
      >
        <TabList className="ops-workspace-nav" aria-label="Event workspace">
          {OPS_SECTIONS.map((section) => (
            <Tab key={section.value} value={section.value}>
              {section.label}
            </Tab>
          ))}
        </TabList>
        <TabPanel value="run">
          <OpsMatchSummary
            matches={data.matches}
            callable={callable}
            filter={filter}
            onSelect={(status) => {
              setFocusedMatchId(null);
              setFilter(status);
            }}
          />
          <section className="card ops-setup" id="match-desk" tabIndex={-1}>
            <div>
              <h3>Match desk</h3>
              {!data.plan.softLockedAt && (
                <p>
                  Soft-lock pools in{' '}
                  <button
                    className="btn btn-small"
                    onClick={() => void workspace.changeSection('draw')}
                  >
                    Standings / draw
                  </button>{' '}
                  to prepare matches.
                </p>
              )}
            </div>
            <button
              className="btn"
              disabled={pending || closed || !data.plan.softLockedAt}
              onClick={() =>
                void act(() => trpc.eventOps.prepare.mutate({ planId }), 'Match queue refreshed')
              }
            >
              Prepare / refresh matches
            </button>
          </section>
          {focusedMatchId && (
            <p className="ops-focus-match card">
              Showing the selected match.
              <button className="btn btn-small" onClick={() => setFocusedMatchId(null)}>
                Show all matches
              </button>
            </p>
          )}
          <div className="ops-toolbar" onChange={() => setFocusedMatchId(null)}>
            <label>
              View
              <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="active">Unfinished</option>
                <option value="ready">Ready to start</option>
                <option value="playing">Playing</option>
                <option value="waiting">Waiting for players or stations</option>
                <option value="complete">Completed</option>
                <option value="all">All matches</option>
              </select>
            </label>
            <label>
              Division
              <select
                className="select"
                value={division}
                onChange={(e) => setDivision(e.target.value)}
              >
                <option value="all">Both divisions</option>
                <option value="upper">Upper</option>
                <option value="lower">Lower</option>
              </select>
            </label>
            <label>
              Pool
              <select
                className="select"
                value={poolFilter}
                onChange={(event) => setPoolFilter(event.target.value)}
              >
                <option value="all">All pools and brackets</option>
                {pools.map((pool) => (
                  <option
                    key={`${pool.division}:${pool.poolIndex}`}
                    value={`${pool.division}:${pool.poolIndex}`}
                  >
                    {pool.division} Pool {String.fromCharCode(65 + pool.poolIndex)}
                  </option>
                ))}
              </select>
            </label>
            <label className="ops-search">
              Find a player or match
              <input
                className="input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search the queue"
              />
            </label>
          </div>
          <div className="ops-match-grid">
            {matches.map((match) => (
              <MatchCard
                key={match.id}
                match={match}
                stations={data.stations}
                disabled={pending || closed}
                canStart={callable.has(match.id)}
                native={data.plan.bracketMode === 'native'}
                act={act}
              />
            ))}
          </div>
          {matches.length === 0 && (
            <p className="card muted">
              {data.matches.length === 0
                ? 'Generate pools in the planner, then prepare the match queue here.'
                : filter === 'playing'
                  ? 'No matches playing. Choose Ready to start to find the next pairing.'
                  : 'No matches in this view.'}
            </p>
          )}
          <PlayerReports data={data} disabled={pending || closed} act={act} />
          <StationPoolControls
            onMatch={(id) => {
              setFocusedMatchId(id);
              void workspace.openControl('match-desk');
            }}
            data={data}
            disabled={pending || closed}
            act={act}
            onPool={(key) => {
              setFocusedMatchId(null);
              setSearch('');
              setPoolFilter(key);
              setDivision('all');
              setFilter('active');
              void workspace.openControl('match-desk');
            }}
          />
        </TabPanel>
        <TabPanel value="players">
          <ToPlayerFinder
            data={data}
            onMatch={(id) => {
              setFocusedMatchId(id);
              setSearch('');
              setDivision('all');
              setPoolFilter('all');
              setFilter('all');
              void workspace.openControl('match-desk');
            }}
            onPool={(key) => {
              setFocusedMatchId(null);
              setSearch('');
              setPoolFilter(key);
              setDivision('all');
              setFilter('all');
              void workspace.openControl('match-desk');
            }}
          />
          <AttendeeList planId={planId} closed={closed} />
          <AttendanceControls planId={planId} data={data} disabled={pending || closed} />
        </TabPanel>
        <TabPanel value="draw">
          <section className="card ops-setup">
            <div>
              <h3>Pool draw: {data.plan.softLockedAt ? 'Soft-locked' : 'Draft'}</h3>
              <p className="muted">
                {data.plan.softLockedAt
                  ? 'The TO has committed to these pools and opponents. Late arrivals and no-shows change only their affected pools.'
                  : 'You can still change the roster and rebalance pools in the planner. A TO must explicitly soft-lock the draw before using local attendance changes.'}
              </p>
              {data.plan.softLockedAt && (
                <p className="muted">
                  Soft-locked {new Date(data.plan.softLockedAt).toLocaleString()}.
                </p>
              )}
            </div>
            {canSoftLock && (
              <button
                className="btn btn-primary"
                disabled={pending}
                onClick={() => {
                  if (
                    window.confirm(
                      'Soft-lock this pool draw? Existing players will keep their pools and opponents, and the initial match queue will be prepared.',
                    )
                  )
                    void act(
                      () => trpc.eventOps.softLockPools.mutate({ planId, confirm: true }),
                      'Pool draw soft-locked',
                    );
                }}
              >
                Soft-lock pool draw
              </button>
            )}
            {canUnlock && (
              <button
                className="btn"
                disabled={pending}
                onClick={() => {
                  if (
                    window.confirm(
                      'Return this pool draw to draft? This clears unplayed matches, saved pool assignments, and pool station settings. The planner may rebalance the pools. Recorded play and linked brackets cannot be cleared this way.',
                    )
                  )
                    void act(
                      () => trpc.eventOps.unlockPools.mutate({ planId, confirm: true }),
                      'Pool draw returned to draft. You can rebalance it in the planner.',
                    );
                }}
              >
                Return draw to draft
              </button>
            )}
          </section>
          {pools.length > 0 && (
            <section className="card">
              <h3>Pool standings</h3>
              <p className="muted">
                Ordered by wins, then game difference for review. Ties and final advancement must be
                confirmed in the planner.
              </p>
              <div className="ops-bottom-grid">
                {pools.map((pool) => (
                  <div key={`${pool.division}:${pool.poolIndex}`}>
                    <h4>
                      {pool.division} · Pool {String.fromCharCode(65 + pool.poolIndex)}{' '}
                      <span className="muted">
                        {pool.complete}/{pool.total} sets
                      </span>
                    </h4>
                    <table className="ops-standings">
                      <thead>
                        <tr>
                          <th>Player</th>
                          <th>W–L</th>
                          <th>Games ±</th>
                          <th>To play</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pool.players.map((player) => (
                          <tr key={player.id}>
                            <td>{player.name}</td>
                            <td>
                              {player.wins}–{player.losses}
                            </td>
                            <td>
                              {player.differential > 0 ? '+' : ''}
                              {player.differential}
                            </td>
                            <td>{player.remaining}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
              {admin ? (
                <a href={`/admin/event-planner?plan=${planId}&step=pools`}>
                  Review and confirm advancement →
                </a>
              ) : (
                <p className="muted">
                  Ask an event administrator to confirm advancement in the planner.
                </p>
              )}
            </section>
          )}
          {data.plan.bracketMode === 'native' ? (
            <NativeBracketControls planId={planId} entrants={data.entrants} closed={closed} />
          ) : (
            <details className="ops-external-handoff">
              <summary>Challonge integration</summary>
              <ScoreHandoff planId={planId} data={data} disabled={pending || closed} />
            </details>
          )}
        </TabPanel>
        <TabPanel value="broadcast">
          <section className="card ops-main-stage">
            <h3>Main stage</h3>
            <label>
              Station
              <select
                className="select"
                value={stageStationId || data.stations[0]?.id || ''}
                onChange={(event) => setStageStationId(event.target.value)}
              >
                {!data.stations.length && <option value="">No stations configured</option>}
                {data.stations.map((station) => (
                  <option key={station.id} value={station.id}>
                    {station.name}
                  </option>
                ))}
              </select>
            </label>
            {stageMatch ? (
              <MatchCard
                key={stageMatch.id}
                match={stageMatch}
                stations={data.stations}
                disabled={pending || closed}
                canStart={callable.has(stageMatch.id)}
                native={data.plan.bracketMode === 'native'}
                act={act}
              />
            ) : (
              <p>No match playing at this station.</p>
            )}
            <a
              className="btn"
              href={`/overlay/${planId}${stageStation ? `?station=${stageStation.id}` : ''}`}
              target="_blank"
              rel="noreferrer"
            >
              Open station overlay ↗
            </a>
          </section>
          <OpsAnnouncements data={data} pending={pending} closed={closed} act={act} />
        </TabPanel>
        <TabPanel value="settings">
          <ScorePolicyControls
            onReports={() => void workspace.openControl('score-submissions')}
            data={data}
            admin={admin}
            disabled={pending || closed}
            act={act}
          />
          <GuestReportingControls
            planId={planId}
            eventName={data.plan.name}
            stations={data.stations}
            closed={closed}
            published={data.settings.published}
          />
          {admin && <OpsAccessControls data={data} pending={pending} closed={closed} act={act} />}
          {admin && !closed && (
            <details className="card">
              <summary>
                {data.plan.softLockedAt
                  ? 'Before play: reset match queue'
                  : 'Before play: rebuild the roster'}
              </summary>
              <p className="muted">
                {data.plan.softLockedAt
                  ? 'Clear unplayed matches while keeping the soft-locked pool assignments. Prepare matches again to restore the queue.'
                  : 'Clear an unplayed queue before reopening the planner. This is unavailable once a match starts, a score is reported, someone withdraws, or a bracket is attached.'}
              </p>
              <button
                className="btn"
                disabled={
                  pending ||
                  data.matches.some(
                    (match) => match.status === 'playing' || match.status === 'complete',
                  ) ||
                  data.reports.length > 0 ||
                  data.withdrawals.length > 0 ||
                  data.brackets.some((bracket) => bracket.slug)
                }
                onClick={() => {
                  if (
                    window.confirm(
                      data.plan.softLockedAt
                        ? 'Clear this unplayed match queue? Soft-locked pools will stay in place.'
                        : 'Clear this unplayed match queue? You can then reopen the roster in the planner.',
                    )
                  )
                    void act(
                      () => trpc.eventOps.resetOperations.mutate({ planId }),
                      data.plan.softLockedAt
                        ? 'Unplayed queue cleared. Pool assignments were kept.'
                        : 'Unplayed queue cleared. Reopen the roster in the planner to reshuffle.',
                    );
                }}
              >
                Reset unplayed queue
              </button>
            </details>
          )}
          <details className="card">
            <summary>Recent changes</summary>
            <AuditList data={data} />
          </details>
        </TabPanel>
      </Tabs>
    </div>
  );
}
