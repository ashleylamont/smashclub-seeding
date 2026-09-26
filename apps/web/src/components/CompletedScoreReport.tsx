import { useState } from 'react';

type RecordedMatch = { revision: number; score1: number | null; score2: number | null; player1Name: string | null; player2Name: string | null; pendingDisputeCount?: number };
export type ResultSubmission = { expectedRevision: number; requestId: string; score1: number; score2: number };
/** Later reports are evidence for organisers; they never replace the displayed official result. */
export function CompletedScoreReport({ match, enabled, allowReports, onSubmit, pendingReport, label = 'Confirmed result' }: { match: RecordedMatch; enabled: boolean; allowReports: boolean; pendingReport?: { score1: number; score2: number; isDispute: boolean }; onSubmit: (input: ResultSubmission) => Promise<{ isDispute: boolean }>; label?: string }) {
  const [editing, setEditing] = useState(false);
  const [score1, setScore1] = useState(match.score1 ?? 0);
  const [score2, setScore2] = useState(match.score2 ?? 0);
  const [revision, setRevision] = useState(match.revision);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const submit = async (first: number, second: number) => {
    setPending(true); setError('');
    try {
      const result = await onSubmit({ expectedRevision: revision, requestId, score1: first, score2: second });
      setMessage(result.isDispute ? 'Different score sent to the TOs for review. The recorded result stays official until they resolve it.' : 'Thanks — your score agrees with the recorded result.');
      setEditing(false); setRequestId(crypto.randomUUID());
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send this report. Try again.'); }
    finally { setPending(false); }
  };
  return <div><p>{label}: {match.score1} – {match.score2}</p>
    {!!match.pendingDisputeCount && <p className="banner banner-warning">A different score has been reported. TO review is pending; this result remains official.</p>}
    {allowReports && <><p className="muted">You can confirm this score or flag a different result. A disagreement goes to the TOs and does not change the result automatically.</p>
      {pendingReport ? <p role="status">Your {pendingReport.isDispute ? 'different score' : 'score'}: {pendingReport.score1} – {pendingReport.score2} · awaiting TO review. Ask a TO if it needs updating.</p> : !enabled ? <p>Use your current event QR pass to confirm or flag this result.</p> : <>
        {revision !== match.revision && <div role="alert"><p>The recorded result changed. Reload it before reporting.</p><button type="button" className="btn" onClick={() => { setRevision(match.revision); setScore1(match.score1 ?? 0); setScore2(match.score2 ?? 0); setRequestId(crypto.randomUUID()); setError(''); setMessage(''); }}>Reload match</button></div>}
        <div className="ops-toolbar"><button className="btn" disabled={pending || revision !== match.revision} onClick={() => void submit(match.score1 ?? 0, match.score2 ?? 0)}>Confirm recorded score</button><button className="btn" disabled={pending} onClick={() => { setEditing(!editing); setMessage(''); }}>Report a different score</button></div>
        {editing && <form className="ops-score-form" onSubmit={event => { event.preventDefault(); void submit(score1, score2); }}><div className="ops-score-inputs"><label>{match.player1Name}<input className="input" type="number" min={0} max={5} required value={score1} onChange={event => { setScore1(Number(event.target.value)); setRequestId(crypto.randomUUID()); }} /></label><label>{match.player2Name}<input className="input" type="number" min={0} max={5} required value={score2} onChange={event => { setScore2(Number(event.target.value)); setRequestId(crypto.randomUUID()); }} /></label></div><button className="btn" disabled={pending || revision !== match.revision || score1 === score2 || score1 === match.score1 && score2 === match.score2}>Send different score to TOs</button></form>}
      </>}
    </>}
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="error-text">{error}</p>}
  </div>;
}
