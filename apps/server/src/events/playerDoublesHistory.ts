import { eq } from 'drizzle-orm';
import { players, tournamentParticipants, tournaments, type Db } from '@smashclub/db';
import { publicPlayerName } from '@smashclub/shared';
import { nativeHistory } from './nativeHistory';
import { historicalPlayerIds } from '../identity/playerIds';

export async function playerDoublesHistory(db: Db, playerId: string) {
  const canonical = await historicalPlayerIds(db),
    history = await nativeHistory(db);
  const profiles = new Map((await db.select().from(players)).map((p) => [p.id, p]));
  const rows = await db
    .select({ participant: tournamentParticipants, tournament: tournaments })
    .from(tournamentParticipants)
    .innerJoin(tournaments, eq(tournamentParticipants.tournamentId, tournaments.id))
    .where(eq(tournaments.competitionFormat, 'doubles'));
  return rows
    .filter(
      (r) =>
        !history.superseded.has(r.tournament.id) &&
        r.participant.memberPlayerIds?.some((id) => canonical(id) === playerId),
    )
    .map(({ participant: p, tournament: t }) => ({
      tournamentId: t.id,
      name: t.name,
      slug: t.challongeSlug,
      eventDate: t.eventDate?.toISOString() ?? null,
      place: p.finalRank,
      pairName: p
        .memberPlayerIds!.map((id) => {
          const p = profiles.get(canonical(id));
          return p ? publicPlayerName(p) : 'Player';
        })
        .join(' / '),
    }))
    .sort(
      (a, b) =>
        (b.eventDate ?? '').localeCompare(a.eventDate ?? '') || a.name.localeCompare(b.name),
    );
}
