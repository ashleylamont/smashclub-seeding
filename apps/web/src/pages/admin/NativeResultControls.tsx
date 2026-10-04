import { useState } from 'react';
import { trpc } from '../../lib/trpc';
type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
export function NativeResultControls({
  data,
  onChanged,
}: {
  data: Overview;
  onChanged: () => Promise<unknown>;
}) {
  const [matchId, setMatchId] = useState('');
  const [outcome, setOutcome] = useState<'played' | 'forfeit'>('played');
  const [winnerId, setWinnerId] = useState('');
  const [score1, setScore1] = useState(0),
    [score2, setScore2] = useState(0);
  const [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  if (!('publication' in data) || !data.publication || data.plan.status !== 'complete') return null;
  const publication = data.publication;
  const match = data.matches.find((m) => m.id === matchId);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      await onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not update results.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h3>Published results and corrections</h3>
      <p>
        {publication.status === 'published'
          ? `Result revision ${publication.revision} published.`
          : publication.status === 'blocked'
            ? 'Result publication needs recovery.'
            : 'Results are sealed and publication is pending.'}{' '}
        {'ratingIntents' in data && data.ratingIntents.length > 0 ? 'Ratings are updating.' : ''}
      </p>
      {publication.status !== 'published' && (
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            void run(() => trpc.eventOps.live.recover.mutate({ planId: data.plan.id }))
          }
        >
          Retry result publication
        </button>
      )}
      <p className="muted">
        A reviewed correction publishes a replacement result and updates ratings. Recorded opponents
        and the draw stay intact. Enter the reason for the ruling.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!match) return;
          void run(async () => {
            await trpc.eventOps.live.command.mutate({
              planId: data.plan.id,
              requestId: crypto.randomUUID(),
              command: {
                kind: 'replaceResult',
                resultId: publication.resultId,
                reason,
                corrections: [
                  {
                    matchId: match.id,
                    expectedRevision: match.revision,
                    outcome,
                    score1: outcome === 'played' ? score1 : null,
                    score2: outcome === 'played' ? score2 : null,
                    ...(outcome === 'forfeit' ? { winnerId } : {}),
                  },
                ],
              },
            });
            setMatchId('');
            setReason('');
          });
        }}
      >
        <label>
          Completed match
          <select
            className="select"
            value={matchId}
            onChange={(event) => {
              setMatchId(event.target.value);
              const next = data.matches.find((m) => m.id === event.target.value);
              setScore1(next?.score1 ?? 0);
              setScore2(next?.score2 ?? 0);
              setOutcome(next?.outcome === 'forfeit' ? 'forfeit' : 'played');
              setWinnerId(next?.winnerId ?? '');
            }}
          >
            <option value="">Choose a match</option>
            {data.matches
              .filter(
                (m) =>
                  ['played', 'forfeit'].includes(m.outcome ?? '') && m.player1Id && m.player2Id,
              )
              .map((m) => (
                <option value={m.id} key={m.id}>
                  {m.label} · {m.player1Name} vs {m.player2Name}
                </option>
              ))}
          </select>
        </label>
        {match && (
          <>
            <label>
              Result type
              <select
                className="select"
                value={outcome}
                onChange={(event) => setOutcome(event.target.value as 'played' | 'forfeit')}
              >
                <option value="played">Played</option>
                <option value="forfeit">Forfeit</option>
              </select>
            </label>
            {outcome === 'played' ? (
              <>
                <label>
                  {match.player1Name}
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={5}
                    value={score1}
                    onChange={(event) => setScore1(Number(event.target.value))}
                  />
                </label>
                <label>
                  {match.player2Name}
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={5}
                    value={score2}
                    onChange={(event) => setScore2(Number(event.target.value))}
                  />
                </label>
              </>
            ) : (
              <label>
                Forfeit winner
                <select
                  className="select"
                  value={winnerId}
                  onChange={(event) => setWinnerId(event.target.value)}
                  required
                >
                  <option value="">Choose winner</option>
                  <option value={match.player1Id!}>{match.player1Name}</option>
                  <option value={match.player2Id!}>{match.player2Name}</option>
                </select>
              </label>
            )}
          </>
        )}
        <label>
          Ruling reason
          <textarea
            className="input"
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button
          className="btn"
          disabled={
            busy ||
            publication.status !== 'published' ||
            !match ||
            !reason.trim() ||
            (outcome === 'played' ? score1 === score2 : !winnerId)
          }
        >
          Publish reviewed correction
        </button>
      </form>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
