import { Disclosure } from '../components/ui/Disclosure';
import { Select, SelectItem } from '../components/ui/Select';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingState, Notice } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { eventUnavailable } from '../lib/eventErrors';
import { GuestScoreCard, type GuestMatch } from '../components/GuestScoreCard';
import { PlayerMatchFilter } from '../components/PlayerMatchFilter';
import { eventPlayers, useDevicePlayer } from '../lib/playerSelection';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { TRPCClientError } from '@trpc/client';
import { trpc } from '../lib/trpc';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import {
  guestTimeLeft,
  useGuestClock,
  readGuestSession,
  saveGuestSession,
  guestSessionCurrent,
  type GuestSession,
} from '../lib/guestReporting';
import '../styles/event.css';
import { PoolFilter, PoolRoundSchedule, PoolStationQueue } from '../components/PoolStationQueue';
import {
  poolPath,
  eventPlayOpen,
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
  const online = useOnlineStatus();
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
  const [passVersion, setPassVersion] = useState(0);
  const redemption = useRef<{
    token: string;
    generation: number;
    promise: Promise<GuestSession>;
  } | null>(null);
  const now = useGuestClock(Boolean(session?.expiresAt));
  const valid = guestSessionCurrent(session, now);
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
        setPassVersion((version) => version + 1);
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
    // The opaque version changes on re-redemption; credentials never enter query keys.
    queryKey: ['guestMatches', planId, cacheId, passVersion],
    queryFn: () =>
      trpc.eventOps.guests.matches.mutate({ planId, sessionToken: session!.sessionToken }),
    enabled: valid && !redeeming,
    refetchInterval: 2500,
    retry: false,
  });
  const accessDenied =
    matches.error instanceof TRPCClientError && matches.error.data?.code === 'FORBIDDEN';
  // FORBIDDEN also covers temporary event unavailability. Retain the saved pass
  // and let the server revalidate it; only a successful redemption replaces it.
  const publicEvent = useQuery({
    queryKey: ['eventOpsPublic', planId],
    queryFn: () => trpc.eventOps.snapshot.query({ planId }),
    refetchInterval: 2500,
    retry: false,
  });
  const unpublished = eventUnavailable(publicEvent.error);
  const eventPlan = (publicEvent.data ?? matches.data)?.plan;
  const playOpen = eventPlayOpen(eventPlan);
  const canWrite =
    online &&
    playOpen &&
    valid &&
    !redeeming &&
    Boolean(matches.data) &&
    !matches.isError &&
    !publicEvent.isError;
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
      <PageHeader
        title={publicEvent.data?.plan.name ?? 'Your event'}
        description="Choose your name to find your matches."
        actions={
          <a className="btn" href={poolPath(`/live/${planId}`, selectedPool)}>
            Event board →
          </a>
        }
      />
      {closed && (
        <p className="card">
          This event is closed. Results remain available; ask a TO about corrections.
        </p>
      )}
      {!closed && !playOpen && (
        <p className="card">
          Match reporting opens when the organiser locks or resumes the pool draw.
        </p>
      )}
      {!closed && (
        <GuestPassStatus
          redeeming={redeeming}
          valid={valid}
          session={session}
          now={now}
          error={matches.isError ? matches.error.message : null}
          accessDenied={accessDenied}
        />
      )}
      {(!online || publicEvent.isError) && !unpublished && data && (
        <p role="alert">Live updates interrupted. Scores shown may be out of date.</p>
      )}
      {!data && !unpublished && (
        <GuestLoadState
          pending={publicEvent.isPending}
          onRetry={() => void publicEvent.refetch()}
        />
      )}
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
            <Disclosure
              title={
                <>
                  Match filters{selectedPool ? ' · one pool selected' : ''}
                  {stationId ? ' · one station selected' : ''}
                </>
              }
              className="player-match-refine"
              key={player ? 'focused' : 'everyone'}
              defaultOpen={!player}
            >
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
                    <Select value={stationId} onValueChange={setSelectedStation}>
                      <SelectItem value="">All stations</SelectItem>
                      {data.stations.map((station) => (
                        <SelectItem key={station.id} value={station.id}>
                          {station.name}
                        </SelectItem>
                      ))}
                    </Select>
                  </label>
                </div>
                <div className="ops-toolbar">
                  <label>
                    View
                    <Select aria-label="Match view" value={view} onValueChange={setView}>
                      <SelectItem value="queue">Station matches & my reports</SelectItem>
                      <SelectItem value="matches">
                        {disputeMode ? 'All matches & results' : 'All open matches'}
                      </SelectItem>
                      <SelectItem value="results">Recorded results</SelectItem>
                      <SelectItem value="mine" disabled={!player}>
                        All selected player’s matches
                      </SelectItem>
                      <SelectItem value="reports">My reports</SelectItem>
                    </Select>
                  </label>
                  <label className="ops-search">
                    Search matches
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Player, pool or match…"
                    />
                  </label>
                </div>
              </div>
            </Disclosure>
            <div className="ops-match-grid">
              {visible.map((match) => (
                <GuestScoreCard
                  key={match.id}
                  planId={planId}
                  session={canWrite && !closed ? session : null}
                  disputeMode={disputeMode && !closed && playOpen}
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

function GuestPassStatus({
  redeeming,
  valid,
  session,
  now,
  error,
  accessDenied,
}: {
  redeeming: boolean;
  valid: boolean;
  session: GuestSession | null;
  now: number;
  error: string | null;
  accessDenied: boolean;
}) {
  if (redeeming) return <LoadingState>Opening your guest pass…</LoadingState>;
  if (!valid || accessDenied)
    return (
      <section className="card">
        <h2>
          {session && !valid
            ? 'Your guest pass has expired'
            : error
              ? 'Refresh your guest pass'
              : 'Scan in to report a score'}
        </h2>
        <p>
          Scan a guest reporting QR at the venue or ask a TO for an active invitation to start
          matches and report scores. You can keep browsing without a pass.
        </p>
        {error && (
          <p className="banner banner-warning" role="alert">
            {error} If this pass was revoked, ask a TO for a new QR.
          </p>
        )}
      </section>
    );
  return (
    <>
      <p className="guest-pass-expiry">
        {session!.expiresAt
          ? `Guest pass · ${guestTimeLeft(session!.expiresAt, now)} remaining`
          : 'Guest pass · valid until revoked'}
      </p>
      {error && (
        <Notice tone="warning">
          Reporting connection interrupted. Your pass is saved; reporting resumes when the
          connection recovers.
        </Notice>
      )}
    </>
  );
}

function GuestLoadState({ pending, onRetry }: { pending: boolean; onRetry: () => void }) {
  if (pending) return <LoadingState>Loading matches…</LoadingState>;
  return (
    <Notice tone="danger">
      Could not load matches.
      <Button size="small" onClick={onRetry}>
        Retry
      </Button>
    </Notice>
  );
}
