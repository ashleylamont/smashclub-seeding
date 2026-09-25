import { ScorePolicyControls } from './ScorePolicyControls';
import { StationPoolControls } from './StationPoolControls';
import { NativeBracketControls } from './NativeBracketControls';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch, useParams } from '@tanstack/react-router';
import { trpc } from '../../lib/trpc';
import { authClient, sessionRole } from '../../lib/auth';
import './EventOperations.css';
import { ScoreHandoff } from './ScoreHandoff';
import { AttendanceControls } from './AttendanceControls';
import { GuestReportingControls } from './GuestReportingControls';
import { availableMatches, poolStandings } from '../../lib/eventQueue';
import { OpsAttentionDesk } from './OpsAttentionDesk';
import { jumpToOpsControl } from '../../lib/opsAttention';

type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Match = Overview['matches'][number];

export function AdminEventOperationsPage() {
  const search = useSearch({ strict: false }) as { plan?: string };
  const plans = useQuery({ queryKey: ['admin', 'eventPlanner', 'plans'], queryFn: () => trpc.admin.eventPlanner.plans.query() });
  if (search.plan) return <EventOperationsPanel planId={search.plan} />;
  return <section className="card"><h2>Run an event</h2><p>Select a saved plan to open the shared control desk.</p>
    {plans.isPending && <p>Loading events…</p>}{plans.isError && <p role="alert">{plans.error.message}</p>}
    <div className="ops-event-list">{plans.data?.map(plan => <a className="ops-event-link" href={`/admin/event-operations?plan=${plan.id}`} key={plan.id}><strong>{plan.name}</strong><span>{plan.status.replaceAll('_', ' ')} · {plan.entryCount} entrants</span></a>)}</div>
    {plans.data?.length === 0 && <a href="/admin/event-planner">Create your first event plan</a>}
  </section>;
}

export function AssignedEventOperationsPage() {
  const { planId } = useParams({ strict: false }) as { planId: string };
  return <EventOperationsPanel planId={planId} />;
}

export function EventOperationsPanel({ planId }: { planId: string }) {
  const cache = useQueryClient();
  const { data: session } = authClient.useSession();
  const admin = sessionRole(session) === 'admin';
  const event = useQuery({ queryKey: ['eventOps', planId], queryFn: () => trpc.eventOps.overview.query({ planId }), refetchInterval: 2500 });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState('active');
  const [division, setDivision] = useState('all');
  const [search, setSearch] = useState('');
  const [poolFilter, setPoolFilter] = useState('all');
  const [focusedMatchId, setFocusedMatchId] = useState<string | null>(null);
  const [announcementMinutes, setAnnouncementMinutes] = useState(5);
  const [announcement, setAnnouncement] = useState('');
  const [prizeTitle, setPrizeTitle] = useState('');
  const [prizePlayer, setPrizePlayer] = useState('');
  const [toUserId, setToUserId] = useState('');
  const act = async (work: () => Promise<unknown>, message = 'Saved') => {
    setPending(true); setError(''); setNotice('');
    try { await work(); setNotice(message); await cache.invalidateQueries({ queryKey: ['eventOps', planId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save. Please try again.'); }
    finally { setPending(false); }
  };
  if (event.isPending) return <p>Opening event control…</p>;
  if (!event.data) return <section className="card"><h2>Event control</h2><p role="alert">{event.error?.message ?? 'Event unavailable'}</p><a href="/login">Sign in</a></section>;
  const data = event.data;
  const closed = ['complete', 'cancelled'].includes(data.plan.status);
  const disputes = data.reports.filter(report => report.status === 'pending' && report.isDispute).length;
  const available = availableMatches(data.matches).filter(match => match.availability.canStart);
  const callable = new Set(available.map(match => match.id));
  const pools = poolStandings(data.matches);
  const matches = focusedMatchId ? data.matches.filter(match => match.id === focusedMatchId) : (filter === 'ready' ? available : data.matches).filter(match => (division === 'all' || match.division === division) &&
    (filter === 'all' || (filter === 'active' ? match.status !== 'complete' : filter === 'waiting' ? match.status === 'blocked' || (match.status === 'ready' && !callable.has(match.id)) : match.status === filter)) &&
    (poolFilter === 'all' || (match.stage === 'group' && `${match.division}:${match.poolIndex}` === poolFilter)) &&
    `${match.player1Name} ${match.player2Name} ${match.label}`.toLowerCase().includes(search.toLowerCase()));
  const entrants = new Map<string, string>();
  for (const match of data.matches) { if (match.player1Id) entrants.set(match.player1Id, match.player1Name); if (match.player2Id) entrants.set(match.player2Id, match.player2Name); }
  return <div className="ops-page">
    <header className="ops-heading"><div><span className="ops-eyebrow">EVENT CONTROL</span><h2>{data.plan.name}</h2><p className="muted">{closed ? 'Event closed · read only' : 'Shared desk · refreshes every 2.5 seconds'}</p></div>
      <nav className="ops-links">{data.plan.resultsSlug && <a href={`/events/${encodeURIComponent(data.plan.resultsSlug)}`}>Final results</a>}{admin && <a href={`/admin/event-planner?plan=${planId}`}>Planner</a>}<a href={`/live/${planId}`} target="_blank" rel="noreferrer">Public screen ↗</a><a href={`/overlay/${planId}`} target="_blank" rel="noreferrer">OBS overlay ↗</a><a href={`/play/${planId}`}>Player reporting</a></nav></header>
    <OpsAttentionDesk data={data} onMatch={id => { setFocusedMatchId(id); setDivision('all'); setPoolFilter('all'); setSearch(''); setFilter('all'); jumpToOpsControl('match-desk'); }} />
    {event.isError && <div className="banner banner-warning" role="alert">Live updates interrupted. Last loaded data is shown. {event.error.message}</div>}
    {error && <div className="banner banner-danger" role="alert">{error}</div>}{notice && <p className="ops-notice" role="status">{notice}</p>}
    {disputes > 0 && <p className="banner banner-warning" role="status"><strong>{disputes} conflicting {disputes === 1 ? 'score needs' : 'scores need'} TO review.</strong> Recorded results stay in place. <a href="#score-submissions">Review disagreements →</a></p>}
    <StationPoolControls data={data} disabled={pending || closed} act={act} onPool={key => { setFocusedMatchId(null); setSearch(''); setPoolFilter(key); setDivision('all'); setFilter('active'); document.getElementById('match-desk')?.scrollIntoView({ behavior: 'smooth' }); }} />
    <div className="ops-stats">{(['playing', 'ready', 'waiting', 'complete'] as const).map(status => <button key={status} className={`ops-stat ${filter === status ? 'selected' : ''}`} onClick={() => { setFocusedMatchId(null); setFilter(status); }}><strong>{status === 'ready' ? available.length : status === 'waiting' ? data.matches.filter(m => m.status === 'blocked' || (m.status === 'ready' && !callable.has(m.id))).length : data.matches.filter(m => m.status === status).length}</strong><span>{status === 'playing' ? 'Playing now' : status === 'ready' ? 'Ready to start' : status === 'waiting' ? 'Waiting' : 'Finished'}</span></button>)}</div>
    <section className="card ops-setup" id="match-desk" tabIndex={-1}><div><h3>Match desk</h3><p className="muted">Build or refresh the match list. Ready matches have available players and stations; waiting matches explain what needs to happen first.</p></div><button className="btn" disabled={pending || closed} onClick={() => void act(() => trpc.eventOps.prepare.mutate({ planId }), 'Match queue refreshed')}>Prepare / refresh matches</button></section>
    {focusedMatchId && <p className="ops-focus-match card">Showing the selected match.<button className="btn btn-small" onClick={() => setFocusedMatchId(null)}>Show all matches</button></p>}
    <div className="ops-toolbar" onChange={() => setFocusedMatchId(null)}><label>View<select className="select" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">Unfinished</option><option value="ready">Ready to start</option><option value="playing">Playing</option><option value="waiting">Waiting for players or stations</option><option value="complete">Completed</option><option value="all">All matches</option></select></label><label>Division<select className="select" value={division} onChange={e => setDivision(e.target.value)}><option value="all">Both divisions</option><option value="upper">Upper</option><option value="lower">Lower</option></select></label><label>Pool<select className="select" value={poolFilter} onChange={event => setPoolFilter(event.target.value)}><option value="all">All pools and brackets</option>{pools.map(pool => <option key={`${pool.division}:${pool.poolIndex}`} value={`${pool.division}:${pool.poolIndex}`}>{pool.division} Pool {String.fromCharCode(65 + pool.poolIndex)}</option>)}</select></label><label className="ops-search">Find a player or match<input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search the queue" /></label></div>
    <div className="ops-match-grid">{matches.map(match => <MatchCard key={match.id} match={match} stations={data.stations} disabled={pending || closed} canStart={callable.has(match.id)} native={data.plan.bracketMode === 'native'} act={act} />)}</div>
    {matches.length === 0 && <p className="card muted">{data.matches.length === 0 ? 'Generate pools in the planner, then prepare the match queue here.' : 'No matches in this view.'}</p>}
    {pools.length > 0 && <section className="card"><h3>Pool standings</h3><p className="muted">Ordered by wins, then game difference for review. Ties and final advancement must be confirmed in the planner.</p><div className="ops-bottom-grid">{pools.map(pool => <div key={`${pool.division}:${pool.poolIndex}`}><h4>{pool.division} · Pool {String.fromCharCode(65 + pool.poolIndex)} <span className="muted">{pool.complete}/{pool.total} sets</span></h4><table className="ops-standings"><thead><tr><th>Player</th><th>W–L</th><th>Games ±</th><th>To play</th></tr></thead><tbody>{pool.players.map(player => <tr key={player.id}><td>{player.name}</td><td>{player.wins}–{player.losses}</td><td>{player.differential > 0 ? '+' : ''}{player.differential}</td><td>{player.remaining}</td></tr>)}</tbody></table></div>)}</div>{admin ? <a href={`/admin/event-planner?plan=${planId}&step=pools`}>Review and confirm advancement →</a> : <p className="muted">Ask an event administrator to confirm advancement in the planner.</p>}</section>}
    <ScorePolicyControls data={data} admin={admin} disabled={pending || closed} act={act} />
    <PlayerReports data={data} disabled={pending || closed} act={act} />
    <GuestReportingControls planId={planId} closed={closed} published={data.settings.published} />
    {data.plan.bracketMode === 'native' ? <NativeBracketControls planId={planId} entrants={data.entrants} closed={closed} /> : <details className="ops-external-handoff"><summary>Challonge integration</summary><ScoreHandoff planId={planId} data={data} disabled={pending || closed} /></details>}
    <AttendanceControls planId={planId} data={data} disabled={pending || closed} />
    <div className="ops-bottom-grid">

      <section className="card"><h3>Announcements</h3><form onSubmit={e => { e.preventDefault(); void act(async () => { await trpc.eventOps.announce.mutate({ planId, message: announcement, durationSeconds: announcementMinutes * 60 }); setAnnouncement(''); }, 'Announcement published to the event feed'); }}><label>Message<textarea className="input" value={announcement} onChange={e => setAnnouncement(e.target.value)} maxLength={500} required placeholder="Upper finals on the stage in five minutes" /></label><label>Show for<select className="select" value={announcementMinutes} onChange={event => setAnnouncementMinutes(Number(event.target.value))}><option value={1}>1 minute</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option><option value={30}>30 minutes</option></select></label><button className="btn" disabled={pending || closed}>Post announcement</button></form>{data.announcements.slice(0, 3).map(item => <p key={item.id} className="ops-announcement">{item.message}{item.expiresAt && <small> · until {new Date(item.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>}</p>)}</section>
      <section className="card"><h3>Prizes</h3><p className="muted">Publish confirmed awards. You choose the recipient.</p><form onSubmit={e => { e.preventDefault(); void act(async () => { await trpc.eventOps.savePrize.mutate({ planId, title: prizeTitle, ...(prizePlayer ? { playerId: prizePlayer } : {}) }); setPrizeTitle(''); }); }}><label>Award<input className="input" value={prizeTitle} onChange={e => setPrizeTitle(e.target.value)} placeholder="Upper champion / Best comeback" maxLength={100} required /></label><label>Recipient<select className="select" value={prizePlayer} onChange={e => setPrizePlayer(e.target.value)}><option value="">To be announced</option>{[...entrants].map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label><button className="btn" disabled={pending || closed}>Save prize</button></form>{data.prizes.map(prize => <p key={prize.id}><strong>{prize.title}</strong> — {prize.playerName ?? 'To be announced'}</p>)}</section>
      {admin && <section className="card"><h3>Event access</h3><label className="ops-check"><input type="checkbox" checked={data.settings.published} disabled={pending || closed} onChange={e => void act(() => trpc.eventOps.settings.mutate({ planId, published: e.target.checked, playerReports: data.settings.playerReports }))} /> Publish live event page</label><label className="ops-check"><input type="checkbox" checked={data.settings.playerReports} disabled={pending || closed} onChange={e => void act(() => trpc.eventOps.settings.mutate({ planId, published: data.settings.published, playerReports: e.target.checked }))} /> Allow signed-in attendees to report any match</label><p className="muted">TOs use <a href={`/operate/${planId}`}>this event’s control link</a>. Grant access to an existing signed-in account.</p><form onSubmit={e => { e.preventDefault(); void act(async () => { await trpc.eventOps.assignTo.mutate({ planId, email: toUserId }); setToUserId(''); }); }}><label>TO email address<input type="email" className="input" value={toUserId} onChange={e => setToUserId(e.target.value)} required /></label><button className="btn" disabled={pending || closed}>Grant event access</button></form><ul>{data.tos.map(to => <li key={to.id}>{to.name} ({to.email}) <button className="btn btn-small" disabled={pending || closed} onClick={() => void act(() => trpc.eventOps.assignTo.mutate({ planId, userId: to.userId, remove: true }))}>Remove access</button></li>)}</ul></section>}
    </div>
    {admin && !closed && <details className="card"><summary>Before play: rebuild the roster</summary><p className="muted">Clear an unplayed queue before reopening the planner. This is unavailable once a match starts, a score is reported, someone withdraws, or a bracket is attached.</p><button className="btn" disabled={pending || data.matches.some(match => match.status === 'playing' || match.status === 'complete') || data.reports.length > 0 || data.withdrawals.length > 0 || data.brackets.some(bracket => bracket.slug)} onClick={() => { if (window.confirm('Clear this unplayed match queue? You can then reopen the roster in the planner.')) void act(() => trpc.eventOps.resetOperations.mutate({ planId }), 'Unplayed queue cleared. Reopen the roster in the planner to reshuffle.'); }}>Reset unplayed queue</button></details>}
    <details className="card"><summary>Recent changes</summary><AuditList data={data} /></details>
  </div>;
}

type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;
function MatchCard({ match, stations, disabled, canStart, native, act }: { match: Match; stations: Overview['stations']; disabled: boolean; canStart: boolean; native: boolean; act: Action }) {
  const [editing, setEditing] = useState<'live' | 'final' | null>(null);
  const [revision, setRevision] = useState(match.revision);
  const [score1, setScore1] = useState(match.score1 ?? 0);
  const [score2, setScore2] = useState(match.score2 ?? 0);
  const [outcome, setOutcome] = useState<'played' | 'forfeit' | 'bye'>('played');
  const [winnerId, setWinnerId] = useState(match.winnerId ?? match.player1Id ?? '');
  const [requestId, setRequestId] = useState('');
  const stale = editing !== null && revision !== match.revision;
  const begin = (mode: 'live' | 'final') => { setEditing(mode); setRevision(match.revision); setScore1(match.score1 ?? 0); setScore2(match.score2 ?? 0); setOutcome(match.outcome ?? 'played'); setWinnerId(match.winnerId ?? match.player1Id ?? ''); setRequestId(crypto.randomUUID()); };
  const eligible = stations.filter(station => (station.status === 'free' || station.currentMatchId === match.id) && (match.availability.eligibleStationIds.includes(station.id) || station.currentMatchId === match.id));
  const label = match.status === 'complete' ? 'Finished' : match.status === 'playing' ? 'Playing now' : canStart ? 'Ready to start' : 'Waiting';
  return <article className={`card ops-match ops-match-${match.status}`}><div className="ops-match-meta"><span>{match.label}</span><span className="chip">{label}</span></div><div className="ops-contestant"><strong>{match.player1Name || 'Awaiting qualifier'}</strong><b>{match.score1 ?? '–'}</b></div><div className="ops-contestant"><strong>{match.player2Name || 'Awaiting qualifier'}</strong><b>{match.score2 ?? '–'}</b></div>
    {match.status === 'playing' && <p className="ops-delivery">Live game score · match still in progress</p>}
    {!native && <p className="ops-delivery">{match.syncState === 'synced' ? 'Confirmed in linked bracket' : 'Saved in Nemesis · external bracket not yet reconciled'}</p>}
    {match.status !== 'playing' && match.status !== 'complete' && match.availability.reasons.length > 0 && <ul className="ops-wait-reasons">{match.availability.reasons.map(reason => <li key={`${reason.code}:${reason.message}`}>{reason.message}</li>)}</ul>}
    <label className="ops-station">Station<select className="select" aria-label={`Station for ${match.label}`} value={match.stationId ?? ''} disabled={disabled || match.status === 'complete'} onChange={event => void act(() => trpc.eventOps.updateMatch.mutate({ matchId: match.id, expectedRevision: match.revision, status: match.status === 'playing' ? 'playing' : match.status === 'blocked' ? 'blocked' : 'ready', stationId: event.target.value || null, ...(match.blockedReason ? { blockedReason: match.blockedReason } : {}) }))}><option value="">Choose a free station</option>{match.stationId && !eligible.some(station => station.id === match.stationId) && <option value={match.stationId} disabled>{stations.find(station => station.id === match.stationId)?.name ?? 'Station'} — unavailable</option>}{eligible.map(station => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
    <div className="ops-match-actions">{match.status !== 'complete' && <button className="btn btn-small" disabled={disabled || (match.status !== 'playing' && !canStart)} title={!canStart && match.status !== 'playing' ? match.availability.reasons.map(reason => reason.message).join(' ') : undefined} onClick={() => void act(() => trpc.eventOps.updateMatch.mutate({ matchId: match.id, expectedRevision: match.revision, status: match.status === 'playing' ? 'ready' : 'playing', stationId: match.stationId }))}>{match.status === 'playing' ? 'Return to queue' : 'Start match'}</button>}
      {!native && match.status === 'blocked' && match.player1Id && match.player2Id && match.blockedReason?.startsWith('Imported bracket participants changed.') && <button className="btn btn-small" disabled={disabled} onClick={() => {
        if (window.confirm(`Confirm that this match is now ${match.player1Name} vs ${match.player2Name}? It will return to the queue with its previous live score cleared.`)) void act(() => trpc.eventOps.updateMatch.mutate({ matchId: match.id, expectedRevision: match.revision, status: 'ready' }), 'Players confirmed · match returned to the queue');
      }}>Confirm players and return to queue</button>}
      {match.status === 'playing' && <button className="btn btn-small" disabled={disabled} onClick={() => begin('live')}>Update live score</button>}
      <button className="btn btn-small" disabled={disabled} onClick={() => begin('final')}>{match.status === 'complete' ? 'Correct score' : 'Finish match'}</button>
    </div>
    {editing && <form className="ops-score-form" onSubmit={event => { event.preventDefault(); void act(async () => {
      if (editing === 'live') await trpc.eventOps.updateLiveScore.mutate({ matchId: match.id, expectedRevision: revision, score1, score2 });
      else await trpc.eventOps.reportScore.mutate({ matchId: match.id, expectedRevision: revision, requestId, score1, score2, outcome, ...(outcome !== 'played' ? { winnerId } : {}) });
      setEditing(null);
    }, editing === 'live' ? 'Live score updated · match still playing' : 'Score recorded locally'); }}>
      <strong>{editing === 'live' ? 'Update the score without finishing the match' : 'Confirm the final result and finish this match'}</strong>
      {stale && <p role="alert" className="error-text">Another TO updated this match. Cancel and reopen to use the latest score.</p>}
      <div className="ops-score-inputs"><label>{match.player1Name}<input className="input" type="number" min={0} max={5} value={score1} onChange={event => { setScore1(Number(event.target.value)); setRequestId(crypto.randomUUID()); }} required /></label><label>{match.player2Name}<input className="input" type="number" min={0} max={5} value={score2} onChange={event => { setScore2(Number(event.target.value)); setRequestId(crypto.randomUUID()); }} required /></label></div>
      {editing === 'final' && <><label>Result type<select className="select" value={outcome} onChange={event => { setOutcome(event.target.value as typeof outcome); setRequestId(crypto.randomUUID()); }}><option value="played">Played match</option><option value="forfeit">Forfeit</option><option value="bye">Bye</option></select></label>{outcome !== 'played' && <label>Winner<select className="select" value={winnerId} onChange={event => { setWinnerId(event.target.value); setRequestId(crypto.randomUUID()); }}>{[{ id: match.player1Id, name: match.player1Name }, { id: match.player2Id, name: match.player2Name }].filter(player => player.id).map(player => <option key={player.id!} value={player.id!}>{player.name}</option>)}</select></label>}</>}
      <div className="ops-match-actions"><button className="btn btn-primary" disabled={disabled || stale || (editing === 'final' && outcome === 'played' && score1 === score2)}>{editing === 'live' ? 'Save live score' : 'Confirm result'}</button><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button></div>
    </form>}
  </article>;
}
function PlayerReports({ data, disabled, act }: { data: Overview; disabled: boolean; act: Action }) {
  return <section className="card" id="score-submissions"><h3>Score submissions</h3><p className="muted">Review pending scores and disagreements. A conflicting report does not replace the recorded result until a TO accepts the correction.</p><ReportRows data={data} disabled={disabled} act={act} /></section>;
}
function ReportRows({ data, disabled, act }: { data: Overview; disabled: boolean; act: Action }) {
  const reports = data.reports.filter(report => report.status === 'pending').sort((a, b) => Number(b.isDispute) - Number(a.isDispute));
  return reports.length ? <div>{reports.map(report => {
    const match = data.matches.find(match => match.id === report.matchId);
    return <div className="ops-report" key={report.id} id={`score-report-${report.id}`} tabIndex={-1}><div>{report.isDispute && <p className="error-text"><strong>Conflicting report · TO review</strong><br />{match?.status === 'complete' ? <>Recorded result: {match.player1Name} {match.score1}–{match.score2} {match.player2Name}. This report proposes:</> : 'Conflicting submissions; no result recorded. This report proposes:'}</p>}<strong>{match?.player1Name ?? 'Player'} {report.score1} – {report.score2} {match?.player2Name ?? 'Player'}</strong><p className="muted">{match?.label} · {report.reporterLabel} report · {report.outcome}{match && match.revision !== report.expectedRevision ? ' · stale: match has changed' : ''}</p></div><button className="btn btn-small" disabled={disabled || match?.revision !== report.expectedRevision} onClick={() => void act(() => trpc.eventOps.reviewReport.mutate({ reportId: report.id, approve: true }), 'Player score approved')}>{report.isDispute ? 'Use submitted result' : 'Approve'}</button><button className="btn btn-small" disabled={disabled} onClick={() => void act(() => trpc.eventOps.reviewReport.mutate({ reportId: report.id, approve: false }), 'Player report rejected')}>{report.isDispute && match?.status === 'complete' ? 'Keep recorded result' : 'Reject'}</button></div>;
  })}</div> : <p className="muted">No scores awaiting review.</p>;
}
function AuditList({ data }: { data: Overview }) {
  return <ol className="ops-audit-list">{data.audit.slice(0, 30).map(item => <li key={item.id}><strong>{item.action.replaceAll('_', ' ')}</strong> · {data.matches.find(match => match.id === item.matchId)?.label ?? 'Event'} <time>{new Date(item.createdAt).toLocaleString()}</time></li>)}</ol>;
}
