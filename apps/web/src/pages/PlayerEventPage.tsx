import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { authClient } from '../lib/auth';
import { trpc } from '../lib/trpc';
import './admin/EventOperations.css';

type Snapshot = Awaited<ReturnType<typeof trpc.eventOps.snapshot.query>>;
type Match = Snapshot['matches'][number];
export function PlayerEventPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  const { data: session, isPending } = authClient.useSession();
  const event = useQuery({ queryKey: ['eventOpsPublic', planId], queryFn: () => trpc.eventOps.snapshot.query({ planId }), refetchInterval: 2500 });
  const reports = useQuery({ queryKey: ['eventOpsReports', planId], queryFn: () => trpc.eventOps.myReports.query({ planId }), enabled: !!session, refetchInterval: 2500 });
  const claims = useQuery({ queryKey: ['me', 'claims'], queryFn: () => trpc.me.claims.query(), enabled: !!session });
  const [view, setView] = useState('all');
  const [search, setSearch] = useState('');
  if (isPending || event.isPending) return <p>Loading your event…</p>;
  if (!session) return <section className="card"><h1>Report a score</h1><p>Sign in to report any match, or scan the current event QR code to report as a guest. Linking a player profile is optional.</p><a href="/login">Sign in</a></section>;
  if (!event.data) return <p role="alert">{event.error?.message ?? 'Event unavailable'}</p>;
  const claim = claims.data?.find(claim => claim.status === 'approved');
  const reported = new Set(reports.data?.map(report => report.matchId));
  const visible = event.data.matches.filter(match => (view === 'mine' ? claim && [match.player1Id, match.player2Id].includes(claim.playerId) : view === 'reports' ? reported.has(match.id) : ['ready', 'playing'].includes(match.status) || reported.has(match.id)) &&
    `${match.player1Name} ${match.player2Name} ${match.label} ${match.division}`.toLowerCase().includes(search.toLowerCase()));
  const closed = ['complete', 'cancelled'].includes(event.data.plan.status);
  return <div className="ops-page"><header><span className="ops-eyebrow">REPORT A SCORE</span><h1>{event.data.plan.name}</h1><a href={`/live/${planId}`}>View the event</a></header>
    {event.isError && <p role="alert">Live updates interrupted. Scores shown may be out of date.</p>}
    <p>Report a match you played or watched. Every submitted score needs organiser approval. {claim && <>Your linked profile is <strong>{claim.playerName}</strong>.</>}</p>
    {!event.data.settings.playerReports && <p className="banner banner-warning">Signed-in reporting is off for this event. Ask a TO to record your score or scan the event QR for guest access.</p>}
    {closed && <p>This event is closed. Ask an organiser about corrections.</p>}
    <div className="ops-toolbar"><label>View<select className="select" aria-label="Match view" value={view} onChange={e => setView(e.target.value)}><option value="all">Open matches and my reports</option><option value="mine" disabled={!claim}>My matches{!claim ? ' (link a player profile)' : ''}</option><option value="reports">My reports</option></select></label><label className="ops-search">Find a player or pool<input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Player name, Upper, Pool A…" /></label></div>
    <div className="ops-match-grid">{visible.map(match => <PlayerScoreCard key={match.id} match={match} planId={planId} reportStatus={reports.data?.find(report => report.matchId === match.id)?.status} enabled={event.data.settings.playerReports && !closed && ['ready', 'playing'].includes(match.status)} station={event.data.stations.find(station => station.id === match.stationId)?.name} />)}</div>
    {!visible.length && <p className="card">No matches match this view. Try another player or pool.</p>}
  </div>;
}
function PlayerScoreCard({ match, planId, enabled, station, reportStatus }: { match: Match; planId: string; enabled: boolean; station?: string; reportStatus?: string }) {
  const cache = useQueryClient();
  const [score1, setScore1] = useState(0);
  const [score2, setScore2] = useState(0);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [revision, setRevision] = useState(match.revision);
  const [retryRejected, setRetryRejected] = useState(false);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setPending(true); setError('');
    try { await trpc.eventOps.reportScore.mutate({ matchId: match.id, expectedRevision: revision, requestId, score1, score2, outcome: 'played' }); setSent(true); setRetryRejected(false); await Promise.all([cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] }), cache.invalidateQueries({ queryKey: ['eventOpsReports', planId] })]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not submit. Try again.'); }
    finally { setPending(false); }
  };
  return <article className="card ops-match"><div className="ops-match-meta"><span>{match.label}</span><span>{station ?? 'Station pending'}</span></div><h3>{match.player1Name} vs {match.player2Name}</h3>
    {match.status === 'complete' ? <p>Confirmed: {match.score1} – {match.score2}</p> : reportStatus === 'rejected' && !retryRejected ? <div><p>Your previous report was rejected. Check the result with a TO before trying again.</p><button className="btn" onClick={() => { setRequestId(crypto.randomUUID()); setRevision(match.revision); setRetryRejected(true); }}>Start a new report</button></div> : reportStatus === 'pending' || (sent && !reportStatus) ? <p role="status">Score submitted for TO approval. An organiser can correct or reject it if needed.</p> : <form className="ops-score-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {reportStatus === 'rejected' && <p className="muted">Your previous report was rejected. Check the score with a TO before submitting again.</p>}
      {match.revision !== revision && <div role="alert"><p>Match details changed while you were entering the score. Reload the match before submitting.</p><button type="button" className="btn" onClick={() => { setRevision(match.revision); setScore1(0); setScore2(0); setRequestId(crypto.randomUUID()); }}>Reload match</button></div>}
      <div className="ops-score-inputs"><label>{match.player1Name}<input className="input" type="number" min={0} max={5} value={score1} onChange={e => { setScore1(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label><label>{match.player2Name}<input className="input" type="number" min={0} max={5} value={score2} onChange={e => { setScore2(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label></div><button className="btn" disabled={!enabled || pending || revision !== match.revision || score1 === score2 || !match.player1Id || !match.player2Id}>Submit score for approval</button>
      {error && <p className="error-text" role="alert">{error}</p>}
    </form>}
  </article>;
}
