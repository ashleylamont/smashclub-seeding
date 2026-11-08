import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Field } from '../../../components/ui/Field';
import { LoadingState, Notice } from '../../../components/ui/Feedback';
import { formatDateTime } from '../../../lib/format';
import { trpc } from '../../../lib/trpc';

type RestoreRequest = Parameters<typeof trpc.eventOps.live.restoreLegacyPoolOrder.mutate>[0];

export function LegacyPoolOrderRepair({
  planId,
  poolId,
  poolName,
  onRestored,
}: {
  planId: string;
  poolId: string;
  poolName: string;
  onRestored: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [attempt, setAttempt] = useState<{ requestId: string; reason: string }>();
  const summary = useRef<HTMLHeadingElement>(null);
  const preview = useMutation({
    mutationFn: () => trpc.eventOps.live.previewLegacyPoolOrderRepair.query({ planId, poolId }),
  });
  const restore = useMutation({
    mutationFn: (request: RestoreRequest) =>
      trpc.eventOps.live.restoreLegacyPoolOrder.mutate(request),
    onSuccess: () => {
      setOpen(false);
      onRestored();
    },
  });
  const proof = preview.data;
  const stale = restore.error instanceof TRPCClientError && restore.error.data?.code === 'CONFLICT';

  useEffect(() => {
    if (open && proof?.allowed) summary.current?.focus();
  }, [open, proof]);

  function checkJournal() {
    setAttempt(undefined);
    restore.reset();
    preview.mutate();
  }

  function apply() {
    if (!proof?.allowed || !reason.trim() || stale || restore.isPending) return;
    const intent = attempt ?? { requestId: crypto.randomUUID(), reason: reason.trim() };
    setAttempt(intent);
    restore.mutate({
      planId,
      poolId,
      ...intent,
      expectedSequence: proof.expectedSequence,
      expectedPoolRevision: proof.expectedPoolRevision,
      revisionToken: proof.revisionToken,
    });
  }

  return (
    <Dialog
      title={`${poolName} · Original order`}
      description="Restoring the verified places leaves the finals draw and all recorded results as they were."
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && !preview.data && !preview.isPending) checkJournal();
      }}
      trigger={
        <Button aria-label={`Check journal for original order in ${poolName}`}>
          Check journal for original order
        </Button>
      }
    >
      {preview.isPending && <LoadingState>Checking the event journal…</LoadingState>}
      {preview.error && <Notice tone="danger">{preview.error.message}</Notice>}
      {proof && !proof.allowed && <Notice tone="warning">{proof.reason}</Notice>}
      {proof?.allowed && (
        <>
          <h3 tabIndex={-1} ref={summary}>
            Confirmed places
          </h3>
          <p>
            {proof.evidence.confirmation.source === 'imported'
              ? 'The confirmed order was recorded at import on '
              : 'An organiser confirmed this order on '}
            {formatDateTime(new Date(proof.evidence.confirmation.at).toISOString())}. A withdrawal
            cleared it on {formatDateTime(new Date(proof.evidence.withdrawal.at).toISOString())}.
          </p>
          <ol>
            {proof.places.map(({ place, name }) => (
              <li key={place}>{name}</li>
            ))}
          </ol>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              apply();
            }}
          >
            <Field
              label="Reason for restoration"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={200}
              required
              disabled={Boolean(attempt)}
            />
            {restore.error && <Notice tone="danger">{restore.error.message}</Notice>}
            <div className="modal-actions">
              {stale ? (
                <Button onClick={checkJournal}>Check journal again</Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!reason.trim()}
                  pending={restore.isPending}
                >
                  {restore.isPending
                    ? 'Restoring…'
                    : attempt
                      ? 'Retry restoration'
                      : 'Restore original order'}
                </Button>
              )}
            </div>
          </form>
        </>
      )}
      {preview.error && <Button onClick={checkJournal}>Check journal again</Button>}
    </Dialog>
  );
}
