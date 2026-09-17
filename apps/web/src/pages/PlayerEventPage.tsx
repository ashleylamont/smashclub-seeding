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
  if (isPending || event.isPending) return <p>Loading your event…</p>;
  if (!session) return <section className="card"><h1>Report your match</h1><p>Sign in with the account linked to your player profile.</p><a href="/login">Sign in</a></section>;
  if (!event.data) return <p role="alert">{event.error?.message ?? 'Event unavailable'}</p>;
  const claim = claims.data?.find(claim => claim.status === 'approved');
  const ownMatches = event.data.matches.filter(match => claim && [match.player1Id, match.player2Id].includes(claim.playerId));
  const closed = ['complete', 'cancelled'].includes(event.data.plan.status);
  return <div className="ops-page"><header><span className="ops-eyebrow">YOUR MATCHES</span><h1>{event.data.plan.name}</h1><a href={`/live/${planId}`}>View the event</a></header>
    {event.isError && <p role="alert">Live updates interrupted. Scores shown may be out of date.</p>}
    {claims.isPending ? <p>Checking player profile…</p> : claims.isError ? <p role="alert">{claims.error.message}</p> : !claim ? <section className="card"><p>You need an approved player profile to report scores.</p><a href="/me">Link your player profile</a></section> : <>
      <p>Playing as <strong>{claim.playerName}</strong>. Submitted scores need an organiser’s approval before appearing in results.</p>
      {!event.data.settings.playerReports && <p className="banner banner-warning">Player reporting is off for this event. Please ask a TO to record your score.</p>}
      <div className="ops-match-grid">{ownMatches.map(match => <PlayerScoreCard key={match.id} match={match} planId={planId} reportStatus={reports.data?.find(report => report.matchId === match.id)?.status} enabled={event.data.settings.playerReports && !closed} station={event.data.stations.find(station => station.id === match.stationId)?.name} />)}</div>
      {!ownMatches.length && <p className="card">Your matches have not been prepared yet. Check back shortly.</p>}
    </>}
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
      <div className="ops-score-inputs"><label>{match.player1Name}<input className="input" type="number" min={0} max={99} value={score1} onChange={e => { setScore1(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label><label>{match.player2Name}<input className="input" type="number" min={0} max={99} value={score2} onChange={e => { setScore2(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label></div><button className="btn" disabled={!enabled || pending || revision !== match.revision || score1 === score2 || !match.player1Id || !match.player2Id}>Submit score for approval</button>
      {error && <p className="error-text" role="alert">{error}</p>}
    </form>}
  </article>;
}
