import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { trpc } from '../../lib/trpc';

export function DoublesAvailabilityControls({
  planId,
  members,
  closed,
  onChanged,
}: {
  planId: string;
  members?: {
    entrantId: string;
    playerId: string;
    name: string;
    availability: 'available' | 'snoozed';
    revision: number;
  }[];
  closed: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (!members?.length) return null;
  return (
    <section className="card">
      <h3>Doubles player availability</h3>
      <p>
        A snoozed player holds their pair’s matches. Use attendance controls to withdraw the whole
        pair.
      </p>
      <ul>
        {members.map((m) => (
          <li key={m.playerId}>
            {m.name} · {m.availability}{' '}
            <Button
              size="small"
              disabled={closed || busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await trpc.eventOps.live.command.mutate({
                    planId,
                    requestId: crypto.randomUUID(),
                    command: {
                      kind: 'availability',
                      playerId: m.playerId,
                      availability: m.availability === 'available' ? 'snoozed' : 'available',
                      expectedRevision: m.revision,
                      reason:
                        m.availability === 'available'
                          ? 'TO marked player away'
                          : 'TO marked player returned',
                    },
                  });
                  await onChanged();
                } catch (cause) {
                  setError(
                    cause instanceof Error ? cause.message : 'Could not update availability.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {m.availability === 'available' ? `Snooze ${m.name}` : `Mark ${m.name} available`}
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </section>
  );
}
