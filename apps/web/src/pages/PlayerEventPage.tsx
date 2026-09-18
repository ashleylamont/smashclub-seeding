import { useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { authClient } from '../lib/auth';
import { trpc } from '../lib/trpc';
import './admin/EventOperations.css';
import { PoolFilter, PoolRoundSchedule, PoolStationQueue } from '../components/PoolStationQueue';
import { matchesPool, poolPath, poolPolicy, queueScoringIds, usePoolFilter, type PoolFlowData, type StartPoolMatch } from '../lib/poolFlow';

type Snapshot = Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>;
type Match = Snapshot['matches'][number];
export function PlayerEventPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  const { data: session, isPending } = authClient.useSession();
  const event = useQuery({ queryKey: ['eventOpsPublic', planId], queryFn: () => trpc.eventOps.snapshot.query({ planId }), refetchInterval: 2500, retry: false });
  const reports = useQuery({ queryKey: ['eventOpsReports', planId], queryFn: () => trpc.eventOps.myReports.query({ planId }), enabled: !!session, refetchInterval: 2500 });
  const claims = useQuery({ queryKey: ['me', 'claims'], queryFn: () => trpc.me.claims.query(), enabled: !!session });
  const [view, setView] = useState('queue');
  const [selectedPool, setSelectedPool] = usePoolFilter();
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [startError, setStartError] = useState('');
  const cache = useQueryClient();
  const [search, setSearch] = useState('');
  if (isPending || event.isPending) return <p>Loading your event…</p>;
  if (!session) return <section className="card"><h1>Report a score</h1><p>Sign in to report any match, or scan the current event QR code to report as a guest. Linking a player profile is optional.</p><a href="/login">Sign in</a></section>;
  const publicationUnavailable = event.error instanceof TRPCClientError && ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(event.error.data?.code ?? '');
  if (!event.data || publicationUnavailable) return <p role="alert">This event is unavailable or has not been published.</p>;
  const data: Snapshot & Partial<Pick<PoolFlowData, 'stationQueues' | 'poolRounds'>> = event.data;
  const claim = claims.data?.find(claim => claim.status === 'approved');
  const reported = new Set(reports.data?.map(report => report.matchId));
  const queued = queueScoringIds(data);
  const visible = data.matches.filter(match => matchesPool(match, selectedPool) && (view === 'mine' ? claim && [match.player1Id, match.player2Id].includes(claim.playerId) : view === 'reports' ? reported.has(match.id) : view === 'all' || search ? ['ready', 'playing'].includes(match.status) || reported.has(match.id) : queued.has(match.id) || reported.has(match.id) || selectedMatch === match.id) &&
    `${match.player1Name} ${match.player2Name} ${match.label} ${match.division}`.toLowerCase().includes(search.toLowerCase()));
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const start = async (input: StartPoolMatch) => {
    setStarting(input.matchId); setStartError('');
    try { await trpc.eventOps.startPoolMatch.mutate({ planId, ...input }); setSelectedMatch(input.matchId); await cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }); }
    catch (cause) { setStartError(cause instanceof Error ? cause.message : 'This station queue changed. Refresh before starting.'); }
    finally { setStarting(null); }
  };
  const choosePool = (value: string) => { setSelectedPool(value); setSelectedMatch(null); };
  const chooseMatch = (id: string) => { setSelectedMatch(id); setView('queue'); setSearch(''); document.getElementById('pool-score-entry')?.scrollIntoView({ behavior: 'smooth' }); };
  return <div className="ops-page"><header><span className="ops-eyebrow">REPORT A SCORE</span><h1>{event.data.plan.name}</h1><a href={poolPath(`/live/${planId}`, selectedPool)}>View the event</a></header>
    {event.isError && <p role="alert">Live updates interrupted. Scores shown may be out of date.</p>}
    <p>Find your pool’s stations, start the next match when both players are there, then report the result. Each pool shows whether results need TO approval. {claim && <>Your linked profile is <strong>{claim.playerName}</strong>.</>}</p>
    {!event.data.settings.playerReports && <p className="banner banner-warning">Signed-in reporting is off for this event. Ask a TO to record your score or scan the event QR for guest access.</p>}
    {closed && <p>This event is closed. Ask an organiser about corrections.</p>}
    <PoolFilter data={data} value={selectedPool} onChange={choosePool} />
    <PoolStationQueue data={data} selectedPool={selectedPool} onStart={input => void start(input)} onReport={chooseMatch} pendingMatchId={starting} disabled={event.isError || closed || !data.settings.playerReports} />
    {startError && <p className="error-text" role="alert">{startError}</p>}
    <PoolRoundSchedule data={data} selectedPool={selectedPool} />
    <section className="pool-score-selection" id="pool-score-entry"><h2>Report a result</h2>
    <div className="ops-toolbar"><label>View<select className="select" aria-label="Match view" value={view} onChange={e => setView(e.target.value)}><option value="queue">Station matches & my reports</option><option value="all">All open matches</option><option value="mine" disabled={!claim}>My matches{!claim ? ' (link a player profile)' : ''}</option><option value="reports">My reports</option></select></label><label className="ops-search">Find a player or pool<input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Player name, Upper, Pool A…" /></label></div>
    <div className="ops-match-grid">{visible.map(match => <PlayerScoreCard key={`${match.id}:${poolPolicy(data, match)?.selfRun && match.status === 'playing' ? 'playing' : 'regular'}`} match={match} planId={planId} reportStatus={reports.data?.find(report => report.matchId === match.id)?.status} enabled={!event.isError && event.data.settings.playerReports && !closed && ['ready', 'playing'].includes(match.status)} station={data.stations.find(station => station.id === match.stationId)?.name} selfRun={!!poolPolicy(data, match)?.selfRun} autoAccept={!!poolPolicy(data, match)?.autoAcceptScores} />)}</div>
    {!visible.length && <p className="card">No matches in this view yet. Choose a pool above, search for a player, or select All open matches.</p>}</section>
  </div>;
}
function PlayerScoreCard({ match, planId, enabled, station, reportStatus, selfRun, autoAccept }: { match: Match; planId: string; enabled: boolean; station?: string; reportStatus?: string; selfRun: boolean; autoAccept: boolean }) {
  const cache = useQueryClient();
  const [score1, setScore1] = useState(0);
  const [score2, setScore2] = useState(0);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [revision, setRevision] = useState(match.revision);
  const [retryRejected, setRetryRejected] = useState(false);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<'approved' | 'pending' | null>(null);
  const [error, setError] = useState('');
  const submit = async () => {
    setPending(true); setError('');
    try { const result = await trpc.eventOps.reportScore.mutate({ matchId: match.id, expectedRevision: revision, requestId, score1, score2, outcome: 'played' }); setSent(result.status === 'approved' ? 'approved' : 'pending'); setRetryRejected(false); await Promise.all([cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }), cache.invalidateQueries({ queryKey: ['eventOpsReports', planId] })]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not submit. Try again.'); }
    finally { setPending(false); }
  };
  return <article className="card ops-match"><div className="ops-match-meta"><span>{match.label}</span><span>{station ?? 'Station pending'}</span></div><h3>{match.player1Name} vs {match.player2Name}</h3>
    {match.status === 'complete' ? <p>Confirmed: {match.score1} – {match.score2}</p> : reportStatus === 'rejected' && !retryRejected ? <div><p>Your previous report was rejected. Check the result with a TO before trying again.</p><button className="btn" onClick={() => { setRequestId(crypto.randomUUID()); setRevision(match.revision); setRetryRejected(true); }}>Start a new report</button></div> : reportStatus === 'pending' || (sent && !reportStatus) ? <p role="status">{sent === 'approved' ? 'Result confirmed.' : 'Score submitted for TO approval. An organiser can correct or reject it if needed.'}</p> : selfRun && match.status !== 'playing' ? <p className="pool-flow-selected-note">Start this match from its station’s Play next card first. Once it is playing, you can report the result here.</p> : <form className="ops-score-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {reportStatus === 'rejected' && <p className="muted">Your previous report was rejected. Check the score with a TO before submitting again.</p>}
      {match.revision !== revision && <div role="alert"><p>Match details changed while you were entering the score. Reload the match before submitting.</p><button type="button" className="btn" onClick={() => { setRevision(match.revision); setScore1(0); setScore2(0); setRequestId(crypto.randomUUID()); }}>Reload match</button></div>}
      <div className="ops-score-inputs"><label>{match.player1Name}<input className="input" type="number" min={0} max={5} value={score1} onChange={e => { setScore1(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label><label>{match.player2Name}<input className="input" type="number" min={0} max={5} value={score2} onChange={e => { setScore2(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label></div><button className="btn" disabled={!enabled || pending || revision !== match.revision || score1 === score2 || !match.player1Id || !match.player2Id}>{selfRun && autoAccept ? 'Confirm result' : 'Submit score for approval'}</button><p className="muted">{selfRun && autoAccept ? 'This pool confirms submitted results immediately. Check the players and final score together.' : 'A TO checks this score before it becomes a confirmed result.'}</p>
      {error && <p className="error-text" role="alert">{error}</p>}
    </form>}
  </article>;
}
