import { TRPCClientError } from '@trpc/client';
import { GuestScoreCard, type GuestMatch } from '../components/GuestScoreCard';
import { PlayerMatchFilter } from '../components/PlayerMatchFilter';
import { eventPlayers, useDevicePlayer } from '../lib/playerSelection';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import {
  guestTimeLeft,
  useGuestClock,
  readGuestSession,
  saveGuestSession,
  type GuestSession,
} from '../lib/guestReporting';
import './admin/EventOperations.css';
import { PoolFilter, PoolRoundSchedule, PoolStationQueue } from '../components/PoolStationQueue';
import {
  poolPath,
  poolPolicy,
  queueScoringIds,
  usePoolFilter,
  type PoolFlowData,
  type StartPoolMatch,
} from '../lib/poolFlow';
import { guestVisibleMatches, matchStation, matchStatus } from '../lib/playerMatchView';

export function GuestEventPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  return <GuestEvent key={planId} planId={planId} />;
}
export function GuestEvent({ planId }: { planId: string }) {
  const [invitation, setInvitation] = useState(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('token'),
  );
  const [invitationGeneration, setInvitationGeneration] = useState(0);
  const [session, setSession] = useState<GuestSession | null>(() => readGuestSession(planId));
  const [redeeming, setRedeeming] = useState(Boolean(invitation));
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedPlayer, setSelectedPlayer] = useDevicePlayer(planId);
  const [view, setView] = useState(selectedPlayer ? 'mine' : 'queue');
  const [selectedPool, setSelectedPool] = usePoolFilter();
  const [selectedStation, setSelectedStation] = useState(
    () => new URLSearchParams(window.location.search).get('station') ?? '',
  );
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const cache = useQueryClient();
  const [cacheId] = useState(() => crypto.randomUUID());
  const redemption = useRef<{
    token: string;
    generation: number;
    promise: Promise<GuestSession>;
  } | null>(null);
  const now = useGuestClock();
  const valid = session !== null && Date.parse(session.expiresAt) > now;
  useEffect(() => {
    const acceptInvitation = () => {
      const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
      if (token) {
        setInvitation(token);
        setInvitationGeneration((value) => value + 1);
        setRedeeming(true);
        setError('');
      }
    };
    window.addEventListener('hashchange', acceptInvitation);
    return () => window.removeEventListener('hashchange', acceptInvitation);
  }, []);
  useEffect(() => {
    if (!invitation) return;
    // Strip the invitation before navigation, analytics or a user copying the address.
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    if (
      redemption.current?.token !== invitation ||
      redemption.current.generation !== invitationGeneration
    )
      redemption.current = {
        token: invitation,
        generation: invitationGeneration,
        promise: trpc.eventOps.guests.redeem.mutate({ planId, token: invitation }),
      };
    let active = true;
    void redemption.current.promise
      .then((value) => {
        if (!active) return;
        setSession(value);
        saveGuestSession(planId, value);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Invitation could not be redeemed. Scan a fresh QR.',
          );
      })
      .finally(() => {
        if (active) setRedeeming(false);
      });
    return () => {
      active = false;
    };
  }, [invitation, invitationGeneration, planId]);
  const matches = useQuery({
    queryKey: ['guestMatches', planId, cacheId, session?.expiresAt],
    queryFn: () =>
      trpc.eventOps.guests.matches.mutate({ planId, sessionToken: session!.sessionToken }),
    enabled: valid && !redeeming,
    refetchInterval: 2500,
    retry: false,
  });
  const publicEvent = useQuery({
    queryKey: ['eventOpsPublic', planId],
    queryFn: () => trpc.eventOps.snapshot.query({ planId }),
    refetchInterval: 2500,
    retry: false,
  });
  const unpublished =
    publicEvent.error instanceof TRPCClientError &&
    ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(publicEvent.error.data?.code ?? '');
  const canWrite =
    valid && !redeeming && Boolean(matches.data) && !matches.isError && !publicEvent.isError;
  const data: PoolFlowData | undefined = unpublished
    ? undefined
    : (publicEvent.data ?? matches.data);
  const disputeMode =
    (publicEvent.data ?? matches.data)?.settings.scoreReportingMode === 'approve_unless_disputed' &&
    (publicEvent.data ?? matches.data)?.plan.bracketMode === 'native';
  const closed = data !== undefined && ['complete', 'cancelled'].includes(data.plan.status);
  const players = eventPlayers(data?.matches ?? []);
  const player = players.some((item) => item.id === selectedPlayer) ? selectedPlayer : '';
  const playerName = players.find((item) => item.id === player)?.name;
  const reportedIds = new Set(matches.data?.reports.map((report) => report.matchId));
  const queuedIds = data ? queueScoringIds(data) : new Set<string>();
  const stationId = data?.stations.some((station) => station.id === selectedStation)
    ? selectedStation
    : '';
  const stationQueue = data?.stationQueues?.find((queue) => queue.stationId === stationId);
  const stationMatchIds = new Set([
    stationQueue?.currentMatchId,
    stationQueue?.nextMatchId,
    ...(stationQueue?.upcoming.map((item) => item.matchId) ?? []),
  ]);
  const visible = guestVisibleMatches(data, {
    stationId,
    stationMatchIds,
    selectedMatch,
    selectedPool,
    playerId: player,
    view,
    search,
    disputeMode,
    reportedIds,
    queuedIds,
  });
  const start = async (input: StartPoolMatch) => {
    if (!session || !canWrite) return;
    setStarting(input.matchId);
    setError('');
    try {
      await trpc.eventOps.guests.startPoolMatch.mutate({
        planId,
        sessionToken: session.sessionToken,
        ...input,
      });
      setSelectedMatch(input.matchId);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['guestMatches', planId] }),
        cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }),
      ]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The station queue changed. Refresh before starting.',
      );
    } finally {
      setStarting(null);
    }
  };
  const chooseMatch = (id: string) => {
    setSelectedMatch(id);
    setView('queue');
    setSearch('');
    document.getElementById('guest-score-entry')?.scrollIntoView({ behavior: 'smooth' });
  };
  if (unpublished) return <p role="alert">This event is unavailable or has not been published.</p>;
  return (
    <div className="ops-page guest-page">
      <header>
        <span className="ops-eyebrow">PLAYER AREA / SMASH CLUB</span>
        <h1>{publicEvent.data?.plan.name ?? 'Your event'}</h1>
        <p>
          Choose your name to see your matches, station calls and results. No account or linked
          player profile is needed to browse.
        </p>
        <a href={poolPath(`/live/${planId}`, selectedPool)}>Live event board →</a>
        <p className="muted">
          Pool standings, brackets, announcements and prizes are on the live event board.
        </p>
      </header>
      {closed && (
        <p className="card">
          This event is closed. Results remain available; ask a TO about corrections.
        </p>
      )}
      {!closed &&
        (redeeming ? (
          <p role="status">Opening your guest pass…</p>
        ) : !valid || matches.isError ? (
          <section className="card">
            <h2>
              {session && !valid
                ? 'Your guest pass has expired'
                : matches.isError
                  ? 'Refresh your guest pass'
                  : 'Scan in to report a score'}
            </h2>
            <p>
              Scan a guest reporting QR at the venue or ask a TO for an active invitation to start
              matches and report scores. You can keep browsing without a pass.
            </p>
            {matches.isError && (
              <p className="banner banner-warning" role="alert">
                {matches.error.message} If this pass was revoked, ask a TO for a new QR.
              </p>
            )}
          </section>
        ) : (
          <p className="guest-pass-expiry">
            Guest pass · {guestTimeLeft(session!.expiresAt, now)} remaining
          </p>
        ))}
      {publicEvent.isError && !unpublished && (
        <p role="alert">Live updates interrupted. Scores shown may be out of date.</p>
      )}
      {!data && publicEvent.isPending && <p>Loading matches…</p>}
      {data && (
        <>
          <PlayerMatchFilter
            players={players}
            value={player}
            onChange={(id) => {
              setSelectedPlayer(id);
              setView(id ? 'mine' : 'matches');
              setSelectedPool('');
              setSelectedStation('');
              setSelectedMatch(null);
              setSearch('');
            }}
          />
          <section className="pool-score-selection" id="guest-score-entry">
            <div className="player-matches-heading">
              <h2>{playerName ? `${playerName}’s matches` : 'Matches & results'}</h2>
              {playerName && (
                <p>
                  {visible.length} {visible.length === 1 ? 'match' : 'matches'} in this view ·
                  station calls first
                </p>
              )}
            </div>
            <details
              className="player-match-refine"
              key={player ? 'focused' : 'everyone'}
              open={!player}
            >
              <summary>
                Match filters{selectedPool ? ' · one pool selected' : ''}
                {stationId ? ' · one station selected' : ''}
              </summary>
              <div className="player-match-controls">
                <div className="player-match-secondary-filters">
                  <PoolFilter
                    data={data}
                    value={selectedPool}
                    onChange={(value) => {
                      setSelectedPool(value);
                      setSelectedMatch(null);
                    }}
                  />
                  <label className="pool-flow-filter">
                    Station
                    <select
                      className="select"
                      value={stationId}
                      onChange={(event) => setSelectedStation(event.target.value)}
                    >
                      <option value="">All stations</option>
                      {data.stations.map((station) => (
                        <option key={station.id} value={station.id}>
                          {station.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="ops-toolbar">
                  <label>
                    View
                    <select
                      aria-label="Match view"
                      className="select"
                      value={view}
                      onChange={(e) => setView(e.target.value)}
                    >
                      <option value="queue">Station matches & my reports</option>
                      <option value="matches">
                        {disputeMode ? 'All matches & results' : 'All open matches'}
                      </option>
                      <option value="results">Recorded results</option>
                      <option value="mine" disabled={!player}>
                        All selected player’s matches
                      </option>
                      <option value="reports">My reports</option>
                    </select>
                  </label>
                  <label className="ops-search">
                    Search matches
                    <input
                      className="input"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Player, pool or match…"
                    />
                  </label>
                </div>
              </div>
            </details>
            <div className="ops-match-grid">
              {visible.map((match) => (
                <GuestScoreCard
                  key={`${match.id}:${poolPolicy(data, match)?.selfRun && match.status === 'playing' ? 'playing' : 'regular'}`}
                  planId={planId}
                  session={canWrite && !closed ? session : null}
                  disputeMode={disputeMode && !closed}
                  match={match as GuestMatch}
                  report={matches.data?.reports.find((report) => report.matchId === match.id)}
                  status={matchStatus(data, match)}
                  station={matchStation(data, match).name ?? undefined}
                  selfRun={Boolean(poolPolicy(data, match)?.selfRun)}
                  autoAccept={Boolean(poolPolicy(data, match)?.autoAcceptScores)}
                />
              ))}
            </div>
            {!visible.length && (
              <p className="card">
                {player
                  ? 'No matches for this player in this view. Try All selected player’s matches or clear the pool and station filters.'
                  : view === 'reports'
                    ? 'Your submitted scores will appear here.'
                    : 'No matches in this view yet. Choose a pool, search a player, or select All open matches.'}
              </p>
            )}
          </section>
          <PoolStationQueue
            data={data}
            selectedPool={selectedPool}
            stationId={stationId}
            playerId={player}
            onStart={(input) => void start(input)}
            onReport={chooseMatch}
            pendingMatchId={starting}
            disabled={!canWrite}
          />
          <PoolRoundSchedule data={data} selectedPool={selectedPool} playerId={player} />
        </>
      )}
      {error && !matches.isError && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
