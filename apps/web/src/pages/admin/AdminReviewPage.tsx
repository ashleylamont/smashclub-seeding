import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import type { ReviewCandidate, ReviewItem } from '../../lib/apiTypes';
import { timeAgo } from '../../lib/format';
import { PlayerFormModal, type PlayerFormValues } from '../../components/PlayerFormModal';
import { PlayerLookupModal } from '../../components/PlayerLookupModal';

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

  /**
   * Candidates are a snapshot taken when sync queued the item, so anything
   * that happened to the registry since — a player created, renamed, merged —
   * is invisible until they are re-scored. Every mutation that can change the
   * answer does that automatically; this is the manual escape hatch for
   * anything that changed the database some other way.
   */
  const recompute = useMutation({
    mutationFn: () => trpc.admin.recomputeReviewCandidates.mutate({}),
    onSuccess: invalidate,
  });

  if (queue.isPending) return <p className="loading-text">Loading review queue…</p>;
  if (queue.isError) return <p className="error-text">{queue.error.message}</p>;

  return (
    <div>
      <div className="page-header">
        <h2>Identity review queue</h2>
        <span className="admin-form-row">
          <span className="muted">{queue.data.length} pending</span>
          {queue.data.length > 0 && (
            <button
              type="button"
              className="btn btn-small"
              disabled={recompute.isPending}
              onClick={() => recompute.mutate()}
              title="Re-score every pending item against the registry as it is now"
            >
              {recompute.isPending ? 'Recomputing…' : 'Recompute candidates'}
            </button>
          )}
          {recompute.isError && <span className="error-text">{recompute.error.message}</span>}
        </span>
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
  const [lookingUp, setLookingUp] = useState(false);

  const companies = useQuery({
    queryKey: ['admin', 'companies'],
    queryFn: () => trpc.admin.companies.query(),
  });

  const resolve = useMutation({
    mutationFn: (resolution: Resolution) =>
      trpc.admin.resolveReview.mutate({ reviewItemId: item.id, resolution }),
    onSuccess: () => {
      setDetailKind(null);
      setLookingUp(false);
      onResolved();
    },
  });

  const recomputeItem = useMutation({
    mutationFn: () => trpc.admin.recomputeReviewCandidates.mutate({ reviewItemId: item.id }),
    onSuccess: onResolved,
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
          {item.tournamentName} · queued {timeAgo(item.createdAt)}
          {candidates.length > 0 && <> · candidates scored {timeAgo(item.candidatesComputedAt)}</>}
        </span>
      </div>

      {candidates.length === 0 ? (
        <p className="muted">
          No candidates as of {timeAgo(item.candidatesComputedAt)} — probably a brand new player.{' '}
          <button
            type="button"
            className="btn btn-small"
            disabled={recomputeItem.isPending}
            onClick={() => recomputeItem.mutate()}
            title="Re-score this item against the registry as it is now"
          >
            {recomputeItem.isPending ? 'Recomputing…' : 'Recompute'}
          </button>
        </p>
      ) : (
        <ul className="candidate-list">
          {candidates.map((candidate) => (
            <li key={candidate.playerId} className="candidate-row">
              <span className="candidate-name">
                {candidate.name}
                {candidate.companyCode && <span className="muted"> ({candidate.companyCode})</span>}
                {candidate.matchedAlias && <span className="muted"> via “{candidate.matchedAlias}”</span>}
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
          onClick={() => setLookingUp(true)}
          title="Search the registry for the player this entry belongs to"
        >
          Find a player…
        </button>
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

      {lookingUp && (
        <PlayerLookupModal
          title={`Link “${item.cleanedName}” to a player`}
          candidatePlayerIds={candidates.map((candidate) => candidate.playerId)}
          busy={resolve.isPending}
          error={resolve.error?.message ?? null}
          onPick={(playerId) => resolve.mutate({ kind: 'linked_existing', playerId })}
          onCancel={() => setLookingUp(false)}
        >
          <p className="muted">
            From “{item.rawName}” in {item.tournamentName}. Linking records the decision and aliases this
            spelling to the player you pick, so the same entry matches silently next time.
          </p>
        </PlayerLookupModal>
      )}

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
