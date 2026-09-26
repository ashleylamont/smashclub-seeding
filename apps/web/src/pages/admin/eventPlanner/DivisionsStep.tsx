import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { trpc } from '../../../lib/trpc';
import type { EventPlanEntry, EventPlanView } from '../../../lib/apiTypes';
import { formatDateTime } from '../../../lib/format';
import { DIVISION_LABEL } from './labels';

/**
 * Step 4: the frozen split, with the seed order still adjustable by hand.
 *
 * The snapshot timestamp is on the screen rather than in a tooltip, because
 * every number here is "as of then" and the board will have moved since.
 */

export function DivisionsStep({ view, onChanged }: { view: EventPlanView; onChanged: () => void }) {
  const planId = view.plan.id;
  const attached = view.brackets.some((bracket) => bracket.challongeSlug !== null);
  const locked = attached || view.plan.status === 'underway' || view.plan.status === 'complete' || view.plan.status === 'cancelled';

  const generate = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.generatePools.mutate({ planId }),
    onSuccess: onChanged,
  });

  return (
    <div>
      <div className="page-header">
        <h3>Divisions</h3>
        <span className="row-actions">
          <span className="muted">Ranking snapshot: {formatDateTime(view.plan.rankingSnapshotAt)}</span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={locked || generate.isPending || view.divisions.some((division) => division.pools.length === 0)}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? 'Generating…' : view.plan.status === 'roster_frozen' ? 'Generate pools' : 'Regenerate pools'}
          </button>
        </span>
      </div>
      {generate.isError && <p className="error-text">{generate.error.message}</p>}
      {locked && (
        <div className="banner banner-warning">
          Seeds are locked: {attached ? 'a Challonge bracket is attached' : 'the event is underway or closed'}. Completed play is preserved.
        </div>
      )}

      <div className="division-columns">
        {view.divisions.map((division) => (
          <DivisionColumn
            key={division.division}
            planId={planId}
            division={division.division}
            entries={view.entries
              .filter((entry) => entry.assignedDivision === division.division)
              .sort((a, b) => a.divisionSeed! - b.divisionSeed!)}
            locked={locked}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}

function DivisionColumn({
  planId,
  division,
  entries,
  locked,
  onChanged,
}: {
  planId: string;
  division: 'upper' | 'lower';
  entries: EventPlanEntry[];
  locked: boolean;
  onChanged: () => void;
}) {
  const serverOrder = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const [order, setOrder] = useState<string[]>(serverOrder);
  const [lastServerOrder, setLastServerOrder] = useState<string[]>(serverOrder);
  if (serverOrder !== lastServerOrder) {
    setLastServerOrder(serverOrder);
    setOrder(serverOrder);
  }

  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);

  const reorder = useMutation({
    mutationFn: (orderedEntryIds: string[]) =>
      trpc.admin.eventPlanner.reorderDivision.mutate({ planId, division, orderedEntryIds }),
    onSuccess: onChanged,
    onError: () => setOrder(serverOrder),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Drag by keyboard as well as pointer; the move buttons below are the
    // belt-and-braces version for anyone the drag interaction does not suit.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const move = (from: number, to: number) => {
    if (locked || to < 0 || to >= order.length) return;
    const next = arrayMove(order, from, to);
    setOrder(next);
    reorder.mutate(next);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    move(order.indexOf(String(active.id)), order.indexOf(String(over.id)));
  };

  return (
    <div className="card division-column">
      <div className="page-header">
        <h4>
          {DIVISION_LABEL[division]} <span className="muted">{entries.length} players</span>
        </h4>
      </div>
      {reorder.isError && <p className="error-text">{reorder.error.message}</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <ol className="division-list">
            {order.map((entryId, index) => {
              const entry = byId.get(entryId);
              if (!entry) return null;
              return (
                <DivisionRow
                  key={entryId}
                  entry={entry}
                  seed={index + 1}
                  locked={locked}
                  onMove={(delta) => move(index, index + delta)}
                />
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function DivisionRow({
  entry,
  seed,
  locked,
  onMove,
}: {
  entry: EventPlanEntry;
  seed: number;
  locked: boolean;
  onMove: (delta: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    disabled: locked,
  });

  return (
    <li
      ref={setNodeRef}
      className={`division-row${isDragging ? ' dragging' : ''}`}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      <span className="seed-number">{seed}</span>
      <span
        className={`drag-handle${locked ? ' disabled' : ''}`}
        aria-label={`Reorder seed ${seed}: ${entry.playerName}`}
        {...attributes}
        {...listeners}
      >
        <span aria-hidden="true">☰</span>
      </span>
      <span className="division-name">
        {entry.playerName}
        {entry.divisionPreference !== 'auto' && (
          <span className="chip" title="Pinned to this division by an admin">
            pinned
          </span>
        )}
      </span>
      <span className="muted">{entry.snapshotRank === null ? 'unranked' : `#${entry.snapshotRank}`}</span>
      <span className="row-actions">
        <button
          type="button"
          className="btn btn-small"
          disabled={locked || seed === 1}
          onClick={() => onMove(-1)}
          aria-label={`Move ${entry.playerName} up`}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={locked}
          onClick={() => onMove(1)}
          aria-label={`Move ${entry.playerName} down`}
        >
          ↓
        </button>
      </span>
    </li>
  );
}
