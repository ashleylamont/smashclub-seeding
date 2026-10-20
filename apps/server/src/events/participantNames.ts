import { players, type Db } from '@smashclub/db';
import { publicParticipantName, publicPlayerName } from '@smashclub/shared';
import { historicalPlayerIds } from '../identity/playerIds';

export async function publicParticipantNames(
  db: Db,
  rows: readonly {
    id: string;
    memberPlayerIds?: string[] | null;
    teamName?: string | null;
    cleanedName: string;
    canonicalName: string | null;
    displayName: string | null;
  }[],
) {
  const profiles = new Map((await db.select().from(players)).map((p) => [p.id, p]));
  const canonical = await historicalPlayerIds(db);
  return new Map(
    rows.map((p) => [
      p.id,
      p.memberPlayerIds?.length
        ? `${p.teamName ? `${p.teamName} (` : ''}${p.memberPlayerIds
            .map((id) => {
              const player = profiles.get(canonical(id));
              return player ? publicPlayerName(player) : 'Player';
            })
            .join(' / ')}${p.teamName ? ')' : ''}`
        : publicParticipantName(p),
    ]),
  );
}
