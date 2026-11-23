import { players, type Db } from '@smashclub/db';
import { publicParticipantName, publicPlayerName } from '@smashclub/shared';
import { playerIdResolver } from '../identity/playerIds';
import { charactersByPlayer } from '../players/characters';

export interface ResultGraphicIdentity {
  teamName: string | null;
  members: { name: string; character: string | null }[];
}

type PublicDoublesMember = { playerId: string; name: string };

export interface PublicDoublesPair {
  teamName: string | null;
  members: [PublicDoublesMember, PublicDoublesMember];
}

type Participant = {
  id: string;
  playerId?: string | null;
  memberPlayerIds?: string[] | null;
  teamName?: string | null;
  cleanedName: string;
  canonicalName: string | null;
  displayName: string | null;
};

export async function publicParticipantNames(db: Db, rows: readonly Participant[]) {
  const presentation = await publicParticipantPresentation(db, rows);
  return new Map([...presentation].map(([id, { name }]) => [id, name]));
}

export async function publicParticipantPresentation(
  db: Db,
  rows: readonly Participant[],
  includeGraphics = false,
  eventCharacters?: ReadonlyMap<string, { character: string }>,
) {
  const profiles = await db.select().from(players);
  const names = new Map(profiles.map((p) => [p.id, publicPlayerName(p)]));
  const canonical = playerIdResolver(profiles);
  const active = new Set(profiles.filter((p) => p.status === 'active').map((p) => p.id));
  const characters = includeGraphics
    ? await charactersByPlayer(db, [
        ...new Set(
          rows
            .flatMap((p) =>
              p.memberPlayerIds?.length ? p.memberPlayerIds : p.playerId ? [p.playerId] : [],
            )
            .map(canonical)
            .filter((id) => names.has(id)),
        ),
      ])
    : undefined;
  return new Map(
    rows.map((p) => {
      const members = p.memberPlayerIds?.length
        ? p.memberPlayerIds.map((id) => {
            const playerId = canonical(id);
            return { playerId, name: names.get(playerId) ?? 'Player' };
          })
        : undefined;
      const name = members
        ? `${p.teamName ? `${p.teamName} (` : ''}${members
            .map((member) => member.name)
            .join(' / ')}${p.teamName ? ')' : ''}`
        : publicParticipantName(p);
      const [first, second] = members ?? [];
      const verifiedDoublesPair: PublicDoublesPair | undefined =
        members?.length === 2 &&
        first?.name &&
        second?.name &&
        first.playerId !== second.playerId &&
        active.has(first.playerId) &&
        active.has(second.playerId)
          ? { teamName: p.teamName ?? null, members: [first, second] }
          : undefined;
      const graphic: ResultGraphicIdentity | undefined = characters && {
        teamName: members ? (p.teamName ?? null) : null,
        members: members
          ? members.map(({ playerId, name }) => ({
              name,
              character:
                eventCharacters?.get(playerId)?.character ?? characters.get(playerId)?.[0] ?? null,
            }))
          : [
              {
                name,
                character: p.playerId
                  ? (eventCharacters?.get(canonical(p.playerId))?.character ??
                    characters.get(canonical(p.playerId))?.[0] ??
                    null)
                  : null,
              },
            ],
      };
      return [p.id, { name, graphic, verifiedDoublesPair }];
    }),
  );
}
