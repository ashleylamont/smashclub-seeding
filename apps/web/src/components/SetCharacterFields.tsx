import { useState, type ReactNode } from 'react';
import {
  CHARACTERS,
  MAX_CHARACTERS_PER_SET_PLAYER,
  characterName,
  type SetCharacterPick,
} from '@smashclub/shared';
import type { ScoreReportPlayer } from '../lib/scoreReportPlayers';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Select, SelectItem } from './ui/Select';
import './SetCharacterFields.css';

const roster = [...CHARACTERS].sort((a, b) => a.name.localeCompare(b.name));

export type SetCharacterDraft = {
  players: ScoreReportPlayer[];
  picks: SetCharacterPick[];
  onChange: (picks: SetCharacterPick[]) => void;
};

export function SetCharacterFields({
  players,
  picks,
  onChange,
  disabled,
  triggerLabel,
  action,
  feedback,
  description = 'Add the fighters each player used in this set. Leave any player blank if you’re unsure.',
}: SetCharacterDraft & {
  disabled: boolean;
  triggerLabel?: string;
  action?: ReactNode;
  feedback?: ReactNode;
  description?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!players.length) return null;
  const edit = (id: string, characters: string[]) => {
    const next = new Map(picks.map((pick) => [pick.playerId, pick.characters]));
    next.set(id, characters);
    onChange(
      players.flatMap(({ id }) => {
        const selected = next.get(id);
        return selected?.length ? [{ playerId: id, characters: selected }] : [];
      }),
    );
  };
  const count = picks.reduce((total, pick) => total + pick.characters.length, 0);
  return (
    <Dialog
      title="Characters played"
      description={description}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button disabled={disabled}>
          {triggerLabel ?? (count ? `Edit characters (${count})` : 'Add characters (optional)')}
        </Button>
      }
    >
      <div className="set-character-fields">
        {players.map(({ id, name }) => {
          const selected = picks.find((pick) => pick.playerId === id)?.characters ?? [];
          return (
            <div className="set-character-player" key={id}>
              <strong>{name}</strong>
              {selected.length > 0 && (
                <div className="set-character-buttons">
                  {selected.map((slug) => (
                    <Button
                      key={slug}
                      size="small"
                      disabled={disabled}
                      aria-label={`Remove ${characterName(slug)} for ${name}`}
                      onClick={() =>
                        edit(
                          id,
                          selected.filter((item) => item !== slug),
                        )
                      }
                    >
                      {characterName(slug)} ×
                    </Button>
                  ))}
                </div>
              )}
              <Select
                aria-label={`Add fighter for ${name}`}
                value=""
                disabled={disabled || selected.length >= MAX_CHARACTERS_PER_SET_PLAYER}
                onValueChange={(slug) => {
                  if (slug && !selected.includes(slug)) edit(id, [...selected, slug]);
                }}
              >
                <SelectItem value="">Add fighter</SelectItem>
                {roster.map(({ slug, name }) => (
                  <SelectItem key={slug} value={slug} disabled={selected.includes(slug)}>
                    {name}
                  </SelectItem>
                ))}
              </Select>
            </div>
          );
        })}
      </div>
      {feedback}
      <div className="modal-actions">
        <Button onClick={() => setOpen(false)}>{action ? 'Close' : 'Done'}</Button>
        {action}
      </div>
    </Dialog>
  );
}
