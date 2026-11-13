import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CHARACTERS, characterName } from '@smashclub/shared';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Notice } from '../../components/ui/Feedback';
import { Select, SelectItem } from '../../components/ui/Select';
import { trpc } from '../../lib/trpc';
import type { Overview } from './dispatchTypes';

const roster = [...CHARACTERS].sort((a, b) => a.name.localeCompare(b.name));

export function MatchMainDialog({
  match,
  candidates,
  disabled,
}: {
  match: Overview['matches'][number];
  candidates: {
    playerId: string;
    name: string;
    suggestion?: { character: string; sets: number };
  }[];
  disabled: boolean;
}) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [playerId, setPlayerId] = useState('');
  const [character, setCharacter] = useState('');
  const player = candidates.find((entry) => entry.playerId === playerId);
  const save = useMutation({
    mutationFn: async ({
      playerId,
      name,
      character,
    }: {
      playerId: string;
      name: string;
      character: string;
    }) => {
      await trpc.eventOps.live.confirmMatchMain.mutate({
        planId: match.eventPlanId,
        matchId: match.id,
        playerId,
        character,
      });
      return `${characterName(character)} saved to ${name}’s profile.`;
    },
  });
  if (!open && candidates.length === 0) return null;

  function changeOpen(next: boolean) {
    if (save.isPending) return;
    setOpen(next);
    if (next) {
      setPlayerId(candidates.length === 1 ? candidates[0]!.playerId : '');
      setCharacter('');
      save.reset();
    } else if (save.isSuccess) {
      void cache.invalidateQueries({ queryKey: ['eventOps', match.eventPlanId] });
    }
  }

  return (
    <div className="ops-match-actions">
      <Dialog
        title="Confirm a player’s main"
        description="Ask the player which fighter they main. Saving adds it to their public profile."
        open={open}
        onOpenChange={changeOpen}
        trigger={
          <Button size="small" disabled={disabled || !candidates.length}>
            Confirm missing main
          </Button>
        }
      >
        {save.isSuccess ? (
          <>
            <Notice tone="success">{save.data}</Notice>
            <div className="modal-actions">
              <Button onClick={() => changeOpen(false)}>Done</Button>
            </div>
          </>
        ) : (
          <form
            className="match-main-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (player && character && !disabled && !save.isPending)
                save.mutate({ ...player, character });
            }}
          >
            {save.isError && <Notice tone="danger">{save.error.message}</Notice>}
            {playerId && !player && (
              <Notice tone="warning">This player is no longer eligible for a missing main.</Notice>
            )}
            <label>
              Player
              <Select
                value={player?.playerId ?? ''}
                disabled={disabled || save.isPending || !candidates.length}
                onValueChange={(id) => {
                  setPlayerId(id);
                  setCharacter('');
                  save.reset();
                }}
              >
                <SelectItem value="">Choose a player</SelectItem>
                {candidates.map((entry) => (
                  <SelectItem key={entry.playerId} value={entry.playerId}>
                    {entry.name}
                  </SelectItem>
                ))}
              </Select>
            </label>
            {player?.suggestion && (
              <div>
                <p>
                  {characterName(player.suggestion.character)} reported in {player.suggestion.sets}{' '}
                  sets this event.
                </p>
                <Button
                  disabled={disabled || save.isPending}
                  onClick={() => setCharacter(player.suggestion!.character)}
                >
                  Use suggested fighter
                </Button>
              </div>
            )}
            <label>
              Main character
              <Select
                value={character}
                disabled={disabled || save.isPending || !player}
                onValueChange={setCharacter}
              >
                <SelectItem value="">Choose a character</SelectItem>
                {roster.map(({ slug, name }) => (
                  <SelectItem key={slug} value={slug}>
                    {name}
                  </SelectItem>
                ))}
              </Select>
            </label>
            <div className="modal-actions">
              <Button disabled={save.isPending} onClick={() => changeOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={disabled || !player || !character}
                pending={save.isPending}
              >
                {save.isPending ? 'Saving…' : 'Save confirmed main'}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
