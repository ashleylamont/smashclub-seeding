import type { ResultGraphicIdentity } from '../events/participantNames';
import { memberIds } from './entrants';
import type { TournamentState } from './schemas';

export function eventEntrantViews(
  state: TournamentState,
  names: ReadonlyMap<string, string>,
  companyCodes: ReadonlyMap<string, string>,
  characters: readonly { playerId: string; characterSlug: string }[],
  eventCharacters: ReadonlyMap<string, { character: string }>,
) {
  const placedIds = new Set(state.pools.flatMap(({ order }) => order ?? []));
  return state.entrants.map((entrant) => ({
    id: entrant.playerId,
    name: names.get(entrant.playerId) ?? 'Player',
    memberPlayerIds: entrant.memberPlayerIds,
    companyCode: entrant.memberPlayerIds ? undefined : companyCodes.get(entrant.playerId),
    ...(placedIds.has(entrant.playerId) && {
      graphic: {
        teamName: entrant.teamName ?? null,
        members: memberIds(entrant).map((id) => ({
          name: names.get(id) ?? 'Player',
          character:
            eventCharacters.get(id)?.character ??
            characters.find((row) => row.playerId === id)?.characterSlug ??
            null,
        })),
      } satisfies ResultGraphicIdentity,
    }),
  }));
}
