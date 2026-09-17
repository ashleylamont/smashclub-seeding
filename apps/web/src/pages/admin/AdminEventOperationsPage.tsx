import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch, useParams } from '@tanstack/react-router';
import { trpc } from '../../lib/trpc';
import { authClient, sessionRole } from '../../lib/auth';
import './EventOperations.css';
import { AttendanceControls } from './AttendanceControls';
import { availableMatches, poolStandings } from '../../lib/eventQueue';

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
  const [stationName, setStationName] = useState('');
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
  const available = availableMatches(data.matches);
  const callable = new Set(available.map(match => match.id));
  const pools = poolStandings(data.matches);
  const matches = (filter === 'ready' ? available : data.matches).filter(match => (division === 'all' || match.division === division) &&
    (filter === 'all' || (filter === 'active' ? match.status !== 'complete' : match.status === filter)) &&
    `${match.player1Name} ${match.player2Name} ${match.label}`.toLowerCase().includes(search.toLowerCase()));
  const entrants = new Map<string, string>();
  for (const match of data.matches) { if (match.player1Id) entrants.set(match.player1Id, match.player1Name); if (match.player2Id) entrants.set(match.player2Id, match.player2Name); }
  return <div className="ops-page">
    <header className="ops-heading"><div><span className="ops-eyebrow">EVENT CONTROL</span><h2>{data.plan.name}</h2><p className="muted">{closed ? 'Event closed · read only' : 'Shared desk · refreshes every 2.5 seconds'}</p></div>
      <nav className="ops-links">{admin && <a href={`/admin/event-planner?plan=${planId}`}>Planner</a>}<a href={`/live/${planId}`} target="_blank" rel="noreferrer">Public screen ↗</a><a href={`/overlay/${planId}`} target="_blank" rel="noreferrer">OBS overlay ↗</a><a href={`/play/${planId}`}>Player reporting</a></nav></header>
    {event.isError && <div className="banner banner-warning" role="alert">Live updates interrupted. Last loaded data is shown. {event.error.message}</div>}
    {error && <div className="banner banner-danger" role="alert">{error}</div>}{notice && <p className="ops-notice" role="status">{notice}</p>}
    <div className="ops-stats">{(['playing', 'ready', 'blocked', 'complete'] as const).map(status => <button key={status} className={`ops-stat ${filter === status ? 'selected' : ''}`} onClick={() => setFilter(status)}><strong>{status === 'ready' ? available.length : data.matches.filter(m => m.status === status).length}</strong><span>{status === 'playing' ? 'Playing now' : status}</span></button>)}</div>
    <section className="card ops-setup"><div><h3>Match desk</h3><p className="muted">Prepare pool matches or refresh attached brackets. Recorded scores stay intact.</p></div><button className="btn" disabled={pending || closed} onClick={() => void act(() => trpc.eventOps.prepare.mutate({ planId }), 'Match queue refreshed')}>Prepare / refresh matches</button></section>
    <div className="ops-toolbar"><label>View<select className="select" value={filter} onChange={e => setFilter(e.target.value)}><option value="active">Unfinished</option><option value="ready">Ready</option><option value="playing">Playing</option><option value="blocked">Blocked</option><option value="complete">Completed</option><option value="all">All matches</option></select></label><label>Division<select className="select" value={division} onChange={e => setDivision(e.target.value)}><option value="all">Both divisions</option><option value="upper">Upper</option><option value="lower">Lower</option></select></label><label className="ops-search">Find a player or match<input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search the queue" /></label></div>
    <div className="ops-match-grid">{matches.map(match => <MatchCard key={match.id} match={match} stations={data.stations} disabled={pending || closed} canStart={callable.has(match.id)} act={act} />)}</div>
    {matches.length === 0 && <p className="card muted">{data.matches.length === 0 ? 'Generate pools in the planner, then prepare the match queue here.' : 'No matches in this view.'}</p>}
    {pools.length > 0 && <section className="card"><h3>Pool standings</h3><p className="muted">Ordered by wins, then game difference for review. Ties and final advancement must be confirmed in the planner.</p><div className="ops-bottom-grid">{pools.map(pool => <div key={`${pool.division}:${pool.poolIndex}`}><h4>{pool.division} · Pool {String.fromCharCode(65 + pool.poolIndex)} <span className="muted">{pool.complete}/{pool.total} sets</span></h4><table className="ops-standings"><thead><tr><th>Player</th><th>W–L</th><th>Games ±</th><th>To play</th></tr></thead><tbody>{pool.players.map(player => <tr key={player.id}><td>{player.name}</td><td>{player.wins}–{player.losses}</td><td>{player.differential > 0 ? '+' : ''}{player.differential}</td><td>{player.remaining}</td></tr>)}</tbody></table></div>)}</div>{admin ? <a href={`/admin/event-planner?plan=${planId}&step=pools`}>Review and confirm advancement →</a> : <p className="muted">Ask an event administrator to confirm advancement in the planner.</p>}</section>}
    <PlayerReports data={data} disabled={pending || closed} act={act} />
    <AttendanceControls planId={planId} data={data} disabled={pending || closed} />
    <div className="ops-bottom-grid">
      <section className="card"><h3>Stations</h3><ul>{data.stations.map(station => <li key={station.id}>{station.name}</li>)}</ul><form onSubmit={e => { e.preventDefault(); void act(async () => { await trpc.eventOps.saveStation.mutate({ planId, name: stationName }); setStationName(''); }); }}><label>Station name<input className="input" value={stationName} onChange={e => setStationName(e.target.value)} placeholder="Stage / Setup 2" maxLength={60} required /></label><button className="btn" disabled={pending || closed}>Add station</button></form></section>
      <section className="card"><h3>Announcements</h3><form onSubmit={e => { e.preventDefault(); void act(async () => { await trpc.eventOps.announce.mutate({ planId, message: announcement }); setAnnouncement(''); }, 'Announcement published to the event feed'); }}><label>Message<textarea className="input" value={announcement} onChange={e => setAnnouncement(e.target.value)} maxLength={500} required placeholder="Upper finals on the stage in five minutes" /></label><button className="btn" disabled={pending || closed}>Post announcement</button></form>{data.announcements.slice(0, 3).map(item => <p key={item.id} className="ops-announcement">{item.message}</p>)}</section>
      <section className="card"><h3>Prizes</h3><p className="muted">Publish confirmed awards. You choose the recipient.</p><form onSubmit={e => { e.preventDefault(); void act(async () => { await trpc.eventOps.savePrize.mutate({ planId, title: prizeTitle, ...(prizePlayer ? { playerId: prizePlayer } : {}) }); setPrizeTitle(''); }); }}><label>Award<input className="input" value={prizeTitle} onChange={e => setPrizeTitle(e.target.value)} placeholder="Upper champion / Best comeback" maxLength={100} required /></label><label>Recipient<select className="select" value={prizePlayer} onChange={e => setPrizePlayer(e.target.value)}><option value="">To be announced</option>{[...entrants].map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label><button className="btn" disabled={pending || closed}>Save prize</button></form>{data.prizes.map(prize => <p key={prize.id}><strong>{prize.title}</strong> — {prize.playerName ?? 'To be announced'}</p>)}</section>
      {admin && <section className="card"><h3>Event access</h3><label className="ops-check"><input type="checkbox" checked={data.settings.published} disabled={pending || closed} onChange={e => void act(() => trpc.eventOps.settings.mutate({ planId, published: e.target.checked, playerReports: data.settings.playerReports }))} /> Publish live event page</label><label className="ops-check"><input type="checkbox" checked={data.settings.playerReports} disabled={pending || closed} onChange={e => void act(() => trpc.eventOps.settings.mutate({ planId, published: data.settings.published, playerReports: e.target.checked }))} /> Allow players to submit scores for TO approval</label><p className="muted">TOs use <a href={`/operate/${planId}`}>this event’s control link</a>. Grant access to an existing signed-in account.</p><form onSubmit={e => { e.preventDefault(); void act(async () => { await trpc.eventOps.assignTo.mutate({ planId, email: toUserId }); setToUserId(''); }); }}><label>TO email address<input type="email" className="input" value={toUserId} onChange={e => setToUserId(e.target.value)} required /></label><button className="btn" disabled={pending || closed}>Grant event access</button></form><ul>{data.tos.map(to => <li key={to.id}>{to.name} ({to.email}) <button className="btn btn-small" disabled={pending || closed} onClick={() => void act(() => trpc.eventOps.assignTo.mutate({ planId, userId: to.userId, remove: true }))}>Remove access</button></li>)}</ul></section>}
    </div>
    <details className="card"><summary>Recent changes</summary><AuditList data={data} /></details>
  </div>;
}

type Action = (work: () => Promise<unknown>, message?: string) => Promise<void>;
function MatchCard({ match, stations, disabled, canStart, act }: { match: Match; stations: Overview['stations']; disabled: boolean; canStart: boolean; act: Action }) {
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(match.revision);
  const [score1, setScore1] = useState(match.score1 ?? 0);
  const [score2, setScore2] = useState(match.score2 ?? 0);
  const [outcome, setOutcome] = useState<'played' | 'forfeit' | 'bye'>('played');
  const [winnerId, setWinnerId] = useState(match.winnerId ?? match.player1Id ?? '');
  const [requestId, setRequestId] = useState('');
  const stale = editing && revision !== match.revision;
  return <article className={`card ops-match ops-match-${match.status}`}><div className="ops-match-meta"><span>{match.division} · {match.label}</span><span className="chip">{match.status}</span></div><div className="ops-contestant"><strong>{match.player1Name || 'Bye / awaiting qualifier'}</strong><b>{match.score1 ?? '–'}</b></div><div className="ops-contestant"><strong>{match.player2Name || 'Bye / awaiting qualifier'}</strong><b>{match.score2 ?? '–'}</b></div>
    <p className="ops-delivery">{match.syncState === 'synced' ? '✓ Confirmed in Challonge' : `Challonge: ${match.syncState} · local record only until reconciled`}</p>
    {match.blockedReason && <p className="ops-blocked">{match.blockedReason}</p>}
    <label className="ops-station">Station<select className="select" value={match.stationId ?? ''} disabled={disabled || match.status === 'complete'} onChange={e => void act(() => trpc.eventOps.updateMatch.mutate({ matchId: match.id, expectedRevision: match.revision, status: match.status === 'playing' ? 'playing' : 'ready', stationId: e.target.value || null }))}><option value="">Unassigned</option>{stations.map(station => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label>
    <div className="ops-match-actions">{match.status !== 'complete' && <button className="btn btn-small" disabled={disabled || (match.status !== 'playing' && !canStart)} onClick={() => void act(() => trpc.eventOps.updateMatch.mutate({ matchId: match.id, expectedRevision: match.revision, status: match.status === 'playing' ? 'ready' : 'playing', stationId: match.stationId }))}>{match.status === 'playing' ? 'Return to queue' : 'Start match'}</button>}<button className="btn btn-small" disabled={disabled} onClick={() => { setEditing(!editing); setRevision(match.revision); setScore1(match.score1 ?? 0); setScore2(match.score2 ?? 0); setOutcome(match.outcome ?? 'played'); setWinnerId(match.winnerId ?? match.player1Id ?? ''); setRequestId(crypto.randomUUID()); }}>{editing ? 'Cancel' : match.status === 'complete' ? 'Correct score' : 'Record score'}</button></div>
    {editing && <form className="ops-score-form" onSubmit={e => { e.preventDefault(); void act(async () => { await trpc.eventOps.reportScore.mutate({ matchId: match.id, expectedRevision: revision, requestId, score1, score2, outcome, ...(outcome !== 'played' ? { winnerId } : {}) }); setEditing(false); }, 'Score recorded locally'); }}>
      {stale && <p role="alert" className="error-text">Another TO updated this match. Cancel and reopen to use the latest result.</p>}
      <div className="ops-score-inputs"><label>{match.player1Name}<input className="input" type="number" min={0} max={99} value={score1} onChange={e => { setScore1(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} required /></label><label>{match.player2Name}<input className="input" type="number" min={0} max={99} value={score2} onChange={e => { setScore2(Number(e.target.value)); setRequestId(crypto.randomUUID()); }} required /></label></div>
      <label>Result type<select className="select" value={outcome} onChange={e => { setOutcome(e.target.value as typeof outcome); setRequestId(crypto.randomUUID()); }}><option value="played">Played set</option><option value="forfeit">Forfeit / withdrawal</option><option value="bye">Bye</option></select></label>
      {outcome !== 'played' && <label>Winner<select className="select" value={winnerId} onChange={e => { setWinnerId(e.target.value); setRequestId(crypto.randomUUID()); }}>{match.player1Id && <option value={match.player1Id}>{match.player1Name}</option>}{match.player2Id && <option value={match.player2Id}>{match.player2Name}</option>}</select></label>}
      <button className="btn btn-primary" disabled={disabled || stale}>Confirm result</button></form>}
  </article>;
}

function PlayerReports({ data, disabled, act }: { data: Overview; disabled: boolean; act: Action }) {
  // The backend returns reports separately from confirmed matches, so an unreviewed score never appears live.
  return <section className="card"><h3>Player submissions</h3><p className="muted">Reports await TO review before becoming confirmed results.</p><ReportRows data={data} disabled={disabled} act={act} /></section>;
}
function ReportRows({ data, disabled, act }: { data: Overview; disabled: boolean; act: Action }) {
  const reports = data.reports.filter(report => report.status === 'pending');
  return reports.length ? <div>{reports.map(report => {
    const match = data.matches.find(match => match.id === report.matchId);
    return <div className="ops-report" key={report.id}><div><strong>{match?.player1Name ?? 'Player'} {report.score1} – {report.score2} {match?.player2Name ?? 'Player'}</strong><p className="muted">{match?.label} · {report.outcome}{match && match.revision !== report.expectedRevision ? ' · stale: match has changed' : ''}</p></div><button className="btn btn-small" disabled={disabled || match?.revision !== report.expectedRevision} onClick={() => void act(() => trpc.eventOps.reviewReport.mutate({ reportId: report.id, approve: true }), 'Player score approved')}>Approve</button><button className="btn btn-small" disabled={disabled} onClick={() => void act(() => trpc.eventOps.reviewReport.mutate({ reportId: report.id, approve: false }), 'Player report rejected')}>Reject</button></div>;
  })}</div> : <p className="muted">No scores awaiting review.</p>;
}
function AuditList({ data }: { data: Overview }) {
  return <ol className="ops-audit-list">{data.audit.slice(0, 30).map(item => <li key={item.id}><strong>{item.action.replaceAll('_', ' ')}</strong> · {data.matches.find(match => match.id === item.matchId)?.label ?? 'Event'} <time>{new Date(item.createdAt).toLocaleString()}</time></li>)}</ol>;
}
