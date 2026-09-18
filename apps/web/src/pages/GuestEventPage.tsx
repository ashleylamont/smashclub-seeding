import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import { guestTimeLeft, useGuestClock } from '../lib/guestReporting';
import './admin/EventOperations.css';
import { PoolFilter, PoolRoundSchedule, PoolStationQueue } from '../components/PoolStationQueue';
import { matchesPool, poolPath, poolPolicy, queueScoringIds, usePoolFilter, type PoolFlowData, type StartPoolMatch } from '../lib/poolFlow';

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
  const [view, setView] = useState('queue');
  const [selectedPool, setSelectedPool] = usePoolFilter();
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const cache = useQueryClient();
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
  const guestData: (GuestData & Partial<Omit<PoolFlowData, 'matches'>>) | undefined = matches.data;
  const data: PoolFlowData | undefined = guestData ? { matches: guestData.matches, plan: guestData.plan ?? { id: planId, status: 'underway' }, stations: guestData.stations ?? [], poolSchedules: guestData.poolSchedules ?? [], stationQueues: guestData.stationQueues, poolRounds: guestData.poolRounds } : undefined;
  const reportedIds = new Set(matches.data?.reports.map(report => report.matchId));
  const queuedIds = data ? queueScoringIds(data) : new Set<string>();
  const visible = matches.data?.matches.filter(match => matchesPool(match, selectedPool) && (view === 'reports' ? reportedIds.has(match.id) : view === 'matches' || search ? (match.status === 'ready' || match.status === 'playing' || reportedIds.has(match.id)) && match.player1Id && match.player2Id : queuedIds.has(match.id) || reportedIds.has(match.id) || selectedMatch === match.id) && `${match.player1Name} ${match.player2Name} ${match.label} ${match.division} ${match.poolIndex === null ? '' : `Pool ${String.fromCharCode(65 + match.poolIndex)}`}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const start = async (input: StartPoolMatch) => {
    if (!session || !valid) return;
    setStarting(input.matchId); setError('');
    try { await trpc.eventOps.guests.startPoolMatch.mutate({ planId, sessionToken: session.sessionToken, ...input }); setSelectedMatch(input.matchId); await cache.invalidateQueries({ queryKey: ['guestMatches', planId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The station queue changed. Refresh before starting.'); }
    finally { setStarting(null); }
  };
  const chooseMatch = (id: string) => { setSelectedMatch(id); setView('queue'); setSearch(''); document.getElementById('guest-score-entry')?.scrollIntoView({ behavior: 'smooth' }); };
  return <div className="ops-page guest-page"><header><span className="ops-eyebrow">GUEST PASS / SMASH CLUB</span><h1>Good games. Get them counted.</h1><p>Find your pool’s station, start the next match when both players are there, then report the result. Each pool shows whether results need TO approval.</p><a href={poolPath(`/live/${planId}`, selectedPool)}>Live event board →</a></header>
    {redeeming ? <p role="status">Opening your guest pass…</p> : !valid ? <section className="card"><h2>{session ? 'Your guest pass has expired' : 'Scan in to report a score'}</h2><p>Scan the current event QR or ask a TO for a fresh invitation. No account or player profile is needed.</p></section> : <>
      <p className="guest-pass-expiry">Guest pass · {guestTimeLeft(session!.expiresAt, now)} remaining</p>
      {data && !matches.isError && <><PoolFilter data={data} value={selectedPool} onChange={value => { setSelectedPool(value); setSelectedMatch(null); }} /><PoolStationQueue data={data} selectedPool={selectedPool} onStart={input => void start(input)} onReport={chooseMatch} pendingMatchId={starting} /><PoolRoundSchedule data={data} selectedPool={selectedPool} /></>}
      <section className="pool-score-selection" id="guest-score-entry"><h2>Report a result</h2>
      <div className="ops-toolbar"><label>View<select aria-label="Match view" className="select" value={view} onChange={e => setView(e.target.value)}><option value="queue">Station matches & my reports</option><option value="matches">All open matches</option><option value="reports">My reports</option></select></label><label className="ops-search">Find a player or pool<input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Player name, Upper, Pool A…" /></label></div>
      {matches.isPending && <p>Loading matches…</p>}
      {matches.isError ? <p className="banner banner-warning" role="alert">{matches.error.message} If this pass was revoked, scan the current event QR again.</p> : <div className="ops-match-grid">{visible.map(match => <GuestScoreCard key={`${match.id}:${data && poolPolicy(data, match)?.selfRun && match.status === 'playing' ? 'playing' : 'regular'}`} planId={planId} session={session!} match={match} report={matches.data?.reports.find(report => report.matchId === match.id)} selfRun={!!data && !!poolPolicy(data, match)?.selfRun} autoAccept={!!data && !!poolPolicy(data, match)?.autoAcceptScores} />)}</div>}
      {matches.data && !matches.isError && !visible.length && <p className="card">{view === 'reports' ? 'Your submitted scores will appear here.' : 'No matches in this view yet. Choose a pool, search a player, or select All open matches. For byes or corrections, ask a TO.'}</p>}</section>
    </>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>;
}
function GuestScoreCard({ planId, session, match, report, selfRun, autoAccept }: { planId: string; session: GuestSession; match: Match; report?: GuestData['reports'][number]; selfRun: boolean; autoAccept: boolean }) {
  const cache = useQueryClient();
  const [score1, setScore1] = useState(0);
  const [score2, setScore2] = useState(0);
  const [revision, setRevision] = useState(match.revision);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<'approved' | 'pending' | null>(null);
  const [retryRejected, setRetryRejected] = useState(false);
  const [error, setError] = useState('');
  const stale = revision !== match.revision;
  const reset = () => { setRevision(match.revision); setScore1(0); setScore2(0); setRequestId(crypto.randomUUID()); setError(''); setSent(null); };
  const submit = async () => {
    setPending(true); setError('');
    try { const result = await trpc.eventOps.guests.submit.mutate({ planId, sessionToken: session.sessionToken, matchId: match.id, expectedRevision: revision, requestId, score1, score2 }); setSent(result.status === 'approved' ? 'approved' : 'pending'); setRetryRejected(false); await cache.invalidateQueries({ queryKey: ['guestMatches', planId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send the score. Try again.'); }
    finally { setPending(false); }
  };
  return <article className="card ops-match"><div className="ops-match-meta"><span>{match.division} · {match.label}</span><span>{match.status}</span></div><h3>{match.player1Name} vs {match.player2Name}</h3>
    {report && <p className="guest-report-status" role="status">Your report: {report.score1} – {report.score2} · {report.status === 'approved' ? 'Confirmed result' : report.status === 'rejected' ? 'Rejected by a TO' : 'Awaiting TO approval'}</p>}
    {match.status === 'complete' ? <p>Confirmed result: {match.score1} – {match.score2}</p> : report?.status === 'pending' || (sent && !report) ? <p>{sent === 'approved' ? 'Result confirmed.' : 'Thanks! A TO will review your score.'}</p> : report?.status === 'approved' ? <p>Your report has been approved. Ask a TO if this match needs a correction.</p> : report?.status === 'rejected' && !retryRejected ? <><p>Check the score with a TO before submitting again.</p><button className="btn" onClick={() => { reset(); setRetryRejected(true); }}>Start a new report</button></> : selfRun && match.status !== 'playing' ? <p className="pool-flow-selected-note">Start this match from its station’s Play next card first. Once it is playing, report the result here.</p> : <form className="ops-score-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {stale && <div role="alert"><p>Match details changed. Reload the match and check the players before submitting.</p><button className="btn" type="button" onClick={reset}>Reload match</button></div>}
      <div className="ops-score-inputs"><label>{match.player1Name}<input className="input" type="number" min={0} max={5} value={score1} required onChange={e => { setScore1(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label><label>{match.player2Name}<input className="input" type="number" min={0} max={5} value={score2} required onChange={e => { setScore2(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label></div>
      <button className="btn btn-primary" disabled={pending || stale || score1 === score2 || !['ready', 'playing'].includes(match.status)}>{selfRun && autoAccept ? 'Confirm result' : 'Submit score for TO approval'}</button><p className="muted">{selfRun && autoAccept ? 'This pool confirms submitted results immediately. Check the players and final score together.' : 'A TO checks this score before it becomes a confirmed result.'} For forfeits, byes or corrections, ask a TO.</p>
    </form>}{error && <p className="error-text" role="alert">{error}</p>}
  </article>;
}
