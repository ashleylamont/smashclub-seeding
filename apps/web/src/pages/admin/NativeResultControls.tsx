import { Button } from '../../components/ui/Button';
import { Select, SelectItem } from '../../components/ui/Select';
import { Textarea } from '../../components/ui/Input';
import { ScoreFields, type ScoreInputValue } from '../../components/ScoreFields';
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
  const [score1, setScore1] = useState<ScoreInputValue>(0),
    [score2, setScore2] = useState<ScoreInputValue>(0);
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
        <Button
          disabled={busy}
          onClick={() =>
            void run(() => trpc.eventOps.live.recover.mutate({ planId: data.plan.id }))
          }
        >
          Retry result publication
        </Button>
      )}
      <p className="muted">
        A reviewed correction publishes a replacement result and updates ratings. Recorded opponents
        and the draw stay intact. Enter the reason for the ruling.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!match || (outcome === 'played' && (score1 === '' || score2 === ''))) return;
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
                    score1: outcome === 'played' && score1 !== '' ? score1 : null,
                    score2: outcome === 'played' && score2 !== '' ? score2 : null,
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
          <Select
            value={matchId}
            onValueChange={(value) => {
              setMatchId(value);
              const next = data.matches.find((m) => m.id === value);
              setScore1(next?.score1 ?? 0);
              setScore2(next?.score2 ?? 0);
              setOutcome(next?.outcome === 'forfeit' ? 'forfeit' : 'played');
              setWinnerId(next?.winnerId ?? '');
            }}
          >
            <SelectItem value="">Choose a match</SelectItem>
            {data.matches
              .filter(
                (m) =>
                  ['played', 'forfeit'].includes(m.outcome ?? '') && m.player1Id && m.player2Id,
              )
              .map((m) => (
                <SelectItem value={m.id} key={m.id}>
                  {m.label} · {m.player1Name} vs {m.player2Name}
                </SelectItem>
              ))}
          </Select>
        </label>
        {match && (
          <>
            <label>
              Result type
              <Select
                value={outcome}
                onValueChange={(value) => setOutcome(value as 'played' | 'forfeit')}
              >
                <SelectItem value="played">Played</SelectItem>
                <SelectItem value="forfeit">Forfeit</SelectItem>
              </Select>
            </label>
            {outcome === 'played' ? (
              <ScoreFields
                player1Name={match.player1Name}
                player2Name={match.player2Name}
                score1={score1}
                score2={score2}
                onScore1={setScore1}
                onScore2={setScore2}
              />
            ) : (
              <label>
                Forfeit winner
                <Select value={winnerId} onValueChange={setWinnerId} required>
                  <SelectItem value="">Choose winner</SelectItem>
                  <SelectItem value={match.player1Id!}>{match.player1Name}</SelectItem>
                  <SelectItem value={match.player2Id!}>{match.player2Name}</SelectItem>
                </Select>
              </label>
            )}
          </>
        )}
        <label>
          Ruling reason
          <Textarea
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          disabled={
            busy ||
            publication.status !== 'published' ||
            !match ||
            !reason.trim() ||
            (outcome === 'played' ? score1 === '' || score2 === '' || score1 === score2 : !winnerId)
          }
        >
          Publish reviewed correction
        </Button>
      </form>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
