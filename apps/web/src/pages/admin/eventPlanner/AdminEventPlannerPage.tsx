import { NativeFormatEditor } from './TournamentFormatFields';
import { isKnockout } from '@smashclub/shared';
import { NewPlanForm } from './NewPlanForm';
import { TournamentProjection } from './TournamentProjection';
import { DoublesRosterStep } from './DoublesRosterStep';
import { PlanRecoveryControls, DeletePlanButton } from './PlanRecoveryControls';
import { useConfirmation } from '../../../lib/confirmation';
import { Button } from '../../../components/ui/Button';
import { Disclosure } from '../../../components/ui/Disclosure';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { trpc } from '../../../lib/trpc';
import type { EventPlanView } from '../../../lib/apiTypes';
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
        onReopened={setPlanId}
      />
    );
  }

  return (
    <div>
      <div className="card section">
        <h2>Event planner</h2>
        <p className="muted">
          Plan singles or doubles, resolve the roster, and freeze the seeds. Nemesis supports open
          round robins, open pools with finals, and Upper/Lower pools with finals.
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
                <Button size="small" type="button" onClick={() => setPlanId(plan.id)}>
                  Open
                </Button>
                <span className="plan-name">{plan.name}</span>
                <span className="muted">{formatDate(plan.eventDate)}</span>
                <span className="chip">{STATUS_LABEL[plan.status] ?? plan.status}</span>
                <span className="muted">{plan.entryCount} entrants</span>
                <DeletePlanButton planId={plan.id} name={plan.name} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PlanWizard({
  planId,
  step,
  onStep,
  onBack,
  onReopened,
}: {
  planId: string;
  step: string | undefined;
  onStep: (step: StepKey) => void;
  onBack: () => void;
  onReopened: (planId: string) => void;
}) {
  const confirmAction = useConfirmation();
  const queryClient = useQueryClient();
  const planQuery = useQuery({
    queryKey: ['admin', 'eventPlanner', 'plan', planId],
    queryFn: () => trpc.admin.eventPlanner.plan.query({ planId }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'eventPlanner'] });

  const close = useMutation({
    mutationFn: (status: 'complete' | 'cancelled') =>
      trpc.admin.eventPlanner.closePlan.mutate({ planId, status }),
    onSuccess: invalidate,
  });

  const view = planQuery.data ?? null;
  const requestedStep = isStepKey(step) ? step : furthestStep(view);
  const current =
    view?.plan.historicalAdoption && requestedStep === 'handoff' ? 'roster' : requestedStep;

  if (planQuery.isPending) return <p className="loading-text">Loading plan…</p>;
  if (planQuery.isError) return <p className="error-text">{planQuery.error.message}</p>;
  if (!view) {
    return (
      <div className="card">
        <p className="muted">That plan no longer exists.</p>
        <Button type="button" onClick={onBack}>
          Back to plans
        </Button>
      </div>
    );
  }

  const available = availableSteps(view);
  const adopted = view.plan.historicalAdoption;
  const resultsSlug = view.brackets.find(
    (bracket) => bracket.division === 'upper' && bracket.stage === 'main',
  )?.challongeSlug;
  const resultsUrl = resultsSlug ? `/events/${encodeURIComponent(resultsSlug)}` : null;
  const steps = adopted ? STEPS.filter((entry) => entry.key !== 'handoff') : STEPS;
  const originalPlan = (
    <>
      <PlanSummary view={view} />
      <nav className="planner-steps" aria-label={adopted ? 'Original plan steps' : 'Planner steps'}>
        {steps.map((entry) => (
          <Button
            key={entry.key}
            type="button"
            className={`admin-tab${current === entry.key ? ' active' : ''}`}
            disabled={!available.has(entry.key)}
            onClick={() => onStep(entry.key)}
          >
            {entry.key === 'handoff' && view.plan.bracketMode === 'native'
              ? 'Run event'
              : entry.key === 'pools' && isKnockout(view.plan.structure)
                ? 'Draw'
                : entry.label}
          </Button>
        ))}
      </nav>
    </>
  );
  const stepContent = (
    <>
      {current === 'roster' &&
        view.plan.status === 'draft' &&
        view.plan.bracketMode === 'native' && (
          <NativeFormatEditor view={view} onChanged={invalidate} />
        )}
      {current === 'roster' &&
        (view.plan.competitionFormat === 'doubles' ? (
          <DoublesRosterStep view={view} onChanged={invalidate} />
        ) : (
          <RosterStep view={view} onChanged={invalidate} />
        ))}
      {current === 'divisions' && <DivisionsStep view={view} onChanged={invalidate} />}
      {current === 'pools' && <PoolsStep view={view} onChanged={invalidate} />}
      {current === 'handoff' && <HandoffStep view={view} onChanged={invalidate} />}
    </>
  );

  return (
    <div>
      <div className="card section">
        <div className="page-header">
          <h2>
            {view.plan.name}{' '}
            <span className="chip">
              {view.plan.status === 'pools_ready' && isKnockout(view.plan.structure)
                ? 'Draw ready'
                : (STATUS_LABEL[view.plan.status] ?? view.plan.status)}
            </span>{' '}
            {['pools_ready', 'underway'].includes(view.plan.status) && (
              <span className="chip">Draw: {view.plan.softLockedAt ? 'soft-locked' : 'draft'}</span>
            )}
          </h2>
          <span className="row-actions">
            {adopted ? (
              resultsUrl && (
                <a className="btn btn-small" href={resultsUrl}>
                  Imported results →
                </a>
              )
            ) : (
              <a className="btn btn-small" href={`/admin/event-operations?plan=${planId}`}>
                Run event →
              </a>
            )}
            {view.plan.bracketMode !== 'native' &&
              (view.plan.status === 'pools_ready' || view.plan.status === 'underway') && (
                <Button
                  size="small"
                  type="button"
                  disabled={close.isPending}
                  title="The night is played and synced"
                  onClick={() => close.mutate('complete')}
                >
                  Mark complete
                </Button>
              )}
            {view.plan.status !== 'complete' && view.plan.status !== 'cancelled' && (
              <Button
                size="small"
                type="button"
                disabled={close.isPending}
                onClick={async () => {
                  if (
                    await confirmAction(
                      'Cancel this plan? It stays as a record but can no longer be run.',
                    )
                  ) {
                    close.mutate('cancelled');
                  }
                }}
              >
                Cancel plan
              </Button>
            )}
            <Button size="small" type="button" onClick={onBack}>
              All plans
            </Button>
          </span>
        </div>
        <p className="muted">
          {formatDateTime(view.plan.eventDate)} · {view.entries.length}{' '}
          {adopted ? 'planned entrants' : 'entrants'}
          {view.plan.rankingSnapshotAt &&
            ` · ranking snapshot ${formatDateTime(view.plan.rankingSnapshotAt)}`}
        </p>
        {close.isError && <p className="error-text">{close.error.message}</p>}
        {!adopted && originalPlan}
      </div>

      {!adopted &&
        view.plan.bracketMode === 'native' &&
        ['draft', 'roster_frozen', 'pools_ready'].includes(view.plan.status) && (
          <TournamentProjection
            entrantCount={view.entries.length}
            competitionFormat={view.plan.competitionFormat ?? 'singles'}
            structure={view.plan.structure ?? 'dual_division'}
            structureOptions={view.plan.structureOptions}
            upperSize={view.plan.upperTargetSize}
            eventDate={view.plan.eventDate}
          />
        )}
      <PlanRecoveryControls
        planId={planId}
        name={view.plan.name}
        onDeleted={() => {
          invalidate();
          onBack();
        }}
        onReopened={(id) => {
          invalidate();
          onReopened(id);
        }}
      />
      {view.plan.status !== 'cancelled' &&
        (adopted ||
          ((view.plan.structure ?? 'dual_division') === 'dual_division' &&
            view.plan.structureOptions?.consolation !== false)) && (
          <HistoricalAdoption view={view} onChanged={invalidate} />
        )}
      {adopted ? (
        <Disclosure
          title="Original plan — may differ from the event played"
          className="historical-original-plan card section"
        >
          <p className="muted">
            These are the saved roster, seeds and proposed pools. Use the imported results above for
            the matches and placements that actually happened.
          </p>
          {originalPlan}
          {stepContent}
        </Disclosure>
      ) : (
        stepContent
      )}
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
          <dt>
            {view.plan.structure && view.plan.structure !== 'dual_division'
              ? 'Open'
              : division.division === 'upper'
                ? 'Upper'
                : 'Lower'}
          </dt>
          <dd>
            {division.size}{' '}
            {division.poolCount > 0 && <span className="muted">· {division.poolCount} pools</span>}
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
      {view.plan.bracketMode !== 'native' && (
        <div className="stat">
          <dt>Brackets attached</dt>
          <dd>
            {attached.length}/{view.brackets.length}
          </dd>
        </div>
      )}
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
  if (isKnockout(view.plan.structure) && view.plan.status !== 'draft') steps.add('pools');
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
