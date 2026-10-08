import { Disclosure } from '../components/ui/Disclosure';
import { Select, SelectItem } from '../components/ui/Select';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingState, Notice } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import { ScoreFields, type ScoreInputValue } from '../components/ScoreFields';
import { useState } from 'react';
import { eventUnavailable } from '../lib/eventErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { CompletedScoreReport, type ResultSubmission } from '../components/CompletedScoreReport';
import { GuestEvent } from './GuestEventPage';
import { PlayerMatchFilter } from '../components/PlayerMatchFilter';
import { eventPlayers, useDevicePlayer } from '../lib/playerSelection';
import { authClient } from '../lib/auth';
import { trpc } from '../lib/trpc';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import '../styles/event.css';
import { PoolFilter, PoolRoundSchedule, PoolStationQueue } from '../components/PoolStationQueue';
import {
  matchesPool,
  eventPlayOpen,
  poolPath,
  poolPolicy,
  queueScoringIds,
  usePoolFilter,
  type PoolFlowData,
  type StartPoolMatch,
} from '../lib/poolFlow';
import {
  includesPlayer,
  matchStation,
  matchStatus,
  sortPlayerMatches,
} from '../lib/playerMatchView';

type Snapshot = Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>;
type Match = Snapshot['matches'][number];
export function PlayerEventPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  return <PlayerEvent key={planId} planId={planId} />;
}
function PlayerEvent({ planId }: { planId: string }) {
  const online = useOnlineStatus();
  const { data: session, isPending } = authClient.useSession();
  const event = useQuery({
    queryKey: ['eventOpsPublic', planId],
    queryFn: () => trpc.eventOps.snapshot.query({ planId }),
    refetchInterval: 2500,
    retry: false,
    enabled: Boolean(session),
  });
  const reports = useQuery({
    queryKey: ['eventOpsReports', planId],
    queryFn: () => trpc.eventOps.myReports.query({ planId }),
    enabled: Boolean(session),
    refetchInterval: 2500,
  });
  const claims = useQuery({
    queryKey: ['me', 'claims'],
    queryFn: () => trpc.me.claims.query(),
    enabled: Boolean(session),
  });
  const [devicePlayer, setDevicePlayer] = useDevicePlayer(planId);
  const [view, setView] = useState(devicePlayer ? 'mine' : 'queue');
  const [selectedPool, setSelectedPool] = usePoolFilter();
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState('');
  const cache = useQueryClient();
  const [search, setSearch] = useState('');
  if (isPending) return <LoadingState>Loading your event…</LoadingState>;
  if (!session) return <GuestEvent key={planId} planId={planId} />;
  if (event.isPending) return <LoadingState>Loading your event…</LoadingState>;
  if (event.data?.settings.playerReports === false)
    return <GuestEvent key={planId} planId={planId} />;
  const publicationUnavailable = eventUnavailable(event.error);
  if (!event.data || publicationUnavailable)
    return (
      <Notice tone="danger">
        {publicationUnavailable
          ? 'This event is unavailable or has not been published.'
          : 'Could not load your event.'}
        {!publicationUnavailable && (
          <Button size="small" onClick={() => void event.refetch()}>
            Retry
          </Button>
        )}
      </Notice>
    );
  const data: Snapshot & Partial<Pick<PoolFlowData, 'stationQueues' | 'poolRounds'>> = event.data;
  const disputeMode =
    data.settings.scoreReportingMode === 'approve_unless_disputed' &&
    data.plan.bracketMode === 'native';
  const claim = claims.data?.find((claim) => claim.status === 'approved');
  const players = eventPlayers(data.matches);
  const selectedPlayer = players.some((player) => player.id === devicePlayer) ? devicePlayer : '';
  const playerName = players.find((player) => player.id === selectedPlayer)?.name;
  const reported = new Set(reports.data?.map((report) => report.matchId));
  const queued = queueScoringIds(data);
  const matching = data.matches.filter(
    (match) =>
      matchesPool(match, selectedPool) &&
      (!selectedPlayer || includesPlayer(match, selectedPlayer)) &&
      (view === 'results'
        ? match.status === 'complete'
        : view === 'mine'
          ? Boolean(selectedPlayer)
          : view === 'reports'
            ? reported.has(match.id)
            : view === 'all' || search
              ? ['ready', 'playing'].includes(match.status) ||
                (disputeMode && match.status === 'complete') ||
                reported.has(match.id)
              : queued.has(match.id) || reported.has(match.id) || selectedMatch === match.id) &&
      `${match.player1Name} ${match.player2Name} ${match.label} ${match.division}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const visible = selectedPlayer ? sortPlayerMatches(data, matching) : matching;
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const playOpen = eventPlayOpen(data.plan);
  const start = async (input: StartPoolMatch) => {
    setStarting(input.matchId);
    setStartError('');
    try {
      await trpc.eventOps.startPoolMatch.mutate({ planId, ...input });
      setSelectedMatch(input.matchId);
      await cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] });
    } catch (cause) {
      setStartError(
        cause instanceof Error
          ? cause.message
          : 'This station queue changed. Refresh before starting.',
      );
    } finally {
      setStarting(null);
    }
  };
  const choosePool = (value: string) => {
    setSelectedPool(value);
    setSelectedMatch(null);
  };
  const chooseMatch = (id: string) => {
    setSelectedMatch(id);
    setView('queue');
    setSearch('');
    document.getElementById('pool-score-entry')?.scrollIntoView({ behavior: 'smooth' });
  };
  return (
    <div className="ops-page">
      <PageHeader
        title={event.data.plan.name}
        description="Choose your name to find your matches."
        actions={
          <a className="btn" href={poolPath(`/live/${planId}`, selectedPool)}>
            Event board →
          </a>
        }
      />
      {(!online || event.isError) && (
        <p role="alert">Live updates interrupted. Scores shown may be out of date.</p>
      )}
      {claim && (
        <p>
          Your linked profile: <strong>{claim.playerName}</strong>.
        </p>
      )}
      {!event.data.settings.playerReports && (
        <p className="banner banner-warning">
          Signed-in reporting is off for this event. Ask a TO to record your score or scan the event
          QR for guest access.
        </p>
      )}
      {closed && <p>This event is closed. Ask an organiser about corrections.</p>}
      {!closed && !playOpen && (
        <p className="card">
          Match reporting opens when the organiser locks or resumes the pool draw.
        </p>
      )}
      <PlayerMatchFilter
        players={players}
        value={selectedPlayer}
        onChange={(id) => {
          setDevicePlayer(id);
          setView(id ? 'mine' : 'all');
          setSelectedPool('');
          setSelectedMatch(null);
          setSearch('');
        }}
      />
      <section className="pool-score-selection" id="pool-score-entry">
        <div className="player-matches-heading">
          <h2>{playerName ? `${playerName}’s matches` : 'Matches & results'}</h2>
          {playerName && (
            <p>
              {visible.length} {visible.length === 1 ? 'match' : 'matches'} in this view · station
              calls first
            </p>
          )}
        </div>
        <Disclosure
          title={<> Match filters{selectedPool ? ' · one pool selected' : ''} </>}
          className="player-match-refine"
          key={selectedPlayer ? 'focused' : 'everyone'}
          defaultOpen={!selectedPlayer}
        >
          <div className="player-match-controls">
            <PoolFilter data={data} value={selectedPool} onChange={choosePool} />
            <div className="ops-toolbar">
              <label>
                View
                <Select aria-label="Match view" value={view} onValueChange={setView}>
                  <SelectItem value="queue">Station matches & my reports</SelectItem>
                  <SelectItem value="all">
                    {disputeMode ? 'All matches & results' : 'All open matches'}
                  </SelectItem>
                  <SelectItem value="results">Recorded results</SelectItem>
                  <SelectItem value="mine" disabled={!selectedPlayer}>
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
            <PlayerScoreCard
              key={`${match.id}:${poolPolicy(data, match)?.selfRun && match.status === 'playing' ? 'playing' : 'regular'}`}
              match={match}
              planId={planId}
              report={reports.data?.find((report) => report.matchId === match.id)}
              disputeMode={disputeMode && !closed && playOpen}
              enabled={
                online &&
                !event.isError &&
                event.data.settings.playerReports &&
                !closed &&
                playOpen &&
                (['ready', 'playing'].includes(match.status) ||
                  (disputeMode && match.status === 'complete'))
              }
              station={matchStation(data, match).name ?? undefined}
              status={matchStatus(data, match)}
              selfRun={Boolean(poolPolicy(data, match)?.selfRun)}
              autoAccept={Boolean(poolPolicy(data, match)?.autoAcceptScores)}
            />
          ))}
        </div>
        {!visible.length && (
          <p className="card">
            {selectedPlayer
              ? 'No matches for this player in this view. Try All selected player’s matches or clear the pool filter.'
              : 'No matches in this view yet. Choose a pool, search for a player, or select All open matches.'}
          </p>
        )}
      </section>
      <PoolStationQueue
        data={data}
        selectedPool={selectedPool}
        playerId={selectedPlayer}
        onStart={(input) => void start(input)}
        onReport={chooseMatch}
        pendingMatchId={starting}
        disabled={!online || event.isError || closed || !playOpen || !data.settings.playerReports}
      />
      {startError && (
        <p className="error-text" role="alert">
          {startError}
        </p>
      )}
      <PoolRoundSchedule data={data} selectedPool={selectedPool} playerId={selectedPlayer} />
    </div>
  );
}
function PlayerScoreCard({
  match,
  planId,
  enabled,
  station,
  status,
  report,
  selfRun,
  autoAccept,
  disputeMode,
}: {
  match: Match;
  planId: string;
  enabled: boolean;
  station?: string;
  status: string;
  report?: Awaited<ReturnType<typeof trpc.eventOps.myReports.query>>[number];
  selfRun: boolean;
  autoAccept: boolean;
  disputeMode: boolean;
}) {
  const reportStatus = report?.status;
  const cache = useQueryClient();
  const [score1, setScore1] = useState<ScoreInputValue>(0);
  const [score2, setScore2] = useState<ScoreInputValue>(0);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [revision, setRevision] = useState(match.revision);
  const [retryRejected, setRetryRejected] = useState(false);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<'approved' | 'pending' | null>(null);
  const [error, setError] = useState('');
  const reportResult = async (input: ResultSubmission) => {
    const result = await trpc.eventOps.reportScore.mutate({
      matchId: match.id,
      ...input,
      outcome: 'played',
    });
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }),
      cache.invalidateQueries({ queryKey: ['eventOpsReports', planId] }),
    ]);
    return result;
  };
  const submit = async () => {
    if (score1 === '' || score2 === '') return;
    setPending(true);
    setError('');
    try {
      const result = await trpc.eventOps.reportScore.mutate({
        matchId: match.id,
        expectedRevision: revision,
        requestId,
        score1,
        score2,
        outcome: 'played',
      });
      setSent(result.status === 'approved' ? 'approved' : 'pending');
      setRetryRejected(false);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }),
        cache.invalidateQueries({ queryKey: ['eventOpsReports', planId] }),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not submit. Try again.');
    } finally {
      setPending(false);
    }
  };
  return (
    <article className="card ops-match">
      <div className="ops-match-meta">
        <span>{match.label}</span>
        <span>
          {status}
          {station ? ` · ${station}` : ''}
        </span>
      </div>
      <h3>
        {match.player1Name} vs {match.player2Name}
      </h3>
      {match.status === 'complete' ? (
        <CompletedScoreReport
          match={match}
          enabled={enabled}
          allowReports={disputeMode && match.outcome === 'played'}
          onSubmit={reportResult}
          pendingReport={report?.status === 'pending' ? report : undefined}
          label="Confirmed"
        />
      ) : match.status === 'blocked' ? (
        <p>Waiting for earlier matches or a TO before this match can start.</p>
      ) : reportStatus === 'rejected' && !retryRejected ? (
        <div>
          <p>Your previous report was rejected. Check the result with a TO before trying again.</p>
          <Button
            onClick={() => {
              setRequestId(crypto.randomUUID());
              setRevision(match.revision);
              setRetryRejected(true);
            }}
          >
            Start a new report
          </Button>
        </div>
      ) : reportStatus === 'pending' || (sent && !reportStatus) ? (
        <p role="status">
          {sent === 'approved'
            ? 'Result confirmed.'
            : 'Score submitted for TO approval. An organiser can correct or reject it if needed.'}
        </p>
      ) : selfRun && match.status !== 'playing' ? (
        <p className="pool-flow-selected-note">
          {status === 'Play next' ? (
            <>
              Start this match from its station’s <a href="#pool-station-queues">Play next card</a>{' '}
              first. Once it is playing, you can report the result here.
            </>
          ) : (
            'Wait for a station call before starting this match.'
          )}
        </p>
      ) : !enabled ? (
        <p className="muted">Match reporting is currently unavailable.</p>
      ) : (
        <form
          className="ops-score-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {reportStatus === 'rejected' && (
            <p className="muted">
              Your previous report was rejected. Check the score with a TO before submitting again.
            </p>
          )}
          {match.revision !== revision && (
            <div role="alert">
              <p>
                Match details changed while you were entering the score. Reload the match before
                submitting.
              </p>
              <Button
                type="button"
                onClick={() => {
                  setRevision(match.revision);
                  setScore1(0);
                  setScore2(0);
                  setRequestId(crypto.randomUUID());
                }}
              >
                Reload match
              </Button>
            </div>
          )}
          <ScoreFields
            player1Name={match.player1Name}
            player2Name={match.player2Name}
            score1={score1}
            score2={score2}
            onScore1={(value) => {
              setScore1(value);
              setRequestId(crypto.randomUUID());
            }}
            onScore2={(value) => {
              setScore2(value);
              setRequestId(crypto.randomUUID());
            }}
          />
          <Button
            type="submit"
            pending={pending}
            variant="primary"
            disabled={
              !enabled ||
              pending ||
              revision !== match.revision ||
              score1 === '' ||
              score2 === '' ||
              score1 === score2 ||
              !match.player1Id ||
              !match.player2Id
            }
          >
            {disputeMode || (selfRun && autoAccept)
              ? 'Confirm result'
              : 'Submit score for approval'}
          </Button>
          <p className="muted">
            {disputeMode
              ? 'Results advance immediately. Later disagreements go to TO review.'
              : selfRun && autoAccept
                ? 'This pool confirms submitted results immediately. Check the players and final score together.'
                : 'A TO checks this score before it becomes a confirmed result.'}
          </p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </article>
  );
}
