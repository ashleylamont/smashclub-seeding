import { useEffect, useRef, useState } from 'react';
import { newResultNotices, recentResults, resultFingerprint, resultHeadline, type ResultMatch, type ResultNotice } from '../lib/broadcastResults';
import './BroadcastResults.css';

/** Entirely confined to the existing footer: no animation can cover gameplay. */
export function BroadcastResults({ matches, announcement }: { matches: readonly ResultMatch[]; announcement: string }) {
  const previous = useRef<readonly ResultMatch[] | null>(null);
  const [queue, setQueue] = useState<ResultNotice[]>([]);
  useEffect(() => {
    const incoming = newResultNotices(previous.current, matches);
    previous.current = matches;
    const timer = window.setTimeout(() => setQueue(old => {
      const current = new Map(matches.map(match => [match.id, match]));
      const valid = old.filter(notice => {
        const match = current.get(notice.matchId);
        return match?.status === 'complete' && resultFingerprint(match) === notice.fingerprint;
      });
      // Keep the freshest batch bounded when a bracket import brings many results.
      return [...valid, ...incoming].slice(-8);
    }), 0);
    return () => window.clearTimeout(timer);
  }, [matches]);
  const active = queue[0];
  const match = active && matches.find(item => item.id === active.matchId && item.status === 'complete' && resultFingerprint(item) === active.fingerprint);
  const activeKey = active ? `${active.matchId}:${active.fingerprint}` : '';
  useEffect(() => {
    if (!activeKey) return;
    const timer = window.setTimeout(() => setQueue(old => old.slice(1)), 8000);
    return () => window.clearTimeout(timer);
  }, [activeKey]);
  const recent = recentResults(matches);
  return <div className="broadcast-results">
    <div className="broadcast-recent" aria-label="Recent match outcomes"><span>JUST IN ↗</span>{recent.length ? recent.map(result => <span className="broadcast-recent-item" key={result.id} title={resultHeadline(result)}>{resultHeadline(result)}</span>) : <span>Confirmed results will land here.</span>}</div>
    <div className="broadcast-result-stage" aria-live="polite" aria-atomic="true">
      {match && active ? <div className={`broadcast-result-flash ${active.kind === 'correction' ? 'is-correction' : ''}`} key={activeKey} data-testid="broadcast-result-notice">
        <span className="broadcast-result-stamp" aria-hidden="true">✦</span>
        <div className="broadcast-result-label"><small>{active.kind === 'correction' ? 'SCORE UPDATE' : 'SET COMPLETE'}</small><strong>{active.kind === 'correction' ? 'CORRECTED' : 'GG!'}</strong></div>
        <div className="broadcast-result-copy"><strong>{resultHeadline(match)}</strong><small>{match.division} / {match.stage === 'group' ? `Pool ${String.fromCharCode(65 + (match.poolIndex ?? 0))}` : match.stage} · {match.label}</small></div>
        <span className="broadcast-result-bars" aria-hidden="true">///</span>
      </div> : <div className="broadcast-floor"><span>FROM THE<br /><strong>FLOOR ↗</strong></span><p>{announcement}</p></div>}
    </div>
  </div>;
}
