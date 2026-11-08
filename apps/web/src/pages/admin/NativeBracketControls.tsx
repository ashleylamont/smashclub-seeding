import { UntakenCallRecovery, type UntakenCallDesk } from './UntakenCallRecovery';
import { StrengthFinalsReview } from './StrengthFinalsReview';
import { EventBracketLane } from '../../components/EventBracketLane';
import { qualifierLabel } from '../../lib/qualification';
import { matchPresentation } from '../../lib/matchPresentation';
import { Notice } from '../../components/ui/Feedback';
import type { Overview } from './dispatchTypes';
import type { PoolQualifier } from '../../lib/eventDisplay';
import { isKnockout } from '@smashclub/shared';
import { useConfirmation } from '../../lib/confirmation';
import { Button } from '../../components/ui/Button';
import { Select, SelectItem } from '../../components/ui/Select';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
import '../../styles/event-board.css';
import './NativeBracketControls.css';

type ServerPreview = Awaited<ReturnType<typeof trpc.eventOps.native.preview.query>>;
type Preview = ServerPreview & { requestId: string };
type DivisionRemoval = Extract<ServerPreview, { seedPolicy: string }>['divisionResets'][number];
type ResetInput = Parameters<typeof trpc.eventOps.native.reset.mutate>[0];
const divisionName = (division: DivisionRemoval['scope']['division']) =>
  division === 'upper' ? 'Upper' : 'Lower';

/** Only render for native events; remote handoff remains a separate workflow. */
export function NativeBracketControls({
  data,
  closed,
  dispatchDisabled,
  callDesk,
}: {
  data: Overview;
  closed: boolean;
  dispatchDisabled: boolean;
  callDesk: UntakenCallDesk;
}) {
  const {
    plan: { id: planId, structure },
    entrants,
  } = data;
  const confirmAction = useConfirmation();
  const cache = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const combined = preview && 'seedPolicy' in preview ? preview : null;
  const entrantNames = new Map(entrants.map(({ id, name }) => [id, name]));
  const divisionLabel = (division: string) =>
    structure && structure !== 'dual_division' ? 'Open' : division;
  const stageLabel = (stage: string) => (stage === 'main' ? 'championship' : 'consolation');
  const name = (id: string | null, qualifier?: PoolQualifier) =>
    id?.startsWith('pending:')
      ? `Pool ${String.fromCharCode(65 + Number(id.split(':')[2]))} place ${id.split(':')[3]} TBD`
      : id
        ? (entrantNames.get(id) ?? 'Player')
        : qualifier
          ? qualifierLabel(qualifier)
          : 'Bye';
  const act = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      setMessage(success);
      await cache.invalidateQueries({ queryKey: ['eventOps', planId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update native brackets.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card native-finals-controls">
      <h3>
        {isKnockout(structure)
          ? 'Knockout results'
          : structure === 'round_robin'
            ? 'Round-robin results'
            : 'Championship and consolation'}
      </h3>
      {isKnockout(structure) ? (
        <p>
          The locked draw already contains the bracket. Complete all outstanding matches; a
          double-elimination reset final runs only when required.
        </p>
      ) : structure === 'round_robin' ? (
        <p>
          Complete every pool match. New draws decide a unique set-win order automatically; confirm
          any required tiebreak ruling in the planner. Then finalize the results.
        </p>
      ) : (
        <>
          <p>
            Preview the available finals and review their seeds before creating them. Confirm any
            required tiebreak rulings in the planner. Finalize the completed event to publish club
            results.
          </p>
          <Button
            type="submit"
            disabled={closed || busy}
            onClick={() =>
              void act(
                async () =>
                  setPreview({
                    ...(await trpc.eventOps.native.preview.query({
                      planId,
                      seedPolicy: 'pool_place_whr_v1',
                    })),
                    requestId: crypto.randomUUID(),
                  }),
                '',
              )
            }
          >
            Preview finals
          </Button>
          {preview && (
            <div className="section">
              {'rolling' in preview && <p>{preview.freezeWarning}</p>}
              {!combined && 'existing' in preview && preview.existing && (
                <p>
                  Finals already exist. Qualifiers update automatically; this preview preserves the
                  current draw.
                </p>
              )}
              {'poolOrders' in preview &&
                preview.poolOrders.map((pool) => (
                  <p key={pool.poolId} className="muted">
                    {structure && structure !== 'dual_division' ? 'Open' : pool.division} pool{' '}
                    {pool.poolIndex + 1}: {pool.reason}
                  </p>
                ))}
              {preview.issues.map((issue) => (
                <p key={issue} className="error-text">
                  {issue}
                </p>
              ))}
              {combined && (
                <>
                  <p>
                    Each bracket uses pool place and frozen WHR once its qualifiers are known.
                    Already created brackets keep their seeds.
                  </p>
                  {combined.waitingStages.map(({ division, stage, waiting }) => (
                    <p key={`${division}:${stage}`} className="muted">
                      {divisionLabel(division)} {stageLabel(stage)} is waiting for{' '}
                      {waiting.map(qualifierLabel).join(', ')}.
                    </p>
                  ))}
                </>
              )}
              {preview.brackets.map((bracket) => (
                <div key={`${bracket.division}:${bracket.stage}`}>
                  <h4>
                    {divisionLabel(bracket.division)} {stageLabel(bracket.stage)} ·{' '}
                    {'qualifierSlots' in bracket && bracket.qualifierSlots
                      ? bracket.qualifierSlots.length
                      : bracket.entrantIds.length}{' '}
                    entrants
                    {'alreadyDrawn' in bracket && bracket.alreadyDrawn ? ' · Created' : ''}
                  </h4>
                  {'previewMatches' in bracket && bracket.previewMatches.length ? (
                    <section className="app-event-board">
                      <p className="event-live-note">
                        Preview only.
                        {bracket.previewMatches.some((match) => match.nativeRound !== 1) &&
                          ' Scroll sideways to follow later rounds.'}
                      </p>
                      <EventBracketLane
                        matches={bracket.previewMatches.map((match) => ({
                          ...match,
                          player1Name: match.player1Id ? name(match.player1Id) : null,
                          player2Name: match.player2Id ? name(match.player2Id) : null,
                        }))}
                        lane="winners"
                        title=""
                        label={`${divisionLabel(bracket.division)} ${stageLabel(bracket.stage)} bracket preview`}
                        labels={
                          new Map(bracket.previewMatches.map((match) => [match.id, match.label]))
                        }
                      />
                    </section>
                  ) : bracket.roundOne.length ? (
                    <ol>
                      {bracket.roundOne.map((match, index) => (
                        <li key={index}>
                          {name(
                            match.player1Id,
                            'player1Qualifier' in match ? match.player1Qualifier : undefined,
                          )}{' '}
                          vs{' '}
                          {name(
                            match.player2Id,
                            'player2Qualifier' in match ? match.player2Qualifier : undefined,
                          )}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>
                      {bracket.entrantIds.length === 1
                        ? 'One entrant advances automatically.'
                        : 'No entrants in this bracket.'}
                    </p>
                  )}
                  {'strengthSeeding' in bracket &&
                    bracket.strengthSeeding &&
                    bracket.strengthSeeding.seeds.length > 0 && (
                      <StrengthFinalsReview
                        seeding={bracket.strengthSeeding}
                        name={name}
                        historical={
                          'alreadyDrawn' in bracket &&
                          bracket.alreadyDrawn &&
                          bracket.strengthSeeding.seeds.some(
                            ({ playerId }) => !bracket.entrantIds.includes(playerId),
                          )
                        }
                      />
                    )}
                </div>
              ))}
              <Button
                variant="primary"
                type="submit"
                disabled={closed || busy || !preview.allowed}
                onClick={async () => {
                  if (
                    combined &&
                    !(await confirmAction(
                      'Create the ready brackets with these seeds? Their eligible fields and seed order will be fixed.',
                    ))
                  )
                    return;
                  if (
                    'rolling' in preview &&
                    preview.brackets.some((bracket) =>
                      bracket.qualifierSlots?.some((source) => source.status !== 'resolved'),
                    ) &&
                    !(await confirmAction(preview.freezeWarning))
                  )
                    return;
                  void act(
                    async () => {
                      await trpc.eventOps.native.generate.mutate({
                        planId,
                        revisionToken: preview.revisionToken,
                        requestId: preview.requestId,
                        seedPolicy: combined?.seedPolicy,
                      });
                      setPreview(null);
                    },
                    combined
                      ? 'Ready finals created.'
                      : 'Finals are ready to progress as qualifiers resolve.',
                  );
                }}
              >
                {combined
                  ? 'Create ready finals'
                  : 'existing' in preview && preview.existing
                    ? 'Finals already created'
                    : preview.replacing
                      ? 'Replace unplayed finals with this draw'
                      : 'Create these finals'}
              </Button>
              {(preview.replacing || ('existing' in preview && preview.existing)) && (
                <FinalsResetControl
                  key={preview.requestId}
                  data={data}
                  preview={preview}
                  disabled={closed || busy}
                  dispatchDisabled={dispatchDisabled}
                  callDesk={callDesk}
                  onRemove={(input, success) =>
                    void act(async () => {
                      await trpc.eventOps.native.reset.mutate(input);
                      setPreview(null);
                    }, success)
                  }
                />
              )}
            </div>
          )}
        </>
      )}
      <p className="muted">
        When every bracket is finished, finalize once to publish the night into club results and
        ratings. Finalized results become read-only.
      </p>
      <Button
        type="submit"
        disabled={closed || busy}
        onClick={async () => {
          if (
            await confirmAction(
              'Finalize all results and close this event? Scores will become read-only and enter club ratings.',
            )
          )
            void act(
              () => trpc.eventOps.native.finalize.mutate({ planId }),
              'Event finalized. Club ratings are being recomputed.',
            );
        }}
      >
        Finalize native results
      </Button>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function FinalsResetControl({
  data,
  preview,
  disabled,
  dispatchDisabled,
  callDesk,
  onRemove,
}: {
  data: Overview;
  preview: Preview;
  disabled: boolean;
  dispatchDisabled: boolean;
  callDesk: UntakenCallDesk;
  onRemove: (input: ResetInput, success: string) => void;
}) {
  const [division, setDivision] = useState('');
  const confirmAction = useConfirmation();
  const removalRequest = useRef<{ revisionToken: string; requestId: string } | null>(null);
  const initialReview = resetReview(preview);
  // Returning a call invalidates the event queries. Refresh only removal metadata;
  // the creation preview and its request ID still refer to the draw the TO reviewed.
  const reset = useQuery({
    queryKey: ['eventOps', data.plan.id, 'finalsReset', preview.requestId],
    queryFn: async () =>
      resetReview(
        await trpc.eventOps.native.preview.query({
          planId: data.plan.id,
          seedPolicy: 'pool_place_whr_v1',
        }),
      ),
    initialData: () => initialReview,
    staleTime: Infinity,
    retry: false,
  });
  const original = initialReview.divisionResets.find(
    (review) => review.scope.division === division,
  );
  const selected = reset.data.divisionResets.find((review) => review.scope.division === division);
  // A refreshed token can reflect a returned call, but it must still describe
  // the persisted brackets from the full preview the organiser saw.
  const drawChanged = division
    ? !original || original.scope.bracketIds.join() !== selected?.scope.bracketIds.join()
    : initialReview.resetBracketIds.join() !== reset.data.resetBracketIds.join();
  const drawUnidentified = !division && initialReview.resetBracketIds.length === 0;
  const review = division ? selected : reset.data;
  const reviewUnavailable = disabled || reset.isFetching || reset.isError;
  const removalBlocked = reviewUnavailable || drawChanged || drawUnidentified;
  const currentCalls =
    data.operatorDispatch?.mode === 'shared'
      ? data.operatorDispatch.queue
          .filter((row) => row.state === 'called')
          .map((row) => row.matchId)
      : [];
  const calls =
    division || drawChanged || drawUnidentified
      ? []
      : data.matches.filter(
          ({ id }) => reset.data.resetCallMatchIds.includes(id) && currentCalls.includes(id),
        );

  return (
    <section className="finals-reset-actions" aria-label="Finals removal">
      {reset.isError && (
        <Notice tone="danger">Could not refresh the removal preview. Preview finals again.</Notice>
      )}
      {initialReview.divisionResets.length > 0 && (
        <label className="finals-reset-scope">
          Finals to remove
          <Select value={division} onValueChange={setDivision} disabled={reviewUnavailable}>
            <SelectItem value="">All finals</SelectItem>
            {initialReview.divisionResets.map(({ scope }) => (
              <SelectItem key={scope.division} value={scope.division}>
                {divisionName(scope.division)} finals only
              </SelectItem>
            ))}
          </Select>
        </label>
      )}
      {drawChanged ? (
        <Notice tone="warning">The selected draw changed. Preview finals again.</Notice>
      ) : drawUnidentified && review?.resetAllowed ? (
        <Notice tone="warning">Preview finals again before removing this draw.</Notice>
      ) : null}
      {!drawChanged && review && review.resetIssues.length > 0 && (
        <ul>
          {review.resetIssues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {selected && !drawChanged && !reviewUnavailable && (
        <UntakenCallRecovery
          matchIds={selected.resetCallMatchIds}
          desk={callDesk}
          showInstructions={false}
        />
      )}
      {calls.length > 0 && (
        <ul className="ops-pause-calls">
          {calls.map((match) => {
            const pairing = matchPresentation(match).title;
            return (
              <li key={match.id}>
                <span>{pairing}</span>
                <Button
                  size="small"
                  disabled={disabled || dispatchDisabled || reset.isFetching || reset.isError}
                  aria-label={`Open call for ${pairing}`}
                  onClick={() => callDesk.open(match.id)}
                >
                  Open call
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        disabled={removalBlocked || !review?.resetAllowed}
        onClick={async () => {
          if (removalBlocked || !review?.resetAllowed) return;
          const { revisionToken } = review;
          const planId = data.plan.id;
          if (!selected) {
            if (await confirmAction('Remove the unplayed finals? Pool results will stay recorded.'))
              onRemove(
                { planId, revisionToken },
                'Unplayed finals removed. Pool orders and attendance can now be corrected.',
              );
            return;
          }
          const { scope } = selected;
          const name = divisionName(scope.division);
          if (
            !(await confirmAction(
              `Remove the unplayed ${name} finals? Pool results and the other division will stay recorded.`,
            ))
          )
            return;
          if (removalRequest.current?.revisionToken !== revisionToken)
            removalRequest.current = { revisionToken, requestId: crypto.randomUUID() };
          onRemove(
            { planId, revisionToken, scope, requestId: removalRequest.current.requestId },
            `Unplayed ${name} finals removed. Make any pool corrections before previewing a new draw.`,
          );
        }}
      >
        {original
          ? `Remove unplayed ${divisionName(original.scope.division)} finals`
          : 'Remove unplayed finals'}
      </Button>
    </section>
  );
}

function resetReview(preview: ServerPreview) {
  return {
    resetAllowed: preview.resetAllowed,
    resetBracketIds: preview.resetBracketIds ?? [],
    resetIssues: preview.resetIssues,
    resetCallMatchIds: preview.resetCallMatchIds,
    divisionResets: 'divisionResets' in preview ? (preview.divisionResets ?? []) : [],
    revisionToken:
      'resetRevisionToken' in preview ? preview.resetRevisionToken : preview.revisionToken,
  };
}
