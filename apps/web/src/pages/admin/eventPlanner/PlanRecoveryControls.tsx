import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../../lib/trpc';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Checkbox } from '../../../components/ui/Checkbox';
import { useConfirmation } from '../../../lib/confirmation';

export function PlanRecoveryControls({
  planId,
  name,
  deleteOnly = false,
  onReopened,
  onDeleted,
}: {
  planId: string;
  name: string;
  deleteOnly?: boolean;
  onReopened?: (planId: string) => void;
  onDeleted: () => void;
}) {
  const [operation, setOperation] = useState<'reset' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  const [withdrawResults, setWithdrawResults] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const confirmAction = useConfirmation();
  const preview = useQuery({
    queryKey: ['admin', 'eventPlanner', 'recovery', planId],
    queryFn: () => trpc.admin.eventPlanner.recoveryPreview.query({ planId }),
    enabled: operation !== null,
  });
  const recover = useMutation({
    mutationFn: (requestId: string) =>
      trpc.admin.eventPlanner.recoverPlan.mutate({
        planId,
        operation: operation!,
        token: preview.data!.token,
        reason: reason.trim(),
        withdrawResults,
        requestId,
      }),
    onSuccess: (result) => {
      setOperation(null);
      if (result.replacementPlanId) onReopened?.(result.replacementPlanId);
      else onDeleted();
    },
    onError: () => {
      void preview.refetch();
    },
  });
  return (
    <div className={deleteOnly ? undefined : 'card section'}>
      {!deleteOnly && <h3>Reset or delete this event</h3>}
      {!operation && (
        <span className="row-actions">
          {!deleteOnly && (
            <Button size="small" onClick={() => setOperation('reset')}>
              Revert to draft
            </Button>
          )}
          <Button
            size="small"
            aria-label={`Delete plan ${name}`}
            onClick={() => setOperation('delete')}
          >
            Delete
          </Button>
        </span>
      )}
      {operation && (
        <section aria-label="Review event recovery">
          <h4>{operation === 'reset' ? 'Revert to a fresh draft' : 'Delete event plan'}</h4>
          <p>
            The old live draw will close and disappear from the planner and event-night list. Its
            audit record is retained.
          </p>
          {operation === 'reset' && (
            <p>
              The new draft keeps the current roster and event settings. Review the roster and
              freeze new seeds before play. Old links and score forms will not affect the new draw.
            </p>
          )}
          {preview.isPending && <p className="loading-text">Checking this event…</p>}
          {preview.isError && <p className="error-text">{preview.error.message}</p>}
          {preview.data && (
            <>
              <p>
                {preview.data.entrants} entrants · {preview.data.recordedMatches} started or
                recorded matches · {preview.data.pendingReports} pending reports ·{' '}
                {preview.data.publishedBrackets} published result brackets
              </p>
              <p>
                Unpublished scores and pending reports will leave the live event. They remain in its
                audit record.
              </p>
              {preview.data.hasSealedResults && (
                <label>
                  <Checkbox checked={withdrawResults} onCheckedChange={setWithdrawResults} /> Also
                  withdraw published results from public history and ratings
                </label>
              )}
              {preview.data.hasSealedResults && (
                <p className="muted">
                  {withdrawResults
                    ? 'All published revisions will be withdrawn. Rating recalculation is queued automatically.'
                    : 'Published results and their rating impact will be retained.'}
                </p>
              )}
              {preview.data.linkedExternalBrackets > 0 && (
                <p>Linked Challonge tournaments and their results will be retained.</p>
              )}
              <label className="form-field">
                <span className="form-label">
                  Reason for {operation === 'reset' ? 'reset' : 'deletion'}
                </span>
                <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </label>
              <span className="row-actions">
                <Button
                  disabled={!reason.trim() || recover.isPending || preview.isFetching}
                  onClick={async () => {
                    if (
                      await confirmAction(
                        `${operation === 'reset' ? 'Revert' : 'Delete'} “${name}”? ${withdrawResults ? 'Published results and their rating impact will be removed.' : 'Published results will be kept.'} The old live draw will close.`,
                      )
                    )
                      recover.mutate(requestId);
                  }}
                >
                  {operation === 'reset' ? 'Confirm revert to draft' : 'Confirm delete event'}
                </Button>
                <Button disabled={recover.isPending} onClick={() => setOperation(null)}>
                  Keep this plan
                </Button>
              </span>
            </>
          )}
          {recover.isError && (
            <p role="alert" className="error-text">
              {recover.error.message}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

export function DeletePlanButton({ planId, name }: { planId: string; name: string }) {
  const queryClient = useQueryClient();
  return (
    <PlanRecoveryControls
      planId={planId}
      name={name}
      deleteOnly
      onDeleted={() => {
        void queryClient.invalidateQueries({ queryKey: ['admin', 'eventPlanner'] });
      }}
    />
  );
}
