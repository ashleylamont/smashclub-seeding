import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Preview = Awaited<ReturnType<typeof trpc.eventOps.previewAttendance.query>>;
type Input = { planId: string; action: 'add' | 'withdraw'; playerId: string; division?: 'upper' | 'lower'; poolIndex?: number; reason?: string; acknowledgeExternalChange?: boolean };

export function AttendanceControls({ planId, data, disabled }: { planId: string; data: Overview; disabled: boolean }) {
  const cache = useQueryClient();
  const [action, setAction] = useState<'add' | 'withdraw'>('add');
  const [query, setQuery] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [pool, setPool] = useState('');
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [preview, setPreview] = useState<{ result: Preview; input: Input } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const search = useQuery({ queryKey: ['public', 'players', query], queryFn: () => trpc.public.searchPlayers.query({ query }), enabled: query.trim().length > 1 && action === 'add' });
  const pools = [...new Set(data.matches.filter(match => match.stage === 'group').map(match => `${match.division}:${match.poolIndex}`))];
  const changed = () => { setPreview(null); setMessage(''); setError(''); };
  const inspect = async () => {
    const [division, index] = pool.split(':');
    const input: Input = { planId, action, playerId, reason, acknowledgeExternalChange: ack, ...(action === 'add' && pool ? { division: division as 'upper' | 'lower', poolIndex: Number(index) } : {}) };
    setBusy(true); setError(''); setMessage('');
    try { setPreview({ input, result: await trpc.eventOps.previewAttendance.query(input) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not preview change'); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    try { await trpc.eventOps.applyAttendance.mutate({ ...preview.input, revisionToken: preview.result.revisionToken }); setPreview(null); setPlayerId(''); setMessage('Attendance updated. Completed results were preserved. Refresh the match queue to see any new matches.'); await cache.invalidateQueries({ queryKey: ['eventOps', planId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update attendance'); }
    finally { setBusy(false); }
  };
  return <section className="card"><h3>Late arrivals and withdrawals</h3><p className="muted">Preview the affected matches first. Played results stay on the record; withdrawals do not invent scores.</p>
    <fieldset disabled={disabled || busy} className="ops-attendance-fields"><label>Change<select className="select" value={action} onChange={e => { setAction(e.target.value as typeof action); setPlayerId(''); changed(); }}><option value="add">Add a late arrival</option><option value="withdraw">Withdraw an entrant</option></select></label>
    {action === 'add' && <label>Find player by public alias<input className="input" value={query} onChange={e => { setQuery(e.target.value); setPlayerId(''); changed(); }} maxLength={100} placeholder="Start typing a player alias" /></label>}
    <label>Player<select className="select" value={playerId} onChange={e => { setPlayerId(e.target.value); changed(); }}><option value="">Choose a player</option>{(action === 'add' ? search.data ?? [] : data.entrants.filter(player => !data.withdrawals.some(row => row.playerId === player.id))).map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label>
    {action === 'add' && <label>Pool<select className="select" value={pool} onChange={e => { setPool(e.target.value); changed(); }}><option value="">Choose a pool</option>{pools.map(key => <option key={key} value={key}>{key.split(':')[0]} · Pool {String.fromCharCode(65 + Number(key.split(':')[1]))}</option>)}</select></label>}
    <label>Reason<input className="input" value={reason} onChange={e => { setReason(e.target.value); changed(); }} maxLength={200} placeholder="Arrived late / unable to stay" /></label>
    <label className="ops-check"><input type="checkbox" checked={ack} onChange={e => { setAck(e.target.checked); changed(); }} /> I have reconciled the attendance change in any attached Challonge bracket.</label>
    <button className="btn" disabled={!playerId || (action === 'add' && !pool)} onClick={() => void inspect()}>Preview attendance change</button></fieldset>
    {search.isError && <p role="alert">{search.error.message}</p>}
    {preview && <div className="ops-attendance-preview"><h4>Change preview</h4><p>{preview.result.addedMatches} new match(es) · {preview.result.affectedMatches.length} affected existing match(es)</p>{preview.result.issues.map(issue => <p className="error-text" key={issue}>{issue}</p>)}{preview.result.warnings.map(warning => <p className="muted" key={warning}>{warning}</p>)}{preview.result.affectedMatches.length > 0 && <ul>{preview.result.affectedMatches.map(match => <li key={match.id}>{match.label} · {match.status}</li>)}</ul>}<button className="btn btn-primary" disabled={busy || disabled || !preview.result.allowed} onClick={() => void apply()}>Apply this change</button></div>}
    {error && <p className="error-text" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
