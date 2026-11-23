import { ConfirmDialog, ConfirmCancel } from '../../components/ui/ConfirmDialog';
import { Disclosure } from '../../components/ui/Disclosure';
import { Select, SelectItem } from '../../components/ui/Select';
import { Button } from '../../components/ui/Button';
import { useId, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { trpc } from '../../lib/trpc';
import type { SeedingEntry, SeedingPushLog, SeedingRunData } from '../../lib/apiTypes';
import { formatDateTime } from '../../lib/format';

export function AdminSeedingPage() {
  const tournaments = useQuery({
    queryKey: ['tournaments'],
    queryFn: () => trpc.public.tournaments.query(),
  });
  const [tournamentId, setTournamentId] = useState('');

  const seedable = useMemo(
    () => (tournaments.data ?? []).filter((t) => t.challongeState !== 'complete'),
    [tournaments.data],
  );

  return (
    <div>
      <div className="card section">
        <h2>Seeding workbench</h2>
        <p className="muted">
          Generate automatic seeds from the latest published ratings, adjust the order, then push it
          to Challonge.
        </p>
        <div className="admin-form-row" style={{ marginTop: 10 }}>
          <Select
            aria-label="Tournament to seed"
            value={tournamentId}
            onValueChange={setTournamentId}
          >
            <SelectItem value="">Pick a tournament…</SelectItem>
            {seedable.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </Select>
        </div>
        {tournaments.isError && <p className="error-text">{tournaments.error.message}</p>}
        {!tournaments.isPending && seedable.length === 0 && (
          <p className="muted">No open tournaments — register one first.</p>
        )}
      </div>

      {tournamentId !== '' && <SeedingWorkbench key={tournamentId} tournamentId={tournamentId} />}
    </div>
  );
}

function SeedingWorkbench({ tournamentId }: { tournamentId: string }) {
  const queryClient = useQueryClient();
  const runQuery = useQuery({
    queryKey: ['admin', 'seedingRun', tournamentId],
    queryFn: () => trpc.admin.seedingRun.query({ tournamentId }),
  });

  const invalidateRun = () =>
    void queryClient.invalidateQueries({ queryKey: ['admin', 'seedingRun', tournamentId] });

  const generate = useMutation({
    mutationFn: () => trpc.admin.createSeedingRun.mutate({ tournamentId }),
    onSuccess: invalidateRun,
  });

  if (runQuery.isPending) return <p className="loading-text">Loading seeding run…</p>;
  if (runQuery.isError) return <p className="error-text">{runQuery.error.message}</p>;

  const data = runQuery.data;

  if (data === null) {
    return (
      <div className="card">
        <p className="muted">No seeding run for this tournament yet.</p>
        <div style={{ marginTop: 10 }}>
          <Button
            variant="primary"
            type="button"
            disabled={generate.isPending}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? 'Generating…' : 'Generate seeding'}
          </Button>
        </div>
        {generate.isError && <p className="error-text">{generate.error.message}</p>}
      </div>
    );
  }

  return (
    <SeedingRun
      data={data}
      onRegenerate={() => generate.mutate()}
      regenerating={generate.isPending}
      regenerateError={generate.error?.message ?? null}
      onChanged={invalidateRun}
    />
  );
}

function SeedingRun({
  data,
  onRegenerate,
  regenerating,
  regenerateError,
  onChanged,
}: {
  data: SeedingRunData;
  onRegenerate: () => void;
  regenerating: boolean;
  regenerateError: string | null;
  onChanged: () => void;
}) {
  const { run, ratingSnapshot, entries } = data;
  const usesWhr = ratingSnapshot?.model === 'whr';
  const serverOrder = useMemo(() => entries.map((e) => e.participantId), [entries]);
  const [order, setOrder] = useState<string[]>(serverOrder);
  const [lastServerOrder, setLastServerOrder] = useState<string[]>(serverOrder);
  const [confirmingPush, setConfirmingPush] = useState(false);
  const [pushResult, setPushResult] = useState<(SeedingPushLog & { pushed: number }) | null>(null);

  // Re-sync local order whenever the server entries change (render-time adjustment).
  if (serverOrder !== lastServerOrder) {
    setLastServerOrder(serverOrder);
    setOrder(serverOrder);
  }

  const byParticipant = useMemo(() => new Map(entries.map((e) => [e.participantId, e])), [entries]);
  const lockedIds = useMemo(
    () => new Set(entries.filter((e) => e.locked).map((e) => e.participantId)),
    [entries],
  );

  const reorder = useMutation({
    mutationFn: (participantIdsInOrder: string[]) =>
      trpc.admin.reorderSeedingRun.mutate({ runId: run.id, participantIdsInOrder }),
    onSuccess: onChanged,
    // Roll the optimistic local order back if the server rejects it.
    onError: () => setOrder(serverOrder),
  });

  const push = useMutation({
    mutationFn: () => trpc.admin.pushSeedingRun.mutate({ runId: run.id }),
    onSuccess: (result) => {
      setConfirmingPush(false);
      setPushResult(result);
      onChanged();
    },
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(String(active.id));
    const newIndex = order.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    const next = enforceLocks(order, arrayMove(order, oldIndex, newIndex), lockedIds);
    setOrder(next);
    reorder.mutate(next);
  };

  const storedPushLog = run.pushLog as SeedingPushLog | null;
  const draggable = run.status === 'draft';

  return (
    <div className="card">
      {run.status === 'pushed' && (
        <div className="banner banner-success">
          Seeds pushed to Challonge {run.pushedAt ? `at ${formatDateTime(run.pushedAt)}` : ''}
          {storedPushLog
            ? storedPushLog.verified
              ? ' — verified ✓'
              : ' — verification FAILED'
            : ''}
          . Generate a new run to reseed.
        </div>
      )}
      {run.status === 'stale' && (
        <div className="banner banner-warning">
          This run is stale — the participant list changed since it was generated. Regenerate before
          pushing.
        </div>
      )}
      {pushResult && (
        <div className={`banner ${pushResult.verified ? 'banner-success' : 'banner-danger'}`}>
          Pushed {pushResult.pushed}/{order.length} seeds.{' '}
          {pushResult.verified
            ? 'Challonge verified the new order ✓'
            : 'Verification failed — check Challonge.'}
          {pushResult.log.some((l) => !l.ok) && (
            <ul>
              {pushResult.log
                .filter((l) => !l.ok)
                .map((l) => (
                  <li key={l.participantId}>
                    seed {l.seed}: {l.error ?? 'failed'}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      <div className="page-header">
        <h3>
          Run from {formatDateTime(run.createdAt)} <span className="chip">{run.status}</span>
        </h3>
        <span className="row-actions">
          {(run.status === 'stale' || run.status === 'pushed') && (
            <Button type="button" disabled={regenerating} onClick={onRegenerate}>
              {regenerating
                ? 'Generating…'
                : run.status === 'pushed'
                  ? 'Generate new run'
                  : 'Regenerate'}
            </Button>
          )}
          <Button
            variant="primary"
            type="button"
            disabled={run.status !== 'draft' || push.isPending}
            onClick={() => setConfirmingPush(true)}
            title={
              run.status !== 'draft'
                ? 'Only draft runs can be pushed'
                : 'Push these seeds to Challonge'
            }
          >
            Push to Challonge
          </Button>
        </span>
      </div>
      {regenerateError && <p className="error-text">{regenerateError}</p>}
      {reorder.isError && <p className="error-text">Reorder failed: {reorder.error.message}</p>}
      {push.isError && <p className="error-text">Push failed: {push.error.message}</p>}

      <p className="muted">
        {ratingSnapshot ? (
          <>
            {usesWhr ? 'WHR rating snapshot' : 'Rating snapshot'} published{' '}
            <time dateTime={ratingSnapshot.publishedAt}>
              {formatDateTime(ratingSnapshot.publishedAt)}
            </time>
            .
          </>
        ) : (
          'No saved rating snapshot is available for this run.'
        )}
      </p>
      <Disclosure title="How automatic seeds are calculated">
        {usesWhr && (
          <p>
            Conservative score is the skill estimate minus twice its uncertainty. The leaderboard
            ranks by club rating, which subtracts the attendance penalty from the skill estimate.
            Displayed values are rounded.
          </p>
        )}
        <p>
          Entrants without a rating score follow rated entrants in alphabetical order. The automatic
          seed stays recorded when the bracket seed is adjusted.
        </p>
      </Disclosure>

      <p className="muted seeding-scroll-hint">Scroll sideways to see all seed columns.</p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="table-scroll" role="region" aria-label="Seeding order" tabIndex={0}>
          <div role="table" aria-label="Seeding entries">
            <div className="seeding-list-header seeding-grid" role="row">
              <span className="seeding-entrant" role="columnheader">
                Bracket seed and player
              </span>
              <span role="columnheader">{usesWhr ? 'Conservative score' : 'Saved score'}</span>
              <span role="columnheader">Auto seed</span>
              <span role="columnheader">Challonge change</span>
            </div>
            <SortableContext items={order} strategy={verticalListSortingStrategy}>
              <div className="seeding-list" role="rowgroup">
                {order.map((participantId, index) => {
                  const entry = byParticipant.get(participantId);
                  if (!entry) return null;
                  return (
                    <SeedingRow
                      key={participantId}
                      entry={entry}
                      seed={index + 1}
                      draggable={draggable}
                      onChanged={onChanged}
                    />
                  );
                })}
              </div>
            </SortableContext>
          </div>
        </div>
      </DndContext>

      {confirmingPush && (
        <ConfirmDialog
          title="Push seeds to Challonge?"
          open
          onOpenChange={setConfirmingPush}
          description={
            <>
              <p className="muted">
                This writes the following seed assignments to the live bracket:
              </p>
              <ol className="push-preview">
                {order.map((participantId) => (
                  <li key={participantId}>{byParticipant.get(participantId)?.name ?? '?'}</li>
                ))}
              </ol>
            </>
          }
        >
          {push.isError && (
            <p role="alert" className="error-text">
              Push failed: {push.error.message}
            </p>
          )}
          <div className="modal-actions">
            <ConfirmCancel />
            <Button
              variant="primary"
              type="button"
              disabled={push.isPending}
              onClick={() => push.mutate()}
            >
              {push.isPending ? 'Pushing…' : 'Push seeds'}
            </Button>
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Locked entries keep their pre-drag positions; everyone else fills around them. */
function enforceLocks(prev: string[], moved: string[], locked: Set<string>): string[] {
  if (locked.size === 0) return moved;
  const result: (string | null)[] = Array<string | null>(prev.length).fill(null);
  prev.forEach((id, index) => {
    if (locked.has(id)) result[index] = id;
  });
  const rest = moved.filter((id) => !locked.has(id));
  let j = 0;
  for (let i = 0; i < result.length; i++) {
    if (result[i] === null) result[i] = rest[j++] ?? null;
  }
  return result.filter((id): id is string => id !== null);
}

function SeedingRow({
  entry,
  seed,
  draggable,
  onChanged,
}: {
  entry: SeedingEntry;
  seed: number;
  draggable: boolean;
  onChanged: () => void;
}) {
  const nameId = useId();
  const disabled = !draggable || entry.locked;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.participantId,
    disabled,
  });

  const toggleLock = useMutation({
    mutationFn: () =>
      trpc.admin.setSeedingEntryLocked.mutate({ entryId: entry.id, locked: !entry.locked }),
    onSuccess: onChanged,
  });

  const delta = entry.challongeSeed != null ? entry.challongeSeed - seed : null;

  return (
    <div
      ref={setNodeRef}
      role="row"
      className={`seeding-row seeding-grid${isDragging ? ' dragging' : ''}${entry.locked ? ' locked' : ''}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      <span className="seeding-entrant" role="rowheader" aria-labelledby={nameId}>
        <span className="seed-number">{seed}</span>
        <span
          className={`drag-handle${disabled ? ' disabled' : ''}`}
          title={
            entry.locked ? 'Locked in place' : draggable ? 'Drag to reorder' : 'Run is not editable'
          }
          aria-label={entry.locked ? `Seed ${seed} locked` : `Reorder seed ${seed}: ${entry.name}`}
          {...attributes}
          {...listeners}
        >
          <span aria-hidden="true">{entry.locked ? '🔒' : '☰'}</span>
        </span>
        <span className="seeding-name" id={nameId}>
          {entry.name}
        </span>
        <Button
          className="seeding-lock"
          size="small"
          type="button"
          disabled={toggleLock.isPending || !draggable}
          onClick={() => toggleLock.mutate()}
          title={entry.locked ? 'Unlock this seed' : 'Lock this seed in place'}
          aria-label={
            entry.locked
              ? `Unlock seed ${seed} for ${entry.name}`
              : `Lock seed ${seed} in place for ${entry.name}`
          }
          aria-pressed={entry.locked}
        >
          {entry.locked ? '🔒' : '🔓'}
        </Button>
      </span>
      <span role="cell">
        {entry.autoScore != null ? entry.autoScore.toFixed(0) : 'Unrated'}
        {entry.seedRating && (
          <span className="muted seeding-rating-inputs">
            <span>Skill estimate {Math.round(entry.seedRating.skill)}</span>
            <span>Uncertainty {Math.round(entry.seedRating.uncertainty)}</span>
          </span>
        )}
      </span>
      <span className="muted" role="cell">
        #{entry.autoSeed}
      </span>
      <span role="cell">
        {entry.challongeSeed == null || delta == null ? (
          <span className="muted">—</span>
        ) : delta === 0 ? (
          <span className="muted">= {entry.challongeSeed}</span>
        ) : delta > 0 ? (
          <span className="seed-up" title={`Was Challonge seed ${entry.challongeSeed}`}>
            ↑ {delta}
          </span>
        ) : (
          <span className="seed-down" title={`Was Challonge seed ${entry.challongeSeed}`}>
            ↓ {-delta}
          </span>
        )}
      </span>
    </div>
  );
}
