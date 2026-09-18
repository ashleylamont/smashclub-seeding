import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../../lib/trpc';
import type { EventPlanEntry, EventPlanView, ReviewCandidate } from '../../../lib/apiTypes';
import { PlayerFormModal, type PlayerFormValues } from '../../../components/PlayerFormModal';
import { PlayerLookupModal } from '../../../components/PlayerLookupModal';
import { CopyBlock, IssueList } from './shared';

/**
 * Step 3 of the wizard: one editable row per pasted entrant.
 *
 * The row shows what was pasted, what the club thinks it means, and how sure it
 * is — because the fix for a wrong match is the admin recognising it, and they
 * cannot recognise it from a name alone. Nothing on this screen guesses: a
 * fuzzy candidate is offered, never selected.
 */

const METHOD_LABEL: Record<string, string> = {
  alias: 'Exact alias',
  decision: 'Prior decision',
  structured: 'Short form',
  manual: 'Chosen by hand',
  new: 'New player',
  unresolved: 'Unresolved',
};

export function RosterStep({
  view,
  onChanged,
}: {
  view: EventPlanView;
  onChanged: () => void;
}) {
  const planId = view.plan.id;
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const [addingText, setAddingText] = useState('');
  const editable = view.plan.status === 'draft';

  const addRows = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.addRows.mutate({ planId, text: addingText }),
    onSuccess: () => {
      setAddingText('');
      onChanged();
    },
  });

  const freeze = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.freezeRoster.mutate({ planId }),
    onSuccess: onChanged,
  });

  const unfreeze = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.unfreezeRoster.mutate({ planId }),
    onSuccess: onChanged,
  });

  const resolved = view.entries.filter((entry) => entry.playerId !== null).length;
  const canFreeze = editable && view.issues.blocking.length === 0;

  return (
    <div>
      <div className="page-header">
        <h3>
          Roster <span className="muted">{resolved}/{view.entries.length} matched</span>
        </h3>
        <span className="row-actions">
          {editable ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canFreeze || freeze.isPending}
              onClick={() => freeze.mutate()}
              title={
                canFreeze
                  ? 'Snapshot the leaderboard and split the divisions'
                  : 'Fix the blocking problems first'
              }
            >
              {freeze.isPending ? 'Freezing…' : 'Freeze roster & split divisions'}
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={unfreeze.isPending || !['roster_frozen', 'pools_ready'].includes(view.plan.status) || view.brackets.some((bracket) => bracket.challongeSlug !== null)}
              onClick={() => {
                if (window.confirm('Reopen the roster? The ranking snapshot and every seed is discarded.')) {
                  unfreeze.mutate();
                }
              }}
            >
              {unfreeze.isPending ? 'Reopening…' : 'Reopen roster'}
            </button>
          )}
        </span>
      </div>
      {freeze.isError && <p className="error-text">{freeze.error.message}</p>}
      {unfreeze.isError && <p className="error-text">{unfreeze.error.message}</p>}

      {editable && <DraftSettings key={`${planId}:${view.plan.name}:${view.plan.upperTargetSize}:${view.entries.length}`} view={view} onChanged={onChanged} />}
      {editable && (
        <IssueList issues={view.issues.blocking} kind="blocking" onFocusRows={(ids) => setHighlighted(new Set(ids))} />
      )}
      <IssueList issues={view.issues.warnings} kind="warning" onFocusRows={(ids) => setHighlighted(new Set(ids))} />
      {highlighted.size > 0 && (
        <p className="muted">
          Highlighting {highlighted.size} row(s).{' '}
          <button type="button" className="btn btn-small" onClick={() => setHighlighted(new Set())}>
            Clear
          </button>
        </p>
      )}

      <div className="roster-table" role="table" aria-label="Roster">
        <div className="roster-row roster-head" role="row">
          <span role="columnheader">Pasted</span>
          <span role="columnheader">Parsed</span>
          <span role="columnheader">Match</span>
          <span role="columnheader">Rank</span>
          <span role="columnheader">Division</span>
          <span role="columnheader">Actions</span>
        </div>
        {view.entries.map((entry) => (
          <RosterRow
            key={entry.id}
            planId={planId}
            entry={entry}
            editable={editable}
            highlighted={highlighted.has(entry.id)}
            onChanged={onChanged}
          />
        ))}
      </div>

      {editable && (
        <div className="card section">
          <span className="form-label">Somebody turned up late</span>
          <textarea
            className="input planner-textarea"
            rows={3}
            placeholder="Paste more names, one per line…"
            value={addingText}
            onChange={(event) => setAddingText(event.target.value)}
          />
          <div className="admin-form-row">
            <button
              type="button"
              className="btn"
              disabled={addingText.trim() === '' || addRows.isPending}
              onClick={() => addRows.mutate()}
            >
              {addRows.isPending ? 'Adding…' : 'Add to roster'}
            </button>
            {addRows.isError && <span className="error-text">{addRows.error.message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function RosterRow({
  planId,
  entry,
  editable,
  highlighted,
  onChanged,
}: {
  planId: string;
  entry: EventPlanEntry;
  editable: boolean;
  highlighted: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [lookingUp, setLookingUp] = useState(false);
  const [creating, setCreating] = useState(false);

  const companies = useQuery({
    queryKey: ['admin', 'companies'],
    queryFn: () => trpc.admin.companies.query(),
    enabled: creating,
  });

  const update = useMutation({
    mutationFn: (patch: {
      playerId?: string | null;
      divisionPreference?: 'auto' | 'upper' | 'lower';
      resolutionMethod?: 'manual' | 'new';
    }) => trpc.admin.eventPlanner.updateEntry.mutate({ planId, entryId: entry.id, ...patch }),
    onSuccess: () => {
      setLookingUp(false);
      onChanged();
    },
  });

  const remove = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.removeEntry.mutate({ planId, entryId: entry.id }),
    onSuccess: onChanged,
  });

  /**
   * Mint the player, then bind them to this row. Two calls, and the order
   * matters: if the bind fails the player still exists and the row can be
   * pointed at them by hand, which is recoverable. The other order would
   * silently lose the details the admin just typed.
   */
  const createPlayer = useMutation({
    mutationFn: async (values: PlayerFormValues) => {
      const { playerId } = await trpc.admin.createPlayer.mutate({
        canonicalName: values.canonicalName,
        displayName: values.displayName === '' ? null : values.displayName,
        companyCode: values.companyCode === '' ? null : values.companyCode,
        characters: values.characters,
        aliases: values.aliases,
      });
      await queryClient.invalidateQueries({ queryKey: ['admin', 'players'] });
      await trpc.admin.eventPlanner.updateEntry.mutate({
        planId,
        entryId: entry.id,
        playerId,
        resolutionMethod: 'new',
      });
    },
    onSuccess: () => {
      setCreating(false);
      onChanged();
    },
  });

  /**
   * Teach the club this spelling for good. Deliberately a separate, explicit
   * action: a one-off typo on an attendance sheet should not become a permanent
   * club record just because somebody corrected it once.
   */
  const remember = useMutation({
    mutationFn: () =>
      trpc.admin.addAlias.mutate({
        playerId: entry.playerId!,
        alias: entry.cleanedName,
        companyCode: entry.companyCode,
      }),
    onSuccess: onChanged,
  });

  const candidates = entry.candidates as ReviewCandidate[];
  const needsDivision = entry.currentRank === null && entry.divisionPreference === 'auto';
  const rank = entry.snapshotRank ?? entry.currentRank;

  return (
    <div
      className={`roster-row${highlighted ? ' highlighted' : ''}${entry.playerId ? '' : ' unresolved'}`}
      role="row"
    >
      <span role="cell" className="roster-raw" title={`Line ${entry.sourceLineNumber}`}>
        {entry.rawInput}
      </span>
      <span role="cell">
        {entry.cleanedName}
        {entry.companyCode && <span className="chip">{entry.companyCode}</span>}
      </span>
      <span role="cell" className="roster-match">
        {entry.playerId ? (
          <>
            <strong>{entry.playerName}</strong>
            <span className="muted"> → {entry.publicName}</span>
            <span className={`chip method-${entry.resolutionMethod}`}>{METHOD_LABEL[entry.resolutionMethod]}</span>
          </>
        ) : candidates.length > 0 ? (
          <span className="roster-candidates">
            <span className="muted">Did you mean</span>
            {candidates.slice(0, 3).map((candidate) => (
              <button
                key={candidate.playerId}
                type="button"
                className="btn btn-small"
                disabled={!editable || update.isPending}
                onClick={() => update.mutate({ playerId: candidate.playerId, resolutionMethod: 'manual' })}
                title={`${Math.round(candidate.score * 100)}% — ${candidate.reason}`}
              >
                {candidate.name}
              </button>
            ))}
          </span>
        ) : (
          <span className="muted">No candidates — create the player or look them up.</span>
        )}
      </span>
      <span role="cell">
        {rank === null ? (
          <span className="muted">unranked</span>
        ) : (
          <>
            #{rank}
            {entry.snapshotRank !== null && entry.currentRank !== null && entry.snapshotRank !== entry.currentRank && (
              <span className="muted" title="The live board has moved since the snapshot">
                {' '}
                (now #{entry.currentRank})
              </span>
            )}
          </>
        )}
      </span>
      <span role="cell">
        <select
          className={`select${needsDivision ? ' select-required' : ''}`}
          value={entry.divisionPreference}
          disabled={!editable || update.isPending || entry.playerId === null}
          aria-label={`Division for ${entry.cleanedName}`}
          onChange={(event) =>
            update.mutate({ divisionPreference: event.target.value as 'auto' | 'upper' | 'lower' })
          }
        >
          <option value="auto">{needsDivision ? 'Required' : 'Auto'}</option>
          <option value="upper">Upper</option>
          <option value="lower">Lower</option>
        </select>
      </span>
      <span role="cell" className="row-actions">
        {editable && (
          <>
            <button type="button" className="btn btn-small" onClick={() => setLookingUp(true)}>
              {entry.playerId ? 'Change' : 'Choose'}
            </button>
            {!entry.playerId && (
              <button type="button" className="btn btn-small" onClick={() => setCreating(true)}>
                Create
              </button>
            )}
            {entry.playerId &&
              entry.resolutionMethod === 'manual' &&
              entry.cleanedName.toLowerCase() !== (entry.playerName ?? '').toLowerCase() && (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={remember.isPending}
                  title="Add this spelling as a permanent alias, so future brackets match it silently"
                  onClick={() => remember.mutate()}
                >
                  {remember.isSuccess ? 'Remembered ✓' : 'Remember spelling'}
                </button>
              )}
            <button
              type="button"
              className="btn btn-small"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
              aria-label={`Remove ${entry.cleanedName} from the roster`}
            >
              Remove
            </button>
          </>
        )}
      </span>

      {(update.isError || remove.isError || remember.isError) && (
        <span role="cell" className="error-text roster-error">
          {update.error?.message ?? remove.error?.message ?? remember.error?.message}
        </span>
      )}

      {lookingUp && (
        <PlayerLookupModal
          title={`Who is “${entry.cleanedName}”?`}
          candidatePlayerIds={candidates.map((candidate) => candidate.playerId)}
          busy={update.isPending}
          error={update.error?.message ?? null}
          onPick={(playerId) => update.mutate({ playerId, resolutionMethod: 'manual' })}
          onCancel={() => setLookingUp(false)}
        >
          <CopyBlock label="Pasted line" text={entry.rawInput} rows={1} />
        </PlayerLookupModal>
      )}

      {creating && (
        <PlayerFormModal
          title={`New player for “${entry.cleanedName}”`}
          submitLabel="Create and use"
          initial={{ canonicalName: entry.cleanedName, companyCode: entry.companyCode ?? '' }}
          companies={companies.data ?? []}
          showAliases
          busy={createPlayer.isPending}
          error={createPlayer.error?.message ?? null}
          onSubmit={(values) => createPlayer.mutate(values)}
          onCancel={() => setCreating(false)}
        >
          <p className="muted">
            They have no ranking, so they will need an explicit Upper or Lower and will seed at the bottom of
            it.
          </p>
        </PlayerFormModal>
      )}
    </div>
  );
}

function DraftSettings({ view, onChanged }: { view: EventPlanView; onChanged: () => void }) {
  const [name, setName] = useState(view.plan.name);
  const [prefix, setPrefix] = useState(view.plan.slugPrefix ?? '');
  const [upper, setUpper] = useState(view.plan.upperTargetSize ?? Math.ceil(view.entries.length / 2));
  const total = view.entries.length;
  const update = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.updatePlan.mutate({ planId: view.plan.id, name, slugPrefix: prefix || null, upperTargetSize: upper }),
    onSuccess: onChanged,
  });
  return <form className="card section" onSubmit={(event) => { event.preventDefault(); update.mutate(); }}>
    <h4>Draft settings</h4>
    <label className="form-field">Event name<input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="form-field">Bracket slug prefix<input className="input" value={prefix} onChange={(event) => setPrefix(event.target.value)} /></label>
    <label className="form-field">Upper division size<input className="input" type="number" min={3} max={Math.max(3, total - 3)} value={upper} onChange={(event) => setUpper(Number(event.target.value))} /></label>
    <p className="muted">{upper} Upper / {total - upper} Lower. Pools contain three to five players; the top two in each pool advance to championship and everyone else to consolation. Save a new split after attendance changes.</p>
    <button className="btn btn-primary" disabled={update.isPending || !name.trim() || upper < 3 || upper > total - 3}>Save settings</button>
    {update.isError && <p className="error-text">{update.error.message}</p>}
  </form>;
}
