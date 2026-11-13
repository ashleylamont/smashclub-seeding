import {
  isCharacterSlug,
  MAX_CHARACTERS_PER_SET_PLAYER,
  type SetCharacterPick,
} from '@smashclub/shared';
import { z } from 'zod';

export const setCharacterPicksSchema = z
  .array(
    z.object({
      playerId: z.uuid(),
      characters: z
        .array(z.string().refine(isCharacterSlug, 'Unknown fighter.'))
        .min(1)
        .max(MAX_CHARACTERS_PER_SET_PLAYER)
        .refine((slugs) => new Set(slugs).size === slugs.length, 'Choose each fighter once.'),
    }),
  )
  .min(1)
  .max(4)
  .refine(
    (picks) => new Set(picks.map(({ playerId }) => playerId)).size === picks.length,
    'Choose each player once.',
  )
  .optional();

export function sameSetCharacterPicks(
  first: SetCharacterPick[] | null | undefined,
  second: SetCharacterPick[] | null | undefined,
) {
  const previous = first ?? [];
  const next = second ?? [];
  return (
    previous.length === next.length &&
    previous.every(
      (pick, index) =>
        pick.playerId === next[index]!.playerId &&
        pick.characters.join(',') === next[index]!.characters.join(','),
    )
  );
}

export function validSetCharacterParticipants(
  picks: SetCharacterPick[] | undefined,
  playerIds: readonly (string | null)[],
  outcome: string,
) {
  return (
    !picks || (outcome === 'played' && picks.every((pick) => playerIds.includes(pick.playerId)))
  );
}
