import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../../lib/trpc';
import type { EventPlanView } from '../../../lib/apiTypes';
import { formatDate, formatDateTime } from '../../../lib/format';

const SLOTS = [
  { division: 'upper', stage: 'main', label: 'Upper main' },
  { division: 'upper', stage: 'consolation', label: 'Upper consolation' },
  { division: 'lower', stage: 'main', label: 'Lower main' },
  { division: 'lower', stage: 'consolation', label: 'Lower consolation' },
] as const;

type AdoptionPreview = Awaited<ReturnType<typeof trpc.admin.eventPlanner.previewHistoricalAdoption.mutate>>;

function historicalResultsUrl(view: EventPlanView): string | null {
  const slug = view.brackets.find((bracket) => bracket.division === 'upper' && bracket.stage === 'main')?.challongeSlug;
  return slug ? `/events/${encodeURIComponent(slug)}` : null;
}

export function HistoricalAdoption({ view, onChanged }: { view: EventPlanView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const adopted = view.plan.historicalAdoption;
  const resultsUrl = historicalResultsUrl(view);

  return (
    <section className={`card section historical-adoption${adopted ? ' historical-adopted' : ''}`} aria-labelledby="historical-adoption-heading">
      <div className="page-header">
        <h3 id="historical-adoption-heading">{adopted ? 'Historical results adopted' : 'Adopt historical results'}</h3>
        {adopted && resultsUrl && <a className="btn btn-primary" href={resultsUrl}>View imported results →</a>}
      </div>
      {adopted ? (
        <>
          <p>The imported brackets are the record of the event played. The original roster, division seeds and pool plan remain below as an archive.</p>
          <p className="muted">Adopted {formatDateTime(adopted.adoptedAt)}. Results, scores, bracket dates and rating settings are preserved.</p>
          <ul className="historical-bracket-list">
            {view.brackets.map((bracket) => <li key={`${bracket.division}-${bracket.stage}`}>
              <span>{SLOTS.find((slot) => slot.division === bracket.division && slot.stage === bracket.stage)?.label}</span>
              {bracket.challongeSlug && <a href={`/tournaments/${encodeURIComponent(bracket.challongeSlug)}`}>{bracket.challongeSlug}</a>}
            </li>)}
          </ul>
        </>
      ) : (
        <p>Already played this event, with changes on the night? Connect the four completed, imported brackets and review how the actual roster differs from this plan.</p>
      )}
      <button type="button" className="btn btn-small" aria-expanded={editing} onClick={() => setEditing(!editing)}>
        {editing ? 'Close adoption form' : adopted ? 'Review or correct bracket links' : 'Choose historical brackets'}
      </button>
      {editing && <AdoptionForm key={adopted?.adoptedAt ?? 'original'} view={view} onApplied={() => { setEditing(false); onChanged(); }} />}
    </section>
  );
}

function AdoptionForm({ view, onApplied }: { view: EventPlanView; onApplied: () => void }) {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState(() => SLOTS.map((slot) =>
    view.brackets.find((bracket) => bracket.division === slot.division && bracket.stage === slot.stage)?.tournamentId ?? '',
  ));
  const [preview, setPreview] = useState<AdoptionPreview | null>(null);
  const candidates = useQuery({
    queryKey: ['admin', 'eventPlanner', 'historicalCandidates', view.plan.id],
    queryFn: () => trpc.admin.eventPlanner.historicalCandidates.query({ planId: view.plan.id }),
  });
  const brackets = SLOTS.map(({ division, stage }, index) => ({ division, stage, tournamentId: selection[index]! }));
  const previewMutation = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.previewHistoricalAdoption.mutate({ planId: view.plan.id, brackets }),
    onMutate: () => { setPreview(null); applyMutation.reset(); },
    onSuccess: setPreview,
  });
  const applyMutation = useMutation({
    mutationFn: (fingerprint: string) => trpc.admin.eventPlanner.applyHistoricalAdoption.mutate({ planId: view.plan.id, brackets, fingerprint }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['eventOverview'] });
      void queryClient.invalidateQueries({ queryKey: ['recap'] });
      void queryClient.invalidateQueries({ queryKey: ['tournaments'] });
      onApplied();
    },
    onError: () => setPreview(null),
  });
  const pending = previewMutation.isPending || applyMutation.isPending;

  return (
    <div className="historical-form">
      <p>Adoption marks this plan complete and uses the imported brackets for event results and recap. It keeps the original plan, imported scores, dates and rating settings intact. It does not generate pool matches or infer missing pool placements.</p>
      <p className="muted">Only completed, synced brackets are available. Import any missing bracket from Admin → Tournaments first.</p>
      {candidates.isPending && <p className="loading-text">Loading imported brackets…</p>}
      {candidates.isError && <p className="error-text" role="alert">{candidates.error.message}</p>}
      {candidates.data && <>
        <div className="historical-slot-grid">
          {SLOTS.map((slot, index) => <label key={slot.label}>
            <span>{slot.label}</span>
            <select className="select" value={selection[index]} disabled={pending} onChange={(event) => {
              setSelection(selection.map((value, position) => position === index ? event.target.value : value));
              setPreview(null);
              previewMutation.reset();
              applyMutation.reset();
            }}>
              <option value="">Choose an imported bracket</option>
              {selection[index] && !candidates.data.some((candidate) => candidate.tournamentId === selection[index]) &&
                <option value={selection[index]} disabled>Current bracket unavailable — choose a completed import</option>}
              {candidates.data.map((candidate) => <option value={candidate.tournamentId} key={candidate.tournamentId} disabled={selection.some((value, position) => position !== index && value === candidate.tournamentId)}>
                {candidate.name} · {candidate.participantCount} players{candidate.eventDate ? ` · ${formatDate(candidate.eventDate)}` : ''} · {candidate.slug}
              </option>)}
            </select>
          </label>)}
        </div>
        <button type="button" className="btn" disabled={pending || selection.some((value) => !value) || new Set(selection).size !== SLOTS.length} onClick={() => previewMutation.mutate()}>
          {previewMutation.isPending ? 'Building preview…' : 'Preview historical adoption'}
        </button>
      </>}
      {previewMutation.isError && <p className="error-text" role="alert">{previewMutation.error.message}</p>}
      {applyMutation.isError && <p className="error-text" role="alert">{applyMutation.error.message} Review a fresh preview before applying.</p>}
      {preview && <div className="preview-summary" aria-live="polite">
        <h4>Review the event as played</h4>
        <ul className="historical-bracket-list">
          {preview.brackets.map((bracket) => <li key={`${bracket.division}-${bracket.stage}`}>
            <strong>{SLOTS.find((slot) => slot.division === bracket.division && slot.stage === bracket.stage)?.label}</strong>
            <span><a href={`/tournaments/${encodeURIComponent(bracket.slug)}`} target="_blank" rel="noreferrer">{bracket.name}</a> · {bracket.participantCount} players</span>
            <small className="muted">{bracket.previousSlug === bracket.slug ? `Keep ${bracket.slug}` : bracket.previousSlug ? `Replace ${bracket.previousSlug} with ${bracket.slug}` : `Attach ${bracket.slug}`}</small>
          </li>)}
        </ul>
        <div className="historical-differences">
          <RosterDifference title="Planned, absent from imported brackets" rows={preview.differences.plannedOnly} />
          <RosterDifference title="In imported brackets, absent from plan" rows={preview.differences.actualOnly} />
          <div><h5>Changed division ({preview.differences.divisionChanges.length})</h5>
            {preview.differences.divisionChanges.length === 0 ? <p className="muted">None.</p> : <ul>{preview.differences.divisionChanges.map((row) => <li key={row.playerId}>{row.name}: {row.plannedDivision} → {row.actualDivision}</li>)}</ul>}
          </div>
        </div>
        {preview.warnings.length > 0 && <div className="banner"><strong>Review notes</strong><ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
        {preview.blocking.length > 0 && <div className="banner banner-danger" role="alert"><strong>Resolve before adoption</strong><ul>{preview.blocking.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
        <p>Applying records these bracket links and archives the original plan. The roster differences above are recorded for reference; they do not overwrite the original roster or rewrite match history.</p>
        <button type="button" className="btn btn-primary" disabled={pending || preview.blocking.length > 0} onClick={() => applyMutation.mutate(preview.fingerprint)}>
          {applyMutation.isPending ? 'Adopting…' : 'Adopt these historical results'}
        </button>
      </div>}
    </div>
  );
}

function RosterDifference({ title, rows }: { title: string; rows: Array<{ name: string; playerId: string | null }> }) {
  return <div><h5>{title} ({rows.length})</h5>{rows.length === 0 ? <p className="muted">None.</p> : <ul>{rows.map((row, index) => <li key={`${row.playerId ?? row.name}-${index}`}>{row.name}{!row.playerId && <span className="muted"> · identity unresolved</span>}</li>)}</ul>}</div>;
}
