import { qualifierLabel } from '../../lib/qualification';
import type { PoolQualifier } from '../../lib/eventDisplay';
import { isKnockout } from '@smashclub/shared';
import { useConfirmation } from '../../lib/confirmation';
import { Button } from '../../components/ui/Button';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '../../lib/trpc';
type Preview = Awaited<ReturnType<typeof trpc.eventOps.native.preview.query>>;

/** Only render for native events; remote handoff remains a separate workflow. */
export function NativeBracketControls({
  planId,
  entrants,
  closed = false,
  structure,
}: {
  planId: string;
  entrants: { id: string; name: string }[];
  closed?: boolean;
  structure?: string;
}) {
  const confirmAction = useConfirmation();
  const cache = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const name = (id: string | null, qualifier?: PoolQualifier) =>
    id?.startsWith('pending:')
      ? `Pool ${String.fromCharCode(65 + Number(id.split(':')[2]))} place ${id.split(':')[3]} TBD`
      : id
        ? (entrants.find((p) => p.id === id)?.name ?? 'Player')
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
    <section className="card">
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
            Preview finals to reserve the full field. New draws fill confirmed pool places
            automatically; known finals can run while unrelated pools continue. Confirm any required
            tiebreak rulings in the planner. Publication into club results happens only when you
            finalize the completed event.
          </p>
          <Button
            type="submit"
            disabled={closed || busy}
            onClick={() =>
              void act(
                async () => setPreview(await trpc.eventOps.native.preview.query({ planId })),
                '',
              )
            }
          >
            Preview finals
          </Button>
          {preview && (
            <div className="section">
              {'rolling' in preview && <p>{preview.freezeWarning}</p>}
              {'existing' in preview && preview.existing && (
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
              {preview.brackets.map((bracket) => (
                <div key={`${bracket.division}:${bracket.stage}`}>
                  <h4>
                    {structure && structure !== 'dual_division' ? 'Open' : bracket.division}{' '}
                    {bracket.stage === 'main' ? 'championship' : 'consolation'} ·{' '}
                    {'qualifierSlots' in bracket && bracket.qualifierSlots
                      ? bracket.qualifierSlots.length
                      : bracket.entrantIds.length}{' '}
                    entrants
                  </h4>
                  {bracket.roundOne.length ? (
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
                    <p>No entrants in this bracket.</p>
                  )}
                </div>
              ))}
              <Button
                variant="primary"
                type="submit"
                disabled={closed || busy || !preview.allowed}
                onClick={async () => {
                  if (
                    'rolling' in preview &&
                    preview.brackets.some((bracket) =>
                      bracket.qualifierSlots?.some((source) => source.status !== 'resolved'),
                    ) &&
                    !(await confirmAction(preview.freezeWarning))
                  )
                    return;
                  void act(async () => {
                    await trpc.eventOps.native.generate.mutate({
                      planId,
                      revisionToken: preview.revisionToken,
                    });
                    setPreview(null);
                  }, 'Finals are ready to progress as qualifiers resolve.');
                }}
              >
                {'existing' in preview && preview.existing
                  ? 'Finals already created'
                  : preview.replacing
                    ? 'Replace unplayed finals with this draw'
                    : 'Create these finals'}
              </Button>
              {(preview.replacing || ('existing' in preview && preview.existing)) && (
                <Button
                  type="submit"
                  disabled={closed || busy || !preview.resetAllowed}
                  onClick={async () => {
                    if (
                      await confirmAction(
                        'Remove the unplayed finals? Pool results will stay recorded.',
                      )
                    )
                      void act(async () => {
                        await trpc.eventOps.native.reset.mutate({
                          planId,
                          revisionToken: preview.revisionToken,
                        });
                        setPreview(null);
                      }, 'Unplayed finals removed. Pool orders and attendance can now be corrected.');
                  }}
                >
                  Remove unplayed finals
                </Button>
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
