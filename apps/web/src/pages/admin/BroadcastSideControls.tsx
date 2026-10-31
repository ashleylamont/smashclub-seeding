import { useRef } from 'react';
import { Button } from '../../components/ui/Button';
import { CharacterIcons } from '../../components/CharacterIcons';
import { broadcastPlayers } from '../../lib/broadcastPlayers';
import { trpc } from '../../lib/trpc';
import type { Overview } from './dispatchTypes';

export function BroadcastSideControls({
  data,
  match,
  disabled,
  act,
}: {
  data: Overview;
  match: Overview['matches'][number];
  disabled: boolean;
  act: (work: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const retry = useRef<{ input: string; requestId: string } | null>(null);
  const display = broadcastPlayers(data, match)!;
  const native = data.plan.bracketMode === 'native';
  return (
    <section className="ops-broadcast-sides" aria-label="Overlay player order">
      <h4>Overlay left / right</h4>
      <div className="ops-broadcast-preview">
        {(
          [
            ['Left', display.left],
            ['Right', display.right],
          ] as const
        ).map(([side, player]) => (
          <div key={side} role="group" aria-label={`${side} player`}>
            <span>{side}</span>
            <strong>{player.name ?? 'Awaiting player'}</strong>
            <CharacterIcons slugs={player.characters} />
            <b>{player.score ?? '—'}</b>
          </div>
        ))}
      </div>
      {native ? (
        <>
          <Button
            disabled={disabled || !match.stationId || !match.player1Id || !match.player2Id}
            onClick={() => {
              if (!match.stationId || !match.player1Id || !match.player2Id) return;
              const command = {
                kind: 'broadcastSides' as const,
                stationId: match.stationId,
                matchId: match.id,
                player1Id: match.player1Id,
                player2Id: match.player2Id,
                expectedMatchRevision: match.revision,
                expectedRevision: display.revision,
                swapped: !display.swapped,
              };
              const input = JSON.stringify(command);
              if (retry.current?.input !== input)
                retry.current = { input, requestId: crypto.randomUUID() };
              const requestId = retry.current.requestId;
              void act(async () => {
                await trpc.eventOps.live.command.mutate({
                  planId: data.plan.id,
                  requestId,
                  command,
                });
                retry.current = null;
              }, 'Overlay player order saved');
            }}
          >
            Swap players / sides
          </Button>
          <p className="muted">
            Display only. Score entry and recorded results keep their player order. The next pairing
            starts in normal order.
          </p>
        </>
      ) : (
        <p className="muted">
          Side swapping requires a native event journal. This event keeps the recorded player order.
        </p>
      )}
    </section>
  );
}
