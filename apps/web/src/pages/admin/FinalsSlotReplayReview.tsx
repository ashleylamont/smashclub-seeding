import { useEffect, useRef, useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Feedback';
import { useConfirmation } from '../../lib/confirmation';
import { qualifierLabel } from '../../lib/qualification';
import { trpc } from '../../lib/trpc';

type Input = Parameters<typeof trpc.eventOps.live.previewFinalsSlotReplay.query>[0];
type Preview = Awaited<ReturnType<typeof trpc.eventOps.live.previewFinalsSlotReplay.query>>;

export function FinalsSlotReplayReview({
  score,
  stale,
  disabled,
  act,
  close,
}: {
  score: Input;
  stale: boolean;
  disabled: boolean;
  act: (work: () => Promise<unknown>, message?: string) => Promise<void>;
  close: () => void;
}) {
  const confirm = useConfirmation();
  const [preview, setPreview] = useState<Preview>();
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    if (preview) summary.current?.focus();
  }, [preview]);
  const names = preview?.entrantNames;
  const name = (id: string | null) => (id ? (names?.[id] ?? 'Player') : 'No entrant');
  const review = async () => {
    setBusy(true);
    setError('');
    setPreview(undefined);
    try {
      setPreview(await trpc.eventOps.live.previewFinalsSlotReplay.query(score));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not review the finals replay.');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    const recordedReason = reason.trim();
    if (!preview?.allowed || !recordedReason || (stale && !requestId) || busy || disabled) return;
    if (
      !requestId &&
      !(await confirm(
        'Correct the pool result and create the reviewed replay? The original played score stays on record. Only the replay will advance in the bracket.',
      ))
    )
      return;
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    setBusy(true);
    try {
      await act(async () => {
        try {
          await trpc.eventOps.live.command.mutate({
            planId: score.planId,
            requestId: id,
            command: {
              kind: 'replayFinalsSlotV1',
              matchId: score.matchId,
              expectedRevision: score.expectedRevision,
              score1: score.score1,
              score2: score.score2,
              revisionToken: preview.revisionToken,
              reason: recordedReason,
            },
          });
          close();
        } catch (cause) {
          // Retry the same reviewed command after an uncertain response.
          if (cause instanceof TRPCClientError && cause.data?.code === 'CONFLICT') {
            setRequestId(undefined);
            setPreview(undefined);
          }
          throw cause;
        }
      }, 'Pool score corrected · replay pairing created');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p>Changing this winner requires a review of the affected finals draw.</p>
      {error && <Notice tone="danger">{error}</Notice>}
      {preview && (
        <section
          className="ops-finals-replay-review"
          aria-label="Finals replay review"
          tabIndex={-1}
          ref={summary}
        >
          {preview.qualifierChanges.length > 0 && (
            <>
              <h4>Changed finals places</h4>
              <ul>
                {preview.qualifierChanges.map((change) => (
                  <li key={`${change.bracketId}:${change.poolId}:${change.place}`}>
                    {change.stage === 'main' ? 'Championship' : 'Consolation'} ·{' '}
                    {qualifierLabel(change)} · {name(change.beforeEntrantId)} →{' '}
                    {name(change.afterEntrantId)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {preview.allowed ? (
            <>
              <h4>{preview.original.label}</h4>
              <p>
                <strong>Played set kept in history</strong> · {name(preview.original.player1Id)}{' '}
                {preview.original.score1}–{preview.original.score2}{' '}
                {name(preview.original.player2Id)}
              </p>
              <p>
                <strong>Replay pairing</strong> · {name(preview.replay.player1Id)} vs{' '}
                {name(preview.replay.player2Id)}
              </p>
              {preview.downstream.length > 0 && (
                <p>
                  <strong>Waiting for the replay</strong> ·{' '}
                  {preview.downstream.map(({ label }) => label).join(', ')}
                </p>
              )}
              <p>Eligible played sets count for ratings. Only the replay advances in the draw.</p>
              <Field
                label="Reason for replay"
                value={reason}
                maxLength={500}
                disabled={busy || Boolean(requestId)}
                onChange={(event) => setReason(event.target.value)}
              />
            </>
          ) : (
            <Notice tone="warning">{preview.issues.join(' ')}</Notice>
          )}
        </section>
      )}
      <div className="ops-match-actions">
        {preview?.allowed && (
          <Button
            variant="primary"
            disabled={disabled || (!requestId && stale) || !reason.trim()}
            pending={busy}
            onClick={() => void apply()}
          >
            {busy
              ? 'Saving replay…'
              : requestId
                ? 'Retry replay'
                : 'Correct score and create replay'}
          </Button>
        )}
        {!requestId && (
          <Button disabled={disabled || stale || busy} onClick={() => void review()}>
            {busy ? 'Reviewing…' : preview ? 'Refresh finals review' : 'Review finals replay'}
          </Button>
        )}
      </div>
    </>
  );
}
