import { players, type Db } from '@smashclub/db';
import { publicParticipantName, publicPlayerName } from '@smashclub/shared';
import { playerIdResolver } from '../identity/playerIds';
import { charactersByPlayer } from '../players/characters';

export interface ResultGraphicIdentity {
  teamName: string | null;
  members: { name: string; character: string | null }[];
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
  const characters = includeGraphics
    ? await charactersByPlayer(db, [
        ...new Set(
          rows
            .flatMap((p) =>
              p.memberPlayerIds?.length ? p.memberPlayerIds : p.playerId ? [p.playerId] : [],
            )
            .map(canonical),
        ),
      ])
    : undefined;
  return new Map(
    rows.map((p) => {
      const team = p.memberPlayerIds?.length ? p.memberPlayerIds.map(canonical) : undefined;
      const name = team
        ? `${p.teamName ? `${p.teamName} (` : ''}${team
            .map((id) => names.get(id) ?? 'Player')
            .join(' / ')}${p.teamName ? ')' : ''}`
        : publicParticipantName(p);
      const graphic: ResultGraphicIdentity | undefined = characters && {
        teamName: team ? (p.teamName ?? null) : null,
        members: team
          ? team.map((id) => ({
              name: names.get(id) ?? 'Player',
              character: eventCharacters?.get(id)?.character ?? characters.get(id)?.[0] ?? null,
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
      return [p.id, { name, graphic }];
    }),
  );
}
