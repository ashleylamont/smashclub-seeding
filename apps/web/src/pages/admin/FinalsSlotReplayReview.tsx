import { useCallback, useEffect, useRef, useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Feedback';
import { useConfirmation } from '../../lib/confirmation';
import { qualifierLabel } from '../../lib/qualification';
import { trpc } from '../../lib/trpc';
import { UntakenCallRecovery, type UntakenCallDesk } from './UntakenCallRecovery';

type Input = Parameters<typeof trpc.eventOps.live.previewFinalsSlotReplay.query>[0];
type Preview = Awaited<ReturnType<typeof trpc.eventOps.live.previewFinalsSlotReplay.query>>;
type Consolation = NonNullable<Extract<Preview, { original: object }>['companion']>;

export function FinalsSlotReplayReview({
  score,
  callDesk,
  stale,
  disabled,
  act,
  close,
}: {
  score: Input;
  callDesk?: UntakenCallDesk;
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
  const reviewButton = useRef<HTMLButtonElement>(null);
  const restoreReviewFocus = useRef(false);
  const openedCall = useRef<string | null>(null);
  useEffect(() => {
    if (preview) summary.current?.focus();
  }, [preview]);
  useEffect(() => {
    if (busy || disabled) return;
    if (restoreReviewFocus.current) {
      restoreReviewFocus.current = false;
      reviewButton.current?.focus();
      return;
    }
    if (!openedCall.current || stale || !callDesk) return;
    if (callDesk.calls.some(({ id }) => id === openedCall.current)) return;
    openedCall.current = null;
    if (document.activeElement === document.body) reviewButton.current?.focus();
  }, [busy, callDesk, disabled, stale]);
  const callIds =
    preview && 'returnCallMatchIds' in preview ? (preview.returnCallMatchIds ?? []) : [];
  const callsStillOpen = callDesk?.calls.some(({ id }) => callIds.includes(id));
  const openRecoveryCall = useCallback(
    (id: string) => {
      openedCall.current = id;
      callDesk?.open(id);
    },
    [callDesk],
  );
  const canOpenCall = callDesk && !disabled && !stale && !busy;
  const placement = preview?.allowed && 'poolPlacementCorrection' in preview ? preview : null;
  const replay = preview?.allowed && 'original' in preview ? preview : null;
  const names = preview?.entrantNames;
  const name = (id: string | null) => (id ? (names?.[id] ?? 'Player') : 'No entrant');
  const review = async () => {
    setBusy(true);
    setError('');
    setPreview(undefined);
    try {
      setPreview(
        await trpc.eventOps.live.previewFinalsSlotReplay.query({ ...score, reviewVersion: 3 }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not review the finals replay.');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    const recordedReason = reason.trim();
    if (
      !preview?.allowed ||
      (replay && !recordedReason) ||
      (stale && !requestId) ||
      busy ||
      disabled
    )
      return;
    if (
      !requestId &&
      !(await confirm(
        placement
          ? 'Apply the corrected pool score and use these finishing places with the recorded finals draw?'
          : replay?.companion
            ? 'Correct the pool result, create the championship replay and update the unplayed consolation pairing? The original played score stays on record. Each route advances from its updated pairing.'
            : 'Correct the pool result and create the reviewed replay? The original played score stays on record. Only the replay will advance in the bracket.',
      ))
    )
      return;
    const scoreChange = {
      matchId: score.matchId,
      expectedRevision: score.expectedRevision,
      score1: score.score1,
      score2: score.score2,
    };
    const id = requestId ?? crypto.randomUUID();
    setRequestId(id);
    setBusy(true);
    try {
      await act(
        async () => {
          try {
            await trpc.eventOps.live.command.mutate({
              planId: score.planId,
              requestId: id,
              command: placement
                ? {
                    ...scoreChange,
                    kind: 'score',
                    outcome: 'played',
                    poolGameCorrectionToken: preview.revisionToken,
                  }
                : {
                    ...scoreChange,
                    kind: replay?.companion ? 'replayFinalsRoutesV2' : 'replayFinalsSlotV1',
                    revisionToken: preview.revisionToken,
                    reason: recordedReason,
                  },
            });
            close();
          } catch (cause) {
            // Retry the same reviewed command after an uncertain response.
            if (cause instanceof TRPCClientError && cause.data?.code === 'CONFLICT') {
              restoreReviewFocus.current = Boolean(placement || replay?.companion);
              setRequestId(undefined);
              setPreview(undefined);
            }
            throw cause;
          }
        },
        placement
          ? 'Pool score and finishing order corrected'
          : replay?.companion
            ? 'Pool score corrected · championship replay created and consolation pairing updated'
            : 'Pool score corrected · replay pairing created',
      );
    } finally {
      setBusy(false);
    }
  };
  const [applyLabel, retryLabel, savingLabel] = correctionActionLabels(
    Boolean(placement),
    Boolean(replay?.companion),
  );
  return (
    <>
      {!placement && <p>Changing this winner requires a review of the affected finals draw.</p>}
      {error && <Notice tone="danger">{error}</Notice>}
      {preview && (
        <section
          className="ops-finals-replay-review"
          aria-label={placement ? 'Pool placement correction review' : 'Finals replay review'}
          data-multiple-places={preview.qualifierChanges.length > 1 ? '' : undefined}
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
          {placement && (
            <>
              <h4>Pool finishing order</h4>
              {placement.changes.length ? (
                <ul>
                  {placement.changes.map(({ entrantId, beforePlace, afterPlace }) => (
                    <li key={entrantId}>
                      {name(entrantId)} ·{' '}
                      <span className="mono">
                        {beforePlace}&nbsp;→&nbsp;{afterPlace}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>The corrected score confirms the recorded pool places.</p>
              )}
              <p>These pool places fit the recorded finals draw.</p>
            </>
          )}
          {replay && (
            <>
              <h4>{replay.original.label}</h4>
              <p>
                <strong>Played set kept in history</strong> · {name(replay.original.player1Id)}{' '}
                {replay.original.score1}–{replay.original.score2} {name(replay.original.player2Id)}
              </p>
              <p>
                <strong>Replay pairing</strong> · {name(replay.replay.player1Id)} vs{' '}
                {name(replay.replay.player2Id)}
              </p>
              {replay.downstream.length > 0 && (
                <p>
                  <strong>Waiting for the replay</strong> ·{' '}
                  {replay.downstream.map(({ label }) => label).join(', ')}
                </p>
              )}
              {replay.companion && <ConsolationReview pairing={replay.companion} name={name} />}
              <p>
                {replay.companion
                  ? 'Eligible played sets count for ratings. Each route advances from its updated pairing.'
                  : 'Eligible played sets count for ratings. Only the replay advances in the draw.'}
              </p>
              <Field
                label="Reason for replay"
                value={reason}
                maxLength={500}
                disabled={busy || Boolean(requestId)}
                onChange={(event) => setReason(event.target.value)}
              />
            </>
          )}
          {!preview.allowed && (
            <>
              {canOpenCall && callIds.length && !callsStillOpen ? (
                <p className="muted">Refresh the finals review before continuing.</p>
              ) : (
                <Notice tone="warning">
                  {canOpenCall && callsStillOpen
                    ? 'Return this call, then refresh the finals review.'
                    : preview.issues.join(' ')}
                </Notice>
              )}
              {canOpenCall && (
                <UntakenCallRecovery
                  matchIds={callIds}
                  desk={{ ...callDesk, open: openRecoveryCall }}
                  showInstructions={false}
                />
              )}
            </>
          )}
        </section>
      )}
      <div className="ops-match-actions">
        {preview?.allowed && (
          <Button
            variant="primary"
            disabled={disabled || (!requestId && stale) || Boolean(replay && !reason.trim())}
            pending={busy}
            onClick={() => void apply()}
          >
            {busy ? savingLabel : requestId ? retryLabel : applyLabel}
          </Button>
        )}
        {!requestId && (
          <Button
            ref={reviewButton}
            disabled={disabled || stale || busy}
            onClick={() => void review()}
          >
            {busy ? 'Reviewing…' : reviewLabel(Boolean(preview), Boolean(placement))}
          </Button>
        )}
      </div>
    </>
  );
}

function correctionActionLabels(placement: boolean, companion: boolean) {
  return placement
    ? ['Correct pool score', 'Retry correction', 'Saving correction…']
    : [
        companion ? 'Correct score and update both routes' : 'Correct score and create replay',
        'Retry replay',
        'Saving replay…',
      ];
}

function reviewLabel(hasPreview: boolean, placement: boolean) {
  if (placement) return 'Refresh pool review';
  return hasPreview ? 'Refresh finals review' : 'Review finals replay';
}

function ConsolationReview({
  pairing,
  name,
}: {
  pairing: Consolation;
  name: (id: string | null) => string;
}) {
  const first = pairing.changedSide === 'player1' ? pairing.afterEntrantId : pairing.player1Id;
  const second = pairing.changedSide === 'player2' ? pairing.afterEntrantId : pairing.player2Id;
  return (
    <>
      <h4>{pairing.label}</h4>
      <p>
        <strong>Unplayed consolation pairing</strong> · {name(pairing.player1Id)} vs{' '}
        {name(pairing.player2Id)}
      </p>
      <p>
        <strong>Updated consolation pairing</strong> · {name(first)} vs {name(second)}
      </p>
      {pairing.downstream.length > 0 && (
        <p>
          <strong>Waiting for consolation result</strong> ·{' '}
          {pairing.downstream.map(({ label }) => label).join(', ')}
        </p>
      )}
    </>
  );
}
