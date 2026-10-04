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
}: {
  planId: string;
  entrants: { id: string; name: string }[];
  closed?: boolean;
}) {
  const confirmAction = useConfirmation();
  const cache = useQueryClient();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const name = (id: string | null) =>
    id?.startsWith('pending:')
      ? `Pool ${String.fromCharCode(65 + Number(id.split(':')[2]))} place ${id.split(':')[3]} TBD`
      : id
        ? (entrants.find((p) => p.id === id)?.name ?? 'Player')
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
      <h3>Championship and consolation</h3>
      <p>
        Finals can start while pools are still playing. Unknown qualifiers stay blocked until their
        pool order is confirmed; then their places fill automatically. Top active entrants advance
        to championship, and the rest enter consolation. Bye winners advance automatically.
      </p>
      <Button
        type="submit"
        disabled={closed || busy}
        onClick={() =>
          void act(async () => setPreview(await trpc.eventOps.native.preview.query({ planId })), '')
        }
      >
        Preview finals
      </Button>
      {preview && (
        <div className="section">
          {preview.issues.map((issue) => (
            <p key={issue} className="error-text">
              {issue}
            </p>
          ))}
          {preview.brackets.map((bracket) => (
            <div key={`${bracket.division}:${bracket.stage}`}>
              <h4>
                {bracket.division} {bracket.stage === 'main' ? 'championship' : 'consolation'} ·{' '}
                {bracket.entrantIds.length} entrants
              </h4>
              {bracket.roundOne.length ? (
                <ol>
                  {bracket.roundOne.map((match, index) => (
                    <li key={index}>
                      {name(match.player1Id)} vs {name(match.player2Id)}
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
            onClick={() =>
              void act(async () => {
                await trpc.eventOps.native.generate.mutate({
                  planId,
                  revisionToken: preview.revisionToken,
                });
                setPreview(null);
              }, 'Finals are ready in the match queue.')
            }
          >
            {preview.replacing ? 'Replace unplayed finals with this draw' : 'Create these finals'}
          </Button>
          {preview.replacing && (
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
