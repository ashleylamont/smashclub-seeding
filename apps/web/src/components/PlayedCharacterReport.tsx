import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SetCharacterPick } from '@smashclub/shared';
import { trpc } from '../lib/trpc';
import type { ScoreReportPlayer } from '../lib/scoreReportPlayers';
import { SetCharacterFields } from './SetCharacterFields';
import { Button } from './ui/Button';
import { Notice } from './ui/Feedback';

type Target = Parameters<typeof trpc.me.reportPlayedCharacters.mutate>[0]['target'];

export function PlayedCharacterReport({
  target,
  players,
}: {
  target: Target;
  players: ScoreReportPlayer[];
}) {
  const [picks, setPicks] = useState<SetCharacterPick[]>([]);
  const cache = useQueryClient();
  const save = useMutation({
    mutationFn: (picks: SetCharacterPick[]) =>
      trpc.me.reportPlayedCharacters.mutate({ target, picks }),
    onSuccess: async () => {
      await cache.invalidateQueries({
        predicate: (query) =>
          ['player', 'tournament', 'eventOverview', 'eventOpsPublic', 'eventOps'].includes(
            String(query.queryKey[0]),
          ),
      });
    },
  });
  return (
    <SetCharacterFields
      players={players}
      picks={picks}
      onChange={(next) => {
        setPicks(next);
        save.reset();
      }}
      disabled={save.isPending}
      triggerLabel="Report characters played"
      description="Add the fighters you remember. Saving replaces your previous character report for this set."
      action={
        <Button
          variant="primary"
          disabled={!picks.length}
          pending={save.isPending}
          onClick={() => save.mutate(picks)}
        >
          {save.isPending ? 'Saving…' : 'Save character report'}
        </Button>
      }
      feedback={
        save.isError ? (
          <Notice tone="danger">{save.error.message}</Notice>
        ) : save.isSuccess ? (
          <Notice tone="success">Character report saved.</Notice>
        ) : null
      }
    />
  );
}
