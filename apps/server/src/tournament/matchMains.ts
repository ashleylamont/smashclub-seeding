import { TRPCError } from '@trpc/server';
import { playerCharacters, players, type Db } from '@smashclub/db';
import { publicPlayerName } from '@smashclub/shared';
import { and, eq, inArray, notExists } from 'drizzle-orm';
import { lockPlayerRows } from '../identity/playerIds';
import { charactersForPlayer } from '../players/characters';
import { matchMemberIds } from './entrants';
import { sharedDispatch } from './dispatch';
import type { Match, TournamentState } from './schemas';
import { leadingCharacters } from '../players/characterEvidence';
import type { SetCharacterPick } from '@smashclub/shared';

function canConfirmMatchMain(state: TournamentState, match: Match) {
  return (
    state.lifecycle === 'locked' &&
    match.status === 'playing' &&
    !match.skipped &&
    Boolean(match.player1Id && match.player2Id) &&
    (!sharedDispatch(state) || match.started)
  );
}

export async function missingMainsByMatch(
  db: Db,
  state: TournamentState,
  evidence: Iterable<SetCharacterPick[]>,
) {
  const playing = state.matches
    .filter((match) => canConfirmMatchMain(state, match))
    .map((match) => ({ id: match.id, memberIds: matchMemberIds(state, match) }));
  const ids = [...new Set(playing.flatMap(({ memberIds }) => memberIds))];
  if (!ids.length) return {};
  const profiles = await db
    .select({
      id: players.id,
      displayName: players.displayName,
      canonicalName: players.canonicalName,
    })
    .from(players)
    .where(
      and(
        inArray(players.id, ids),
        eq(players.status, 'active'),
        notExists(
          db
            .select({ id: playerCharacters.id })
            .from(playerCharacters)
            .where(eq(playerCharacters.playerId, players.id)),
        ),
      ),
    );
  const suggestions = leadingCharacters(evidence, 2);
  const candidates = new Map(
    profiles.map((profile) => [
      profile.id,
      {
        playerId: profile.id,
        name: publicPlayerName(profile),
        suggestion: suggestions.get(profile.id),
      },
    ]),
  );
  return Object.fromEntries(
    playing.map(({ id, memberIds }) => [
      id,
      memberIds.flatMap((memberId) => candidates.get(memberId) ?? []),
    ]),
  );
}

export function confirmMatchMain(
  db: Db,
  state: () => Promise<TournamentState>,
  input: { matchId: string; playerId: string; character: string },
) {
  return db.transaction(async (tx) => {
    const [player] = await lockPlayerRows(tx, [input.playerId]);
    const current = await state();
    const match = current.matches.find(({ id }) => id === input.matchId);
    if (
      player?.status !== 'active' ||
      !match ||
      !canConfirmMatchMain(current, match) ||
      !matchMemberIds(current, match).includes(input.playerId)
    )
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This player is no longer in the playing match.',
      });

    const existing = await charactersForPlayer(tx, input.playerId);
    if (existing[0] === input.character) return { ok: true };
    if (existing.length)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This player already has a main on their profile.',
      });
    await tx
      .insert(playerCharacters)
      .values({ playerId: input.playerId, characterSlug: input.character });
    return { ok: true };
  });
}
