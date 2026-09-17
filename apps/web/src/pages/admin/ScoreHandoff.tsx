import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export function ScoreHandoff({ planId, data, disabled }: { planId: string; data: Overview; disabled: boolean }) {
  const cache = useQueryClient();
  const capability = useQuery({ queryKey: ['eventOpsDelivery', planId], queryFn: () => trpc.eventOps.delivery.status.query({ planId }) });
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const undelivered = data.matches.filter(match => match.status === 'complete' && match.syncState !== 'synced');
  const summary = undelivered.map(match => `${match.label}: ${match.player1Name} ${match.score1 ?? '–'} – ${match.score2 ?? '–'} ${match.player2Name} (${match.outcome ?? 'result'}; ${match.syncState})`).join('\n');
  const deliver = async (match: Overview['matches'][number]) => {
    setPending(match.id); setError(''); setNotice('');
    try { const result = await trpc.eventOps.delivery.deliver.mutate({ matchId: match.id, expectedRevision: match.revision }); if (result.ok) setNotice('Challonge confirmed the score.'); else setError(result.message ?? 'Delivery needs reconciliation.'); await cache.invalidateQueries({ queryKey: ['eventOps', planId] }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Delivery failed. Refresh and reconcile before retrying.'); }
    finally { setPending(null); }
  };
  return <section className="card"><h3>Challonge handoff <span className="chip">{undelivered.length} local result(s)</span></h3><p className="muted">Local scores are retained here. Linked brackets remain the official bracket record. After a manual update, sync the bracket in Tournaments and refresh this queue to reconcile.</p>
    <div className="ops-links">{data.brackets.filter(bracket => bracket.slug).map(bracket => <a key={`${bracket.division}:${bracket.stage}`} href={`https://challonge.com/${encodeURIComponent(bracket.slug!)}`} target="_blank" rel="noreferrer">{bracket.division} {bracket.stage} ↗</a>)}</div>
    {!capability.data?.enabled && <p className="muted">Direct score delivery is disabled. The manual handoff below is always available.</p>}
    {capability.data?.enabled && !capability.data.hasCredentials && <p className="error-text">Direct delivery needs configured Challonge credentials.</p>}
    {undelivered.length > 0 && <><label className="ops-copy-label">Results to reconcile<textarea className="input" rows={5} readOnly value={summary} /></label><button className="btn" onClick={() => { const url = URL.createObjectURL(new Blob([`${data.plan.name}\n\n${summary}\n`], {type:'text/plain'})); const link = document.createElement('a'); link.href=url; link.download='nemesis-score-handoff.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }}>Download score handoff</button></>}
    {capability.data?.enabled && capability.data.hasCredentials && <div>{undelivered.filter(match => match.outcome === 'played' && match.sourceSetId).map(match => <div className="ops-report" key={match.id}><span>{match.label}: {match.score1}–{match.score2}</span><button className="btn btn-small" disabled={disabled || pending !== null} onClick={() => void deliver(match)}>{pending === match.id ? 'Verifying delivery…' : 'Send to Challonge'}</button></div>)}</div>}
    {error && <p role="alert" className="error-text">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
