import { TRPCClientError } from '@trpc/client';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Feedback';
import { Select, SelectItem } from '../../components/ui/Select';
import { Textarea } from '../../components/ui/Input';
import { ScoreFields, type ScoreInputValue } from '../../components/ScoreFields';
import { matchPresentation, recordedScoreText } from '../../lib/matchPresentation';
import { trpc } from '../../lib/trpc';
import './NativeResultControls.css';

type Overview = Awaited<ReturnType<typeof trpc.eventOps.overview.query>>;
type Match = Overview['matches'][number];
type CommandInput = Parameters<typeof trpc.eventOps.live.command.mutate>[0];
type Replacement = CommandInput & {
  command: Extract<CommandInput['command'], { kind: 'replaceResult' }>;
};
type CorrectionBasis = { resultId: string; match: Match; order: string[] };

function canRetryCorrection(cause: unknown) {
  const code = cause instanceof TRPCClientError ? cause.data?.code : undefined;
  return (
    !code ||
    [
      'INTERNAL_SERVER_ERROR',
      'TIMEOUT',
      'BAD_GATEWAY',
      'SERVICE_UNAVAILABLE',
      'GATEWAY_TIMEOUT',
    ].includes(code)
  );
}

export function NativeResultControls({
  data,
  onChanged,
}: {
  data: Overview;
  onChanged: () => Promise<unknown>;
}) {
  const [basis, setBasis] = useState<CorrectionBasis | null>(null);
  const [editedOrder, setEditedOrder] = useState<string[] | null>(null);
  const [retry, setRetry] = useState<Replacement | null>(null);
  const [outcome, setOutcome] = useState<'played' | 'forfeit'>('played');
  const [winnerId, setWinnerId] = useState('');
  const [score1, setScore1] = useState<ScoreInputValue>(0),
    [score2, setScore2] = useState<ScoreInputValue>(0);
  const [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const matchPicker = useRef<HTMLButtonElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const latestReview = useRef<HTMLButtonElement>(null);
  const restoreSubmitFocus = useRef(false);
  const inFlight = useRef(false);
  useLayoutEffect(() => {
    if (busy || !restoreSubmitFocus.current) return;
    restoreSubmitFocus.current = false;
    const active = document.activeElement;
    if (active !== document.body && active !== submitButton.current) return;
    [submitButton.current, latestReview.current, matchPicker.current]
      .find((button) => button && !button.disabled)
      ?.focus();
  }, [busy]);
  if (!('publication' in data) || !data.publication || data.plan.status !== 'complete') return null;
  const publication = data.publication;
  const published = publication.status === 'published';
  const match = basis?.match;
  const latestMatch = data.matches.find((item) => item.id === match?.id);
  const changed =
    basis &&
    (publication.resultId !== basis.resultId || latestMatch?.revision !== basis.match.revision);
  const roundRobin = data.plan.structure === 'round_robin';
  const latestOrder = roundRobin
    ? [...data.placements].sort((a, b) => a.place - b.place).map(({ playerId }) => playerId)
    : [];
  const roundRobinOrder = editedOrder ?? basis?.order ?? latestOrder;
  const fieldsDisabled = busy || Boolean(retry);
  const canPublish = Boolean(
    basis &&
    !changed &&
    published &&
    reason.trim() &&
    (outcome === 'played' ? score1 !== '' && score2 !== '' && score1 !== score2 : winnerId),
  );

  const run = async (work: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
      await onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not update results.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const submitCorrection = () => {
    if (inFlight.current || !basis || (!retry && !canPublish)) return;
    restoreSubmitFocus.current = document.activeElement === submitButton.current;
    // An older revision is safe only with the very same command and receipt key.
    const input: Replacement = retry ?? {
      planId: data.plan.id,
      requestId: crypto.randomUUID(),
      command: {
        kind: 'replaceResult',
        ...(roundRobin ? { roundRobinOrder } : {}),
        resultId: basis.resultId,
        reason,
        corrections: [
          {
            matchId: basis.match.id,
            expectedRevision: basis.match.revision,
            outcome,
            score1: outcome === 'played' && score1 !== '' ? score1 : null,
            score2: outcome === 'played' && score2 !== '' ? score2 : null,
            ...(outcome === 'forfeit' ? { winnerId } : {}),
          },
        ],
      },
    };
    void run(async () => {
      try {
        await trpc.eventOps.live.command.mutate(input);
      } catch (cause) {
        if (canRetryCorrection(cause)) {
          setRetry(input);
          return;
        }
        setRetry(null);
        throw cause;
      }
      setRetry(null);
      setBasis(null);
      setEditedOrder(null);
      setReason('');
    });
  };

  const selectMatch = (id: string) => {
    const selected = data.matches.find((item) => item.id === id);
    if (basis?.resultId !== publication.resultId) setEditedOrder(null);
    setBasis(
      selected ? { resultId: publication.resultId, match: selected, order: latestOrder } : null,
    );
    setScore1(selected?.score1 ?? 0);
    setScore2(selected?.score2 ?? 0);
    setOutcome(selected?.outcome === 'forfeit' ? 'forfeit' : 'played');
    setWinnerId(selected?.winnerId ?? '');
    setError('');
  };

  function acceptLatestRevision() {
    if (!latestMatch || fieldsDisabled || !published) return;
    setBasis({ resultId: publication.resultId, match: latestMatch, order: latestOrder });
    setError('');
    reasonField.current?.focus();
  }

  return (
    <section className="card native-result-correction">
      <h3>Published results and corrections</h3>
      <p>
        {published
          ? `Result revision ${publication.revision} published.`
          : publication.status === 'blocked'
            ? 'Result publication needs recovery.'
            : 'Results are sealed and publication is pending.'}{' '}
        {'ratingIntents' in data && data.ratingIntents.length > 0 ? 'Ratings are updating.' : ''}
      </p>
      {!published && !retry && (
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
          submitCorrection();
        }}
      >
        <label>
          Completed match
          <Select
            ref={matchPicker}
            value={match?.id ?? ''}
            disabled={fieldsDisabled}
            onValueChange={selectMatch}
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
                disabled={fieldsDisabled}
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
                disabled={fieldsDisabled}
              />
            ) : (
              <label>
                Forfeit winner
                <Select
                  value={winnerId}
                  onValueChange={setWinnerId}
                  disabled={fieldsDisabled}
                  required
                >
                  <SelectItem value="">Choose winner</SelectItem>
                  <SelectItem value={match.player1Id!}>{match.player1Name}</SelectItem>
                  <SelectItem value={match.player2Id!}>{match.player2Name}</SelectItem>
                </Select>
              </label>
            )}
          </>
        )}
        {roundRobin && (
          <fieldset>
            <legend>Review final finishing order</legend>
            <p>Confirm the full order, including tiebreak rulings, with this score correction.</p>
            {roundRobinOrder.map((id, i) => (
              <label key={i}>
                Place {i + 1}
                <Select
                  value={id}
                  disabled={fieldsDisabled || !basis}
                  onValueChange={(value) =>
                    setEditedOrder(roundRobinOrder.map((old, index) => (index === i ? value : old)))
                  }
                >
                  {data.entrants.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </Select>
              </label>
            ))}
          </fieldset>
        )}
        <label>
          Ruling reason
          <Textarea
            ref={reasonField}
            required
            maxLength={500}
            value={reason}
            disabled={fieldsDisabled}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {retry && (
          <Notice tone="warning">
            Could not confirm whether the correction was published. Retry to check the original
            submission.
          </Notice>
        )}
        {changed && !retry && (
          <StaleCorrectionNotice
            revision={publication.revision}
            published={published}
            match={latestMatch}
            order={
              roundRobin
                ? { previous: basis.order, latest: latestOrder, entrants: data.entrants }
                : undefined
            }
            review={acceptLatestRevision}
            reviewButton={latestReview}
            disabled={fieldsDisabled}
          />
        )}
        <Button ref={submitButton} type="submit" pending={busy} disabled={!retry && !canPublish}>
          {busy
            ? retry
              ? 'Checking submission…'
              : 'Publishing correction…'
            : retry
              ? 'Retry correction'
              : 'Publish reviewed correction'}
        </Button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}

function StaleCorrectionNotice({
  revision,
  published,
  match,
  order,
  review,
  reviewButton,
  disabled,
}: {
  revision: number;
  published: boolean;
  match?: Match;
  order?: { previous: string[]; latest: string[]; entrants: Overview['entrants'] };
  review: () => void;
  reviewButton: RefObject<HTMLButtonElement | null>;
  disabled: boolean;
}) {
  const score = match?.outcome === 'played' ? recordedScoreText(match) : null;
  const orderChanged =
    order &&
    (order.latest.length !== order.previous.length ||
      order.latest.some((id, index) => id !== order.previous[index]));
  return (
    <Notice tone="warning">
      <p>
        {published
          ? 'The published result changed while you were editing.'
          : 'A newer result is waiting to be published.'}{' '}
        Your draft is still here.
      </p>
      {match && (
        <p>
          <strong>
            {published ? 'Latest result' : 'Pending result'} · Revision {revision}
          </strong>
          <br />
          {score
            ? `${match.player1Name} ${score} ${match.player2Name}`
            : matchPresentation(match, true).result}
        </p>
      )}
      {orderChanged && (
        <>
          <p>
            <strong>Latest finishing order</strong>
          </p>
          <ol aria-label="Latest finishing order">
            {order.latest.map((id) => (
              <li key={id}>{order.entrants.find((entry) => entry.id === id)?.name ?? 'Player'}</li>
            ))}
          </ol>
        </>
      )}
      {match ? (
        <Button ref={reviewButton} disabled={disabled || !published} onClick={review}>
          Keep draft for revision {revision}
        </Button>
      ) : (
        <p>Choose a completed match from the latest revision to start a new correction.</p>
      )}
    </Notice>
  );
}
