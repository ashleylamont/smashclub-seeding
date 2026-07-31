import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import type { ReviewCandidate, ReviewItem } from '../../lib/apiTypes';
import { timeAgo } from '../../lib/format';
import { PlayerFormModal, type PlayerFormValues } from '../../components/PlayerFormModal';

/** Details the reviewer may attach when a resolution mints a new player. */
interface NewPlayerDetails {
  canonicalName?: string;
  displayName?: string | null;
  companyCode?: string | null;
  characters?: string[];
}

type Resolution =
  | { kind: 'linked_existing'; playerId: string }
  | { kind: 'created_new'; details?: NewPlayerDetails }
  | { kind: 'kept_separate'; details?: NewPlayerDetails };

/** Which resolution the detail form is currently standing in for. */
type DetailKind = 'created_new' | 'kept_separate';

export function AdminReviewPage() {
  const queryClient = useQueryClient();
  const queue = useQuery({
    queryKey: ['admin', 'reviewQueue'],
    queryFn: () => trpc.admin.reviewQueue.query(),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'reviewQueue'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'players'] });
  };

  if (queue.isPending) return <p className="loading-text">Loading review queue…</p>;
  if (queue.isError) return <p className="error-text">{queue.error.message}</p>;

  return (
    <div>
      <div className="page-header">
        <h2>Identity review queue</h2>
        <span className="muted">{queue.data.length} pending</span>
      </div>
      {queue.data.length === 0 ? (
        <p className="muted">All clear — no unresolved participant names. 🎉</p>
      ) : (
        <div className="review-list">
          {queue.data.map((item) => (
            <ReviewCard key={item.id} item={item} onResolved={invalidate} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewCard({ item, onResolved }: { item: ReviewItem; onResolved: () => void }) {
  const candidates = (item.candidates as ReviewCandidate[] | null) ?? [];
  const [detailKind, setDetailKind] = useState<DetailKind | null>(null);

  const companies = useQuery({
    queryKey: ['admin', 'companies'],
    queryFn: () => trpc.admin.companies.query(),
  });

  const resolve = useMutation({
    mutationFn: (resolution: Resolution) =>
      trpc.admin.resolveReview.mutate({ reviewItemId: item.id, resolution }),
    onSuccess: () => {
      setDetailKind(null);
      onResolved();
    },
  });

  const submitDetails = (values: PlayerFormValues) => {
    if (!detailKind) return;
    resolve.mutate({
      kind: detailKind,
      details: {
        canonicalName: values.canonicalName,
        displayName: values.displayName === '' ? null : values.displayName,
        companyCode: values.companyCode === '' ? null : values.companyCode,
        characters: values.characters,
      },
    });
  };

  return (
    <div className="card review-card">
      <div className="review-card-header">
        <div>
          <span className="review-name">{item.cleanedName}</span>
          {item.companyCode && <span className="chip">{item.companyCode}</span>}
          {item.rawName !== item.cleanedName && <span className="muted"> raw: “{item.rawName}”</span>}
        </div>
        <span className="muted">
          {item.tournamentName} · {timeAgo(item.createdAt)}
        </span>
      </div>

      {candidates.length === 0 ? (
        <p className="muted">No candidates — probably a brand new player.</p>
      ) : (
        <ul className="candidate-list">
          {candidates.map((candidate) => (
            <li key={candidate.playerId} className="candidate-row">
              <span className="candidate-name">
                {candidate.name}
                {candidate.companyCode && <span className="muted"> ({candidate.companyCode})</span>}
              </span>
              <span className={`chip reason-${candidate.reason}`}>{candidate.reason}</span>
              <span className="score-bar" title={`score ${(candidate.score * 100).toFixed(0)}%`}>
                <span className="score-bar-fill" style={{ width: `${Math.min(100, candidate.score * 100)}%` }} />
              </span>
              <span className="score-value">{(candidate.score * 100).toFixed(0)}%</span>
              <button
                type="button"
                className="btn btn-small"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ kind: 'linked_existing', playerId: candidate.playerId })}
              >
                Link
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="review-actions">
        {/* None of the three outcomes is the default one, so none gets the filled
            accent — with a queue this long it would just be red everywhere.
            Each opens the detail form, which carries a "create as-is" escape so
            working the queue at speed still costs a single extra click. */}
        <button
          type="button"
          className="btn btn-small"
          disabled={resolve.isPending}
          onClick={() => setDetailKind('created_new')}
        >
          Create new player…
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={resolve.isPending}
          onClick={() => setDetailKind('kept_separate')}
          title="Reject all candidates and create a separate player"
        >
          Keep separate…
        </button>
        {resolve.isError && <span className="error-text">{resolve.error.message}</span>}
      </div>

      {detailKind && (
        <PlayerFormModal
          title={detailKind === 'created_new' ? 'Create new player' : 'Keep separate — new player'}
          submitLabel={detailKind === 'created_new' ? 'Create player' : 'Keep separate'}
          companies={companies.data ?? []}
          initial={{
            canonicalName: item.cleanedName,
            companyCode: item.companyCode ?? '',
          }}
          busy={resolve.isPending}
          error={resolve.error?.message ?? null}
          secondary={{
            label: detailKind === 'created_new' ? 'Create as-is' : 'Keep separate as-is',
            onClick: () => resolve.mutate({ kind: detailKind }),
          }}
          onCancel={() => setDetailKind(null)}
          onSubmit={submitDetails}
        >
          <p className="muted">
            From “{item.rawName}” in {item.tournamentName}.
            {detailKind === 'kept_separate' &&
              ' The offered candidates are recorded as rejected, so this pairing is never suggested again.'}{' '}
            The bracket's own spelling stays aliased to this player whatever you name them here.
          </p>
        </PlayerFormModal>
      )}
    </div>
  );
}
