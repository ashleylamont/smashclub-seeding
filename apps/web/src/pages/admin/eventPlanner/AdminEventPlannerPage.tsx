import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { trpc } from '../../../lib/trpc';
import type { EventPlanView, RosterPreviewRow } from '../../../lib/apiTypes';
import { formatDate, formatDateTime } from '../../../lib/format';
import { RosterStep } from './RosterStep';
import { DivisionsStep } from './DivisionsStep';
import { PoolsStep } from './PoolsStep';
import { HandoffStep } from './HandoffStep';
import { HistoricalAdoption } from './HistoricalAdoption';
import { STATUS_LABEL } from './labels';
import './EventPlanner.css';

/**
 * The two-division club night, from a pasted attendance list to four Challonge
 * slugs.
 *
 * The wizard is a view over a saved plan rather than a form with steps: every
 * correction is written as it is made, so closing the laptop, refreshing, or
 * picking the plan up on another admin's phone at the venue all resume exactly
 * where the last person left off.
 */

const STEPS = [
  { key: 'roster', label: 'Roster' },
  { key: 'divisions', label: 'Divisions' },
  { key: 'pools', label: 'Pools' },
  { key: 'handoff', label: 'Challonge' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

export function AdminEventPlannerPage() {
  const search = useSearch({ from: '/admin/event-planner' });
  const navigate = useNavigate({ from: '/admin/event-planner' });
  const setPlanId = (planId: string | null) =>
    void navigate({ search: planId ? { plan: planId } : {}, replace: false });

  const plans = useQuery({
    queryKey: ['admin', 'eventPlanner', 'plans'],
    queryFn: () => trpc.admin.eventPlanner.plans.query(),
  });

  if (search.plan) {
    return (
      <PlanWizard
        key={search.plan}
        planId={search.plan}
        step={search.step}
        onStep={(step) => void navigate({ search: { plan: search.plan, step }, replace: true })}
        onBack={() => setPlanId(null)}
      />
    );
  }

  return (
    <div>
      <div className="card section">
        <h2>Event planner</h2>
        <p className="muted">
          Paste the attendance list, resolve everybody against the registry, split Upper and Lower off a frozen
          ranking snapshot, and stripe each division into balanced pools of three to five. The plan then hands you exactly what
          Challonge needs for the four brackets of the night.
        </p>
      </div>

      <NewPlanForm onCreated={setPlanId} />

      <div className="card section">
        <h3>Saved plans</h3>
        {plans.isPending && <p className="loading-text">Loading plans…</p>}
        {plans.isError && <p className="error-text">{plans.error.message}</p>}
        {plans.data?.length === 0 && <p className="muted">No plans yet.</p>}
        {plans.data && plans.data.length > 0 && (
          <ul className="plan-list">
            {plans.data.map((plan) => (
              <li key={plan.id} className="plan-row">
                <button type="button" className="btn btn-small" onClick={() => setPlanId(plan.id)}>
                  Open
                </button>
                <span className="plan-name">{plan.name}</span>
                <span className="muted">{formatDate(plan.eventDate)}</span>
                <span className="chip">{STATUS_LABEL[plan.status] ?? plan.status}</span>
                <span className="muted">{plan.entryCount} entrants</span>
                {(plan.status === 'draft' || plan.status === 'cancelled') && (
                  <DeletePlanButton planId={plan.id} name={plan.name} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Only offered for a plan nothing was ever run off — a draft or a cancellation. */
function DeletePlanButton({ planId, name }: { planId: string; name: string }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.deletePlan.mutate({ planId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'eventPlanner'] }),
  });
  return (
    <>
      <button
        type="button"
        className="btn btn-small"
        disabled={remove.isPending}
        aria-label={`Delete plan ${name}`}
        onClick={() => {
          if (window.confirm(`Delete “${name}” and its roster?`)) remove.mutate();
        }}
      >
        Delete
      </button>
      {remove.isError && <span className="error-text">{remove.error.message}</span>}
    </>
  );
}

/** Steps 1 and 2: the event's details and the paste that starts it off. */
function NewPlanForm({ onCreated }: { onCreated: (planId: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [eventDate, setEventDate] = useState(defaultEventDate());
  const [slugPrefix, setSlugPrefix] = useState('');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<RosterPreviewRow[] | null>(null);
  const [upperSize, setUpperSize] = useState<number | null>(null);
  const [bracketMode, setBracketMode] = useState<'native' | 'challonge'>('native');

  const previewRoster = useMutation({
    mutationFn: () => trpc.admin.eventPlanner.previewRoster.mutate({ text }),
    onSuccess: (rows) => {
      setPreview(rows);
      setUpperSize(defaultUpperSize(rows.length));
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const rows = preview ?? [];
      return trpc.admin.eventPlanner.createPlan.mutate({
        name: name.trim(),
        bracketMode,
        eventDate: new Date(eventDate).toISOString(),
        slugPrefix: slugPrefix.trim() === '' ? null : slugPrefix.trim(),
        upperTargetSize: upperSize,
        rows: rows.map((row) => ({
          lineNumber: row.lineNumber,
          rawInput: row.rawInput,
          cleanedName: row.cleanedName,
          companyId: row.companyId,
          playerId: row.playerId,
          resolutionMethod: row.method,
          divisionPreference: 'auto' as const,
        })),
      });
    },
    onSuccess: async ({ planId }) => {
      await queryClient.invalidateQueries({ queryKey: ['admin', 'eventPlanner', 'plans'] });
      onCreated(planId);
    },
  });

  const total = preview?.length ?? 0;
  const sizes = validUpperSizes(total);
  const matched = preview?.filter((row) => row.playerId !== null).length ?? 0;

  return (
    <div className="card section">
      <h3>New event plan</h3>
      <div className="form-grid">
        <label className="form-field">
          <span className="form-label">Event name</span>
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. June Club Night"
          />
        </label>
        <label className="form-field">
          <span className="form-label">Date and time</span>
          <input
            className="input"
            type="datetime-local"
            value={eventDate}
            onChange={(event) => setEventDate(event.target.value)}
          />
          <span className="form-hint">
            All four brackets are registered under this date, which is what makes them one club night for
            ratings.
          </span>
        </label>
        <label className="form-field">
          <span className="form-label">Slug prefix (optional)</span>
          <input
            className="input"
            value={slugPrefix}
            onChange={(event) => setSlugPrefix(event.target.value)}
            placeholder="june25"
          />
          <span className="form-hint">Used to suggest Challonge slugs like june25_upper.</span>
        </label>
        <div className="form-field">
          <span className="form-label">Pool size</span>
          <input className="input" value="4" readOnly aria-readonly="true" />
          <span className="form-hint">Fixed at four for this version.</span>
        </div>
      </div>

      <label className="form-field">
        <span className="form-label">Attendance list</span>
        <textarea
          className="input planner-textarea"
          rows={10}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={'One person per line — bullets and numbering are fine.\n- [Atlas] Fox McCloud\n2. Samus Aran'}
        />
        <span className="form-hint">
          Lines are never split on commas: a display name may legitimately contain one.
        </span>
      </label>

      <div className="admin-form-row">
        <button
          type="button"
          className="btn"
          disabled={text.trim() === '' || previewRoster.isPending}
          onClick={() => previewRoster.mutate()}
        >
          {previewRoster.isPending ? 'Reading…' : 'Preview roster'}
        </button>
        {previewRoster.isError && <span className="error-text">{previewRoster.error.message}</span>}
      </div>

      <label className="form-field">
        <span className="form-label">Bracket system</span>
        <select className="select" value={bracketMode} onChange={event => setBracketMode(event.target.value as 'native' | 'challonge')}>
          <option value="native">Nemesis — run the whole event here</option>
          <option value="challonge">Challonge — manage external brackets</option>
        </select>
        <span className="form-hint">Nemesis runs pools, championship and consolation, then records the finished night in club ratings. Existing Challonge events stay linked to Challonge.</span>
      </label>

      {preview && (
        <div className="preview-summary">
          <p>
            <strong>{total}</strong> entrants, <strong>{matched}</strong> matched to a player.{' '}
            {total - matched > 0 && (
              <span className="muted">The rest can be resolved or created on the next screen.</span>
            )}
          </p>
          <label className="form-field">
            <span className="form-label">Upper division size</span>
            {sizes.length === 0 ? (
              <span className="error-text">
                At least six entrants are needed for two divisions.
              </span>
            ) : (
              <select
                className="select"
                value={upperSize ?? ''}
                onChange={(event) => setUpperSize(event.target.value === '' ? null : Number(event.target.value))}
              >
                <option value="">Choose…</option>
                {sizes.map((size) => (
                  <option key={size} value={size}>
                    {size} Upper / {total - size} Lower
                  </option>
                ))}
              </select>
            )}
            <span className="form-hint">
              The default splits attendance evenly. Each pool advances two players; all remaining players enter consolation.
            </span>
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={name.trim() === '' || total === 0 || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Saving…' : 'Save plan'}
          </button>
          {create.isError && <p className="error-text">{create.error.message}</p>}
        </div>
      )}
    </div>
  );
}

function PlanWizard({
  planId,
  step,
  onStep,
  onBack,
}: {
  planId: string;
  step: string | undefined;
  onStep: (step: StepKey) => void;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const planQuery = useQuery({
    queryKey: ['admin', 'eventPlanner', 'plan', planId],
    queryFn: () => trpc.admin.eventPlanner.plan.query({ planId }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'eventPlanner'] });
  };

  const close = useMutation({
    mutationFn: (status: 'complete' | 'cancelled') =>
      trpc.admin.eventPlanner.closePlan.mutate({ planId, status }),
    onSuccess: invalidate,
  });

  const view = planQuery.data ?? null;
  const requestedStep = isStepKey(step) ? step : furthestStep(view);
  const current = view?.plan.historicalAdoption && requestedStep === 'handoff' ? 'roster' : requestedStep;

  if (planQuery.isPending) return <p className="loading-text">Loading plan…</p>;
  if (planQuery.isError) return <p className="error-text">{planQuery.error.message}</p>;
  if (!view) {
    return (
      <div className="card">
        <p className="muted">That plan no longer exists.</p>
        <button type="button" className="btn" onClick={onBack}>
          Back to plans
        </button>
      </div>
    );
  }

  const available = availableSteps(view);
  const adopted = view.plan.historicalAdoption;
  const resultsSlug = view.brackets.find((bracket) => bracket.division === 'upper' && bracket.stage === 'main')?.challongeSlug;
  const resultsUrl = resultsSlug ? `/events/${encodeURIComponent(resultsSlug)}` : null;
  const steps = adopted ? STEPS.filter((entry) => entry.key !== 'handoff') : STEPS;
  const originalPlan = (<>
    <PlanSummary view={view} />
    <nav className="planner-steps" aria-label={adopted ? 'Original plan steps' : 'Planner steps'}>
      {steps.map((entry) => (
        <button key={entry.key} type="button" className={`admin-tab${current === entry.key ? ' active' : ''}`} disabled={!available.has(entry.key)} onClick={() => onStep(entry.key)}>
          {entry.key === 'handoff' && view.plan.bracketMode === 'native' ? 'Run event' : entry.label}
        </button>
      ))}
    </nav>
  </>);
  const stepContent = (<>
    {current === 'roster' && <RosterStep view={view} onChanged={invalidate} />}
    {current === 'divisions' && <DivisionsStep view={view} onChanged={invalidate} />}
    {current === 'pools' && <PoolsStep view={view} onChanged={invalidate} />}
    {current === 'handoff' && <HandoffStep view={view} onChanged={invalidate} />}
  </>);

  return (
    <div>
      <div className="card section">
        <div className="page-header">
          <h2>
            {view.plan.name} <span className="chip">{STATUS_LABEL[view.plan.status] ?? view.plan.status}</span>
          </h2>
          <span className="row-actions">
            {adopted ? resultsUrl && <a className="btn btn-small" href={resultsUrl}>Imported results →</a> : <a className="btn btn-small" href={`/admin/event-operations?plan=${planId}`}>Run event →</a>}
            {view.plan.bracketMode !== 'native' && (view.plan.status === 'pools_ready' || view.plan.status === 'underway') && (
              <button
                type="button"
                className="btn btn-small"
                disabled={close.isPending}
                title="The night is played and synced"
                onClick={() => close.mutate('complete')}
              >
                Mark complete
              </button>
            )}
            {view.plan.status !== 'complete' && view.plan.status !== 'cancelled' && (
              <button
                type="button"
                className="btn btn-small"
                disabled={close.isPending}
                onClick={() => {
                  if (window.confirm('Cancel this plan? It stays as a record but can no longer be run.')) {
                    close.mutate('cancelled');
                  }
                }}
              >
                Cancel plan
              </button>
            )}
            <button type="button" className="btn btn-small" onClick={onBack}>
              All plans
            </button>
          </span>
        </div>
        <p className="muted">
          {formatDateTime(view.plan.eventDate)} · {view.entries.length} {adopted ? 'planned entrants' : 'entrants'}
          {view.plan.rankingSnapshotAt && ` · ranking snapshot ${formatDateTime(view.plan.rankingSnapshotAt)}`}
        </p>
        {close.isError && <p className="error-text">{close.error.message}</p>}
        {!adopted && originalPlan}
      </div>

      {view.plan.status !== 'cancelled' && <HistoricalAdoption view={view} onChanged={invalidate} />}
      {adopted ? <details className="historical-original-plan card section">
        <summary>Original plan — may differ from the event played</summary>
        <p className="muted">These are the saved roster, seeds and proposed pools. Use the imported results above for the matches and placements that actually happened.</p>
        {originalPlan}
        {stepContent}
      </details> : stepContent}
    </div>
  );
}

/** Counts, warnings and slugs at a glance — the compact event summary. */
function PlanSummary({ view }: { view: EventPlanView }) {
  const attached = view.brackets.filter((bracket) => bracket.challongeSlug !== null);
  return (
    <dl className="plan-summary">
      {view.divisions.map((division) => (
        <div key={division.division} className="stat">
          <dt>{division.division === 'upper' ? 'Upper' : 'Lower'}</dt>
          <dd>
            {division.size} {division.poolCount > 0 && <span className="muted">· {division.poolCount} pools</span>}
          </dd>
        </div>
      ))}
      <div className="stat">
        <dt>Unresolved</dt>
        <dd>{view.entries.filter((entry) => entry.playerId === null).length}</dd>
      </div>
      <div className="stat">
        <dt>Warnings</dt>
        <dd>{view.issues.warnings.length}</dd>
      </div>
      <div className="stat">
        <dt>Brackets attached</dt>
        <dd>{attached.length}/4</dd>
      </div>
    </dl>
  );
}

function availableSteps(view: EventPlanView): Set<StepKey> {
  const steps = new Set<StepKey>(['roster']);
  if (view.plan.status !== 'draft') {
    steps.add('divisions');
    steps.add('handoff');
  }
  if (view.divisions.some((division) => division.pools.length > 0)) steps.add('pools');
  return steps;
}

function isStepKey(value: string | undefined): value is StepKey {
  return STEPS.some((step) => step.key === value);
}

/** Where an admin opening the plan cold should land. */
function furthestStep(view: EventPlanView | null): StepKey {
  if (!view || view.plan.status === 'draft') return 'roster';
  if (view.brackets.some((bracket) => bracket.challongeSlug !== null)) return 'handoff';
  if (view.plan.status === 'roster_frozen') return 'divisions';
  return 'pools';
}

/** `datetime-local` wants a local-time string, not an ISO instant. */
function defaultEventDate(): string {
  const now = new Date();
  now.setHours(18, 30, 0, 0);
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 16);
}

/**
 * Mirrors the server's `validUpperSizes`. Duplicated rather than imported
 * because apps/web deliberately depends on no server code; the server rejects
 * an invalid split regardless, so the worst this can be is out of date about
 * what to *offer*.
 */
function validUpperSizes(total: number, poolSize = 4): number[] {
  const minimum = Math.max(3, poolSize - 1);
  if (total < minimum * 2) return [];
  return Array.from({ length: total - minimum * 2 + 1 }, (_, index) => minimum + index);
}

function defaultUpperSize(total: number, poolSize = 4): number | null {
  const half = Math.ceil(total / 2);
  return validUpperSizes(total, poolSize).includes(half) ? half : null;
}
