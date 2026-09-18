import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import { guestTimeLeft, useGuestClock } from '../lib/guestReporting';
import './admin/EventOperations.css';

type GuestSession = { sessionToken: string; expiresAt: string };
type GuestData = Awaited<ReturnType<typeof trpc.eventOps.guests.matches.mutate>>;
type Match = GuestData['matches'][number];
const storageKey = (planId: string) => `nemesis:guest:${planId}`;
function readSession(planId: string): GuestSession | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(planId)) ?? 'null');
    if (value && typeof value === 'object' && 'sessionToken' in value && typeof value.sessionToken === 'string' && 'expiresAt' in value && typeof value.expiresAt === 'string' && Date.parse(value.expiresAt) > Date.now()) return { sessionToken: value.sessionToken, expiresAt: value.expiresAt };
  } catch { /* Browsers may disallow session storage; a pass still works in this tab. */ }
  return null;
}
export function GuestEventPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  return <GuestEvent key={planId} planId={planId} />;
}
function GuestEvent({ planId }: { planId: string }) {
  const [invitation] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token'));
  const [session, setSession] = useState<GuestSession | null>(() => readSession(planId));
  const [redeeming, setRedeeming] = useState(!!invitation);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState('matches');
  const [cacheId] = useState(() => crypto.randomUUID());
  const redemption = useRef<Promise<GuestSession> | null>(null);
  const now = useGuestClock();
  const valid = !!session && Date.parse(session.expiresAt) > now;
  useEffect(() => {
    if (!invitation) return;
    // Strip the invitation before navigation, analytics or a user copying the address.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    redemption.current ??= trpc.eventOps.guests.redeem.mutate({ planId, token: invitation });
    let active = true;
    void redemption.current.then(value => {
      if (!active) return;
      setSession(value);
      try { sessionStorage.setItem(storageKey(planId), JSON.stringify(value)); } catch { /* Session stays in memory. */ }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Invitation could not be redeemed. Scan a fresh QR.'); }).finally(() => { if (active) setRedeeming(false); });
    return () => { active = false; };
  }, [invitation, planId]);
  const matches = useQuery({ queryKey: ['guestMatches', planId, cacheId, session?.expiresAt], queryFn: () => trpc.eventOps.guests.matches.mutate({ planId, sessionToken: session!.sessionToken }), enabled: valid && !redeeming, refetchInterval: 2500, retry: false });
  const pendingMatchIds = new Set(matches.data?.reports.map(report => report.matchId));
  const visible = matches.data?.matches.filter(match => (view === 'reports' ? pendingMatchIds.has(match.id) : (match.status === 'ready' || match.status === 'playing') && match.player1Id && match.player2Id) && `${match.player1Name} ${match.player2Name} ${match.label} ${match.division} ${match.poolIndex === null ? '' : `Pool ${String.fromCharCode(65 + match.poolIndex)}`}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="ops-page guest-page"><header><span className="ops-eyebrow">GUEST PASS / SMASH CLUB</span><h1>Good games. Get them counted.</h1><p>Report the set you just played or watched. A TO checks every score before it appears in the results.</p><a href={`/live/${planId}`}>Live event board →</a></header>
    {redeeming ? <p role="status">Opening your guest pass…</p> : !valid ? <section className="card"><h2>{session ? 'Your guest pass has expired' : 'Scan in to report a score'}</h2><p>Scan the current event QR or ask a TO for a fresh invitation. No account or player profile is needed.</p></section> : <>
      <p className="guest-pass-expiry">Guest pass · {guestTimeLeft(session!.expiresAt, now)} remaining</p>
      <div className="ops-toolbar"><label>View<select aria-label="Match view" className="select" value={view} onChange={e => setView(e.target.value)}><option value="matches">Open matches</option><option value="reports">My reports</option></select></label><label className="ops-search">Find a player or pool<input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Player name, Upper, Pool A…" /></label></div>
      {matches.isPending && <p>Loading matches…</p>}
      {matches.isError ? <p className="banner banner-warning" role="alert">{matches.error.message} If this pass was revoked, scan the current event QR again.</p> : <div className="ops-match-grid">{visible.map(match => <GuestScoreCard key={match.id} planId={planId} session={session!} match={match} report={matches.data?.reports.find(report => report.matchId === match.id)} />)}</div>}
      {matches.data && !matches.isError && !visible.length && <p className="card">{view === 'reports' ? 'Your submitted scores will appear here.' : 'No open matches match your search. For byes, withdrawals or corrections, ask a TO.'}</p>}
    </>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>;
}
function GuestScoreCard({ planId, session, match, report }: { planId: string; session: GuestSession; match: Match; report?: GuestData['reports'][number] }) {
  const cache = useQueryClient();
  const [score1, setScore1] = useState(0);
  const [score2, setScore2] = useState(0);
  const [revision, setRevision] = useState(match.revision);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [retryRejected, setRetryRejected] = useState(false);
  const [error, setError] = useState('');
  const stale = revision !== match.revision;
  const reset = () => { setRevision(match.revision); setScore1(0); setScore2(0); setRequestId(crypto.randomUUID()); setError(''); setSent(false); };
  const submit = async () => {
    setPending(true); setError('');
    try { await trpc.eventOps.guests.submit.mutate({ planId, sessionToken: session.sessionToken, matchId: match.id, expectedRevision: revision, requestId, score1, score2 }); setSent(true); setRetryRejected(false); await cache.invalidateQueries({ queryKey: ['guestMatches', planId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send the score. Try again.'); }
    finally { setPending(false); }
  };
  return <article className="card ops-match"><div className="ops-match-meta"><span>{match.division} · {match.label}</span><span>{match.status}</span></div><h3>{match.player1Name} vs {match.player2Name}</h3>
    {report && <p className="guest-report-status" role="status">Your report: {report.score1} – {report.score2} · {report.status === 'approved' ? 'Approved by a TO' : report.status === 'rejected' ? 'Rejected by a TO' : 'Awaiting TO approval'}</p>}
    {match.status === 'complete' ? <p>Confirmed result: {match.score1} – {match.score2}</p> : report?.status === 'pending' || (sent && !report) ? <p>Thanks! A TO will review your score.</p> : report?.status === 'approved' ? <p>Your report has been approved. Ask a TO if this match needs a correction.</p> : report?.status === 'rejected' && !retryRejected ? <><p>Check the score with a TO before submitting again.</p><button className="btn" onClick={() => { reset(); setRetryRejected(true); }}>Start a new report</button></> : <form className="ops-score-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {stale && <div role="alert"><p>Match details changed. Reload the match and check the players before submitting.</p><button className="btn" type="button" onClick={reset}>Reload match</button></div>}
      <div className="ops-score-inputs"><label>{match.player1Name}<input className="input" type="number" min={0} max={5} value={score1} required onChange={e => { setScore1(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label><label>{match.player2Name}<input className="input" type="number" min={0} max={5} value={score2} required onChange={e => { setScore2(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label></div>
      <button className="btn btn-primary" disabled={pending || stale || score1 === score2 || !['ready', 'playing'].includes(match.status)}>Submit score for TO approval</button><p className="muted">For forfeits, byes or corrections, ask a TO.</p>
    </form>}{error && <p className="error-text" role="alert">{error}</p>}
  </article>;
}
