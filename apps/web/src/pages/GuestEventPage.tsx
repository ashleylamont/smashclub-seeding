import { TRPCClientError } from '@trpc/client';
import { CompletedScoreReport, type ResultSubmission } from '../components/CompletedScoreReport';
import { PlayerMatchFilter } from '../components/PlayerMatchFilter';
import { eventPlayers, useDevicePlayer } from '../lib/playerSelection';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { trpc } from '../lib/trpc';
import { guestTimeLeft, useGuestClock, readGuestSession, saveGuestSession, type GuestSession } from '../lib/guestReporting';
import './admin/EventOperations.css';
import { PoolFilter, PoolRoundSchedule, PoolStationQueue } from '../components/PoolStationQueue';
import { matchesPool, poolPath, poolPolicy, queueScoringIds, usePoolFilter, type PoolFlowData, type StartPoolMatch } from '../lib/poolFlow';

type GuestData = Awaited<ReturnType<typeof trpc.eventOps.guests.matches.mutate>>;
type Match = GuestData['matches'][number];
export function GuestEventPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  return <GuestEvent key={planId} planId={planId} />;
}
export function GuestEvent({ planId }: { planId: string }) {
  const [invitation, setInvitation] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token'));
  const [invitationGeneration, setInvitationGeneration] = useState(0);
  const [session, setSession] = useState<GuestSession | null>(() => readGuestSession(planId));
  const [redeeming, setRedeeming] = useState(!!invitation);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedPlayer, setSelectedPlayer] = useDevicePlayer(planId);
  const [view, setView] = useState(selectedPlayer ? 'mine' : 'queue');
  const [selectedPool, setSelectedPool] = usePoolFilter();
  const [selectedMatch, setSelectedMatch] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const cache = useQueryClient();
  const [cacheId] = useState(() => crypto.randomUUID());
  const redemption = useRef<{ token: string; generation: number; promise: Promise<GuestSession> } | null>(null);
  const now = useGuestClock();
  const valid = !!session && Date.parse(session.expiresAt) > now;
  useEffect(() => {
    const acceptInvitation = () => {
      const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
      if (token) { setInvitation(token); setInvitationGeneration(value => value + 1); setRedeeming(true); setError(''); }
    };
    window.addEventListener('hashchange', acceptInvitation);
    return () => window.removeEventListener('hashchange', acceptInvitation);
  }, []);
  useEffect(() => {
    if (!invitation) return;
    // Strip the invitation before navigation, analytics or a user copying the address.
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    if (redemption.current?.token !== invitation || redemption.current.generation !== invitationGeneration) redemption.current = { token: invitation, generation: invitationGeneration, promise: trpc.eventOps.guests.redeem.mutate({ planId, token: invitation }) };
    let active = true;
    void redemption.current.promise.then(value => {
      if (!active) return;
      setSession(value);
      saveGuestSession(planId, value);
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Invitation could not be redeemed. Scan a fresh QR.'); }).finally(() => { if (active) setRedeeming(false); });
    return () => { active = false; };
  }, [invitation, invitationGeneration, planId]);
  const matches = useQuery({ queryKey: ['guestMatches', planId, cacheId, session?.expiresAt], queryFn: () => trpc.eventOps.guests.matches.mutate({ planId, sessionToken: session!.sessionToken }), enabled: valid && !redeeming, refetchInterval: 2500, retry: false });
  const publicEvent = useQuery({ queryKey: ['eventOpsPublic', planId], queryFn: () => trpc.eventOps.snapshot.query({ planId }), refetchInterval: 2500, retry: false });
  const unpublished = publicEvent.error instanceof TRPCClientError && ['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED'].includes(publicEvent.error.data?.code ?? '');
  const canWrite = valid && !redeeming && !!matches.data && !matches.isError && !publicEvent.isError;
  const data: PoolFlowData | undefined = unpublished ? undefined : publicEvent.data ?? matches.data;
  const disputeMode = (publicEvent.data ?? matches.data)?.settings.scoreReportingMode === 'approve_unless_disputed' && (publicEvent.data ?? matches.data)?.plan.bracketMode === 'native';
  const closed = !!data && ['complete', 'cancelled'].includes(data.plan.status);
  const players = eventPlayers(data?.matches ?? []);
  const player = players.some(item => item.id === selectedPlayer) ? selectedPlayer : '';
  const reportedIds = new Set(matches.data?.reports.map(report => report.matchId));
  const queuedIds = data ? queueScoringIds(data) : new Set<string>();
  const visible = data?.matches.filter(match => matchesPool(match, selectedPool) && (view === 'results' ? match.status === 'complete' : view === 'mine' ? player && [match.player1Id, match.player2Id].includes(player) : view === 'reports' ? reportedIds.has(match.id) : view === 'matches' || search ? (match.status === 'ready' || match.status === 'playing' || disputeMode && match.status === 'complete' || reportedIds.has(match.id)) && match.player1Id && match.player2Id : queuedIds.has(match.id) || reportedIds.has(match.id) || selectedMatch === match.id) && `${match.player1Name} ${match.player2Name} ${match.label} ${match.division} ${match.poolIndex === null ? '' : `Pool ${String.fromCharCode(65 + match.poolIndex)}`}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const start = async (input: StartPoolMatch) => {
    if (!session || !canWrite) return;
    setStarting(input.matchId); setError('');
    try { await trpc.eventOps.guests.startPoolMatch.mutate({ planId, sessionToken: session.sessionToken, ...input }); setSelectedMatch(input.matchId); await Promise.all([cache.invalidateQueries({ queryKey: ['guestMatches', planId] }), cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] })]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The station queue changed. Refresh before starting.'); }
    finally { setStarting(null); }
  };
  const chooseMatch = (id: string) => { setSelectedMatch(id); setView('queue'); setSearch(''); document.getElementById('guest-score-entry')?.scrollIntoView({ behavior: 'smooth' }); };
  if (unpublished) return <p role="alert">This event is unavailable or has not been published.</p>;
  return <div className="ops-page guest-page"><header><span className="ops-eyebrow">PLAYER AREA / SMASH CLUB</span><h1>{publicEvent.data?.plan.name ?? 'Your event'}</h1><p>Find your pool’s stations, see who plays next and report results. No account or linked player profile is needed.</p><a href={poolPath(`/live/${planId}`, selectedPool)}>Live event board →</a><p className="muted">Pool standings, brackets, announcements and prizes are on the live event board.</p></header>
    {closed && <p className="card">This event is closed. Results remain available; ask a TO about corrections.</p>}
    {!closed && (redeeming ? <p role="status">Opening your guest pass…</p> : !valid || matches.isError ? <section className="card"><h2>{session && !valid ? 'Your guest pass has expired' : matches.isError ? 'Refresh your guest pass' : 'Scan in to report a score'}</h2><p>Scan the current event QR on the venue screen or ask a TO for a fresh invitation to start matches and report scores. You can keep browsing without a pass.</p>{matches.isError && <p className="banner banner-warning" role="alert">{matches.error.message} If this pass was revoked, scan the current event QR again.</p>}</section> : <p className="guest-pass-expiry">Guest pass · {guestTimeLeft(session!.expiresAt, now)} remaining</p>)}
    {publicEvent.isError && !unpublished && <p role="alert">Live updates interrupted. Scores shown may be out of date.</p>}
    {!data && publicEvent.isPending && <p>Loading matches…</p>}
    {data && <>
      <PlayerMatchFilter players={players} value={player} onChange={id => { setSelectedPlayer(id); setView(id ? 'mine' : 'matches'); setSelectedPool(''); }} />
      <PoolFilter data={data} value={selectedPool} onChange={value => { setSelectedPool(value); setSelectedMatch(null); }} />
      <PoolStationQueue data={data} selectedPool={selectedPool} onStart={input => void start(input)} onReport={chooseMatch} pendingMatchId={starting} disabled={!canWrite} />
      <PoolRoundSchedule data={data} selectedPool={selectedPool} />
      <section className="pool-score-selection" id="guest-score-entry"><h2>Matches & results</h2>
      <div className="ops-toolbar"><label>View<select aria-label="Match view" className="select" value={view} onChange={e => setView(e.target.value)}><option value="queue">Station matches & my reports</option><option value="matches">{disputeMode ? 'All matches & results' : 'All open matches'}</option><option value="results">Recorded results</option><option value="mine" disabled={!player}>My matches{!player ? ' (choose a player above)' : ''}</option><option value="reports">My reports</option></select></label><label className="ops-search">Find a player or pool<input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Player name, Upper, Pool A…" /></label></div>
      <div className="ops-match-grid">{visible.map(match => <GuestScoreCard key={`${match.id}:${poolPolicy(data, match)?.selfRun && match.status === 'playing' ? 'playing' : 'regular'}`} planId={planId} session={canWrite && !closed ? session : null} disputeMode={disputeMode && !closed} match={match as Match} report={matches.data?.reports.find(report => report.matchId === match.id)} selfRun={!!poolPolicy(data, match)?.selfRun} autoAccept={!!poolPolicy(data, match)?.autoAcceptScores} />)}</div>
      {!visible.length && <p className="card">{view === 'reports' ? 'Your submitted scores will appear here.' : 'No matches in this view yet. Choose a pool, search a player, or select All open matches.'}</p>}</section>
    </>}
    {error && !matches.isError && <p className="error-text" role="alert">{error}</p>}
  </div>;
}

function GuestScoreCard({ planId, session, match, report, selfRun, autoAccept, disputeMode }: { planId: string; session: GuestSession | null; match: Match; report?: GuestData['reports'][number]; selfRun: boolean; autoAccept: boolean; disputeMode: boolean }) {
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
  const reportResult = async (input: ResultSubmission) => {
    if (!session) throw new Error('Scan the current event QR to report a score.');
    const result = await trpc.eventOps.guests.submit.mutate({ planId, sessionToken: session.sessionToken, matchId: match.id, ...input });
    await Promise.all([cache.invalidateQueries({ queryKey: ['guestMatches', planId] }), cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] })]);
    return result;
  };
  const submit = async () => {
    if (!session) return;
    setPending(true); setError('');
    try { const result = await trpc.eventOps.guests.submit.mutate({ planId, sessionToken: session.sessionToken, matchId: match.id, expectedRevision: revision, requestId, score1, score2 }); setSent(result.status === 'approved' ? 'approved' : 'pending'); setRetryRejected(false); await Promise.all([cache.invalidateQueries({ queryKey: ['guestMatches', planId] }), cache.invalidateQueries({ queryKey: ['eventOpsPublic', planId] })]); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send the score. Try again.'); }
    finally { setPending(false); }
  };
  return <article className="card ops-match"><div className="ops-match-meta"><span>{match.division} · {match.label}</span><span>{match.status}</span></div><h3>{match.player1Name} vs {match.player2Name}</h3>
    {report && <p className="guest-report-status" role="status">Your report: {report.score1} – {report.score2} · {report.status === 'approved' ? 'Confirmed result' : report.status === 'rejected' ? 'Rejected by a TO' : report.isDispute ? 'Different score awaiting TO review' : 'Awaiting TO approval'}</p>}
    {match.status === 'complete' ? <CompletedScoreReport match={match} enabled={!!session} allowReports={disputeMode && match.outcome === 'played'} onSubmit={reportResult} pendingReport={report?.status === 'pending' ? report : undefined} /> : !session ? <p>Scan the current event QR to start matches and report scores.</p> : report?.status === 'pending' || (sent && !report) ? <p>{sent === 'approved' ? 'Result confirmed.' : 'Thanks! A TO will review your score.'}</p> : report?.status === 'approved' ? <p>Your report has been approved. Ask a TO if this match needs a correction.</p> : report?.status === 'rejected' && !retryRejected ? <><p>Check the score with a TO before submitting again.</p><button className="btn" onClick={() => { reset(); setRetryRejected(true); }}>Start a new report</button></> : selfRun && match.status !== 'playing' ? <p className="pool-flow-selected-note">Start this match from its station’s Play next card first. Once it is playing, report the result here.</p> : <form className="ops-score-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      {stale && <div role="alert"><p>Match details changed. Reload the match and check the players before submitting.</p><button className="btn" type="button" onClick={reset}>Reload match</button></div>}
      <div className="ops-score-inputs"><label>{match.player1Name}<input className="input" type="number" min={0} max={5} value={score1} required onChange={e => { setScore1(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label><label>{match.player2Name}<input className="input" type="number" min={0} max={5} value={score2} required onChange={e => { setScore2(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} /></label></div>
      <button className="btn btn-primary" disabled={pending || stale || score1 === score2 || !['ready', 'playing'].includes(match.status)}>{disputeMode || selfRun && autoAccept ? 'Confirm result' : 'Submit score for TO approval'}</button><p className="muted">{disputeMode ? 'Results advance immediately. Later disagreements go to TO review.' : selfRun && autoAccept ? 'This pool confirms submitted results immediately. Check the players and final score together.' : 'A TO checks this score before it becomes a confirmed result.'} For forfeits, byes or corrections, ask a TO.</p>
    </form>}{error && <p className="error-text" role="alert">{error}</p>}
  </article>;
}
