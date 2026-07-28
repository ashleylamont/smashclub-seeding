import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import type { ReviewCandidate, ReviewItem } from '../../lib/apiTypes';
import { timeAgo } from '../../lib/format';

type Resolution =
  | { kind: 'linked_existing'; playerId: string }
  | { kind: 'created_new' }
  | { kind: 'kept_separate' };

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

  const resolve = useMutation({
    mutationFn: (resolution: Resolution) =>
      trpc.admin.resolveReview.mutate({ reviewItemId: item.id, resolution }),
    onSuccess: onResolved,
  });

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
        <button
          type="button"
          className="btn btn-small btn-primary"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ kind: 'created_new' })}
        >
          Create new player
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ kind: 'kept_separate' })}
          title="Reject all candidates and create a separate player"
        >
          Keep separate
        </button>
        {resolve.isError && <span className="error-text">{resolve.error.message}</span>}
      </div>
    </div>
  );
}
