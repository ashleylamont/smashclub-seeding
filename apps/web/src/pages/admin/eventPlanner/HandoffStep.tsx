import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { trpc } from '../../../lib/trpc';
import type { EventPlanBracket, EventPlanBracketExport, EventPlanView } from '../../../lib/apiTypes';
import { formatDate } from '../../../lib/format';
import { CopyBlock } from './shared';
import { DIVISION_LABEL } from './labels';

/**
 * Step 6: the handoff to Challonge.
 *
 * Entirely manual, and that is the design. The first live event has to be
 * finishable with no API credentials and no quota, so what this screen offers
 * is a payload to paste, a checklist to follow, and a field to paste the
 * resulting slug back into. API creation is additive and comes later; when it
 * arrives these payloads stay exactly where they are.
 */

export function HandoffStep({ view, onChanged }: { view: EventPlanView; onChanged: () => void }) {
  const exportsQuery = useQuery({
    queryKey: ['admin', 'eventPlanner', 'exports', view.plan.id],
    enabled: view.plan.bracketMode !== 'native',
    queryFn: () => trpc.admin.eventPlanner.exports.query({ planId: view.plan.id }),
  });

  if (view.plan.bracketMode === 'native') return <div className="card section">
    <h3>Run this event in Nemesis</h3>
    <p>Record pool results in the event desk, confirm pool finishing orders, then preview championship and consolation draws. Winners advance automatically and byes are shown explicitly.</p>
    <a className="btn btn-primary" href={`/admin/event-operations?plan=${view.plan.id}`}>Open event desk</a>
  </div>;

  if (exportsQuery.isPending) return <p className="loading-text">Building exports…</p>;
  if (exportsQuery.isError) return <p className="error-text">{exportsQuery.error.message}</p>;

  const eventDates = new Set(
    view.brackets.filter((bracket) => bracket.tournamentEventDate).map((bracket) => bracket.tournamentEventDate),
  );

  return (
    <div>
      <div className="page-header">
        <h3>Challonge handoff</h3>
        <span className="muted">Event date {formatDate(view.plan.eventDate)}</span>
      </div>

      {eventDates.size > 1 && (
        <div className="banner banner-danger">
          The attached brackets do not all carry the same event date, so the ratings engine will read them as
          more than one club night. Re-attach them from here to fix it.
        </div>
      )}
      {view.brackets.some((bracket) => bracket.tournamentIsRookie) && (
        <div className="banner banner-danger">
          One of these brackets is flagged as the rookie bracket. Upper and Lower are competitive divisions —
          clear the flag in Admin → Tournaments.
        </div>
      )}

      {exportsQuery.data.brackets.map((bracketExport) => {
        const bracket = view.brackets.find(
          (entry) => entry.division === bracketExport.division && entry.stage === bracketExport.stage,
        )!;
        return (
          <BracketCard
            key={`${bracketExport.division}-${bracketExport.stage}`}
            planId={view.plan.id}
            bracket={bracket}
            closed={view.plan.status === 'complete' || view.plan.status === 'cancelled'}
            payload={bracketExport}
            onChanged={onChanged}
          />
        );
      })}

      <div className="card section">
        <h4>Pool cards</h4>
        <p className="muted">Print or save these — they are the fallback if the venue’s connection drops.</p>
        <CopyBlock
          label="All pools"
          rows={Math.min(24, exportsQuery.data.poolCards.length * 6)}
          text={exportsQuery.data.poolCards
            .map((card) => [card.label, ...card.lines].join('\n'))
            .join('\n\n')}
        />
      </div>
    </div>
  );
}

function BracketCard({
  planId,
  bracket,
  closed,
  payload,
  onChanged,
}: {
  planId: string;
  bracket: EventPlanBracket;
  closed: boolean;
  payload: EventPlanBracketExport;
  onChanged: () => void;
}) {
  const [slug, setSlug] = useState(bracket.challongeSlug ?? '');

  const attach = useMutation({
    mutationFn: () =>
      trpc.admin.eventPlanner.attachBracket.mutate({
        planId,
        division: bracket.division,
        stage: bracket.stage,
        challongeSlug: slug.trim(),
      }),
    onSuccess: onChanged,
  });

  const detach = useMutation({
    mutationFn: () =>
      trpc.admin.eventPlanner.detachBracket.mutate({
        planId,
        division: bracket.division,
        stage: bracket.stage,
      }),
    onSuccess: () => {
      setSlug('');
      onChanged();
    },
  });

  const sync = useMutation({
    mutationFn: () => trpc.admin.syncNow.mutate({ tournamentId: bracket.tournamentId!, useApi: true }),
    onSuccess: onChanged,
  });

  const ready = payload.participants !== '';

  return (
    <div className="card section bracket-card">
      <div className="page-header">
        <h4>
          {DIVISION_LABEL[bracket.division]} {bracket.stage === 'main' ? 'Main' : 'Consolation'}{' '}
          <span className={`chip state-${bracket.externalState}`}>{bracket.externalState}</span>
        </h4>
        {bracket.challongeSlug && (
          <a
            className="btn btn-small"
            href={`https://challonge.com/${bracket.challongeSlug}`}
            target="_blank"
            rel="noreferrer"
          >
            Open in Challonge
          </a>
        )}
      </div>

      <ol className="bracket-checklist">
        {payload.checklist.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>

      {ready ? (
        <div className="bracket-payloads">
          <CopyBlock
            label="Participants, in seed order"
            text={payload.participants}
            hint="Paste into Challonge’s bulk-add box. These are public aliases, which is what identity sync will match on the way back."
          />
          <CopyBlock label="Seed audit (seed ⇥ name)" text={payload.audit} />
        </div>
      ) : (
        <p className="muted">Nothing to export yet — see the checklist above.</p>
      )}

      <div className="admin-form-row">
        <input
          className="input"
          placeholder={payload.suggestedSlug}
          value={slug}
          aria-label={`Challonge slug for ${DIVISION_LABEL[bracket.division]} ${bracket.stage}`}
          onChange={(event) => setSlug(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={closed || slug.trim() === '' || attach.isPending}
          onClick={() => attach.mutate()}
          title="Register this bracket against the plan’s event date"
        >
          {attach.isPending ? 'Registering…' : bracket.challongeSlug ? 'Re-attach' : 'Register & attach'}
        </button>
        {bracket.tournamentId && (
          <button type="button" className="btn" disabled={closed || sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? 'Syncing…' : 'Sync (API)'}
          </button>
        )}
        {bracket.challongeSlug && (
          <button type="button" className="btn" disabled={closed || detach.isPending} onClick={() => detach.mutate()}>
            Detach
          </button>
        )}
      </div>
      {attach.isError && <p className="error-text">{attach.error.message}</p>}
      {sync.isError && <p className="error-text">{sync.error.message}</p>}
      {detach.isError && <p className="error-text">{detach.error.message}</p>}
      {bracket.tournamentEventDate && (
        <p className="muted">
          Registered for {formatDate(bracket.tournamentEventDate)} · sync {bracket.tournamentSyncState}
        </p>
      )}
      {bracket.lastError && <p className="error-text">{bracket.lastError}</p>}
    </div>
  );
}
