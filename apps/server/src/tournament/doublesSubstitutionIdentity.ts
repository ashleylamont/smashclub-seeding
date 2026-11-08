import { players, type Db } from '@smashclub/db';
import { publicPlayerName } from '@smashclub/shared';
import { playerIdResolver } from '../identity/playerIds';
import type { DoublesSubstitution } from './doublesSubstitution';
import type { TournamentState } from './schemas';

export async function captureSubstitutionIdentity(
  db: Db,
  state: TournamentState,
  input: Omit<DoublesSubstitution, 'identity'>,
): Promise<DoublesSubstitution['identity']> {
  const memberIds = state.entrants.find((e) => e.id === input.entrantId)?.memberPlayerIds;
  if (memberIds?.length !== 2 || !memberIds.includes(input.outgoingPlayerId)) return null;

  const profiles = await db
    .select({
      id: players.id,
      canonicalName: players.canonicalName,
      displayName: players.displayName,
      status: players.status,
      mergedIntoPlayerId: players.mergedIntoPlayerId,
    })
    .from(players);
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const incoming = byId.get(input.incomingPlayerId);
  const first = byId.get(memberIds[0]!);
  const second = byId.get(memberIds[1]!);
  if (!first || !second || incoming?.status !== 'active' || incoming.mergedIntoPlayerId)
    return null;
  const newFirst = first.id === input.outgoingPlayerId ? incoming : first;
  const newSecond = second.id === input.outgoingPlayerId ? incoming : second;
  if (newFirst.status !== 'active' || newSecond.status !== 'active') return null;

  const canonical = playerIdResolver(profiles);
  return {
    name: `${newFirst.canonicalName} / ${newSecond.canonicalName}`,
    oldMemberNames: [publicPlayerName(first), publicPlayerName(second)],
    newMemberNames: [publicPlayerName(newFirst), publicPlayerName(newSecond)],
    incomingAliases: profiles
      .filter(({ id, mergedIntoPlayerId }) => mergedIntoPlayerId && canonical(id) === incoming.id)
      .map(({ id }) => id)
      .sort(),
  };
}
