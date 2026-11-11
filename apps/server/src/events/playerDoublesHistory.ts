import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { players, sets, tournamentParticipants, tournaments, type Db } from '@smashclub/db';
import { playerSetScore } from './playerSetScore';
import { hasSupersededAdvancement } from '../tournament/resultEvidence';
import { publicPlayerName, unplayedResultOutcome } from '@smashclub/shared';
import { nativeHistory } from './nativeHistory';
import { playerIdResolver } from '../identity/playerIds';

export async function playerDoublesHistory(db: Db, playerId: string) {
  const profiles = await db
    .select({
      id: players.id,
      mergedIntoPlayerId: players.mergedIntoPlayerId,
      canonicalName: players.canonicalName,
      displayName: players.displayName,
    })
    .from(players);
  const canonical = playerIdResolver(profiles);
  const history = await nativeHistory(db);
  const names = new Map(profiles.map((profile) => [profile.id, publicPlayerName(profile)]));
  const rows = await db
    .select({ participant: tournamentParticipants, tournament: tournaments })
    .from(tournamentParticipants)
    .innerJoin(tournaments, eq(tournamentParticipants.tournamentId, tournaments.id))
    .where(eq(tournaments.competitionFormat, 'doubles'));
  const memberships = rows.filter(
    ({ tournament, participant }) =>
      !history.superseded.has(tournament.id) &&
      participant.memberPlayerIds?.some((id) => canonical(id) === playerId),
  );
  const ids = memberships.map(({ participant }) => participant.id);
  const ownTeams = new Set(ids);
  const pairName = (participant: (typeof rows)[number]['participant']) => {
    const aliases = participant.memberPlayerIds
      ?.map((id) => names.get(canonical(id)) ?? 'Player')
      .join(' / ');
    if (!aliases) return 'Pair';
    return participant.teamName ? `${participant.teamName} (${aliases})` : aliases;
  };
  if (!ids.length) return { results: [], matches: [] };

  const byParticipant = new Map(rows.map((row) => [row.participant.id, row]));
  const matchRows = await db
    .select()
    .from(sets)
    .where(
      and(
        eq(sets.state, 'complete'),
        or(inArray(sets.p1ParticipantId, ids), inArray(sets.p2ParticipantId, ids)),
      ),
    )
    .orderBy(desc(sets.completedAt), desc(sets.suggestedPlayOrder), desc(sets.challongeMatchId));
  // Native publication copies pool rows into the main archive. Only finals
  // evidence or an official place establishes membership in that bracket.
  const finalParticipantIds = new Set(
    matchRows
      .filter((row) => row.resultStage === 'final' && !hasSupersededAdvancement(row.raw))
      .flatMap((row) => [row.p1ParticipantId, row.p2ParticipantId]),
  );
  const results = memberships
    .filter(
      ({ tournament, participant }) =>
        tournament.provider !== 'native' ||
        (tournament.raw as { structure?: string } | null)?.structure === 'round_robin' ||
        finalParticipantIds.has(participant.id),
    )
    .map(({ participant, tournament }) => ({
      tournamentId: tournament.id,
      name: tournament.name,
      slug: tournament.challongeSlug,
      eventDate: tournament.eventDate?.toISOString() ?? null,
      place: participant.finalRank,
      pairName: pairName(participant),
    }))
    .sort(
      (a, b) =>
        (b.eventDate ?? '').localeCompare(a.eventDate ?? '') || a.name.localeCompare(b.name),
    );
  const matches = matchRows.flatMap((row) => {
    const first = row.p1ParticipantId ? byParticipant.get(row.p1ParticipantId) : undefined;
    const second = row.p2ParticipantId ? byParticipant.get(row.p2ParticipantId) : undefined;
    if (!first || !second || (row.winner !== 1 && row.winner !== 2)) return [];
    if (ownTeams.has(first.participant.id) === ownTeams.has(second.participant.id)) return [];
    const onFirst = ownTeams.has(first.participant.id);
    const [own, other] = onFirst ? [first, second] : [second, first];
    const outcome = unplayedResultOutcome(row.scoresCsv, row.raw);
    if (outcome === 'bye' || (row.excludedFromRatings && outcome !== 'forfeit')) return [];
    const teammate = own.participant.memberPlayerIds?.map(canonical).find((id) => id !== playerId);
    return [
      {
        format: 'doubles' as const,
        setId: row.id,
        resultStage: row.resultStage,
        tournamentName:
          row.resultStage === 'group' && own.tournament.provider === 'native'
            ? ((own.tournament.raw as { eventName?: string } | null)?.eventName ??
              own.tournament.name)
            : own.tournament.name,
        tournamentDate: own.tournament.eventDate?.toISOString() ?? null,
        tournamentSlug: own.tournament.challongeSlug,
        won: row.winner === (onFirst ? 1 : 2),
        opponentName: pairName(other.participant),
        teammateName: teammate ? (names.get(teammate) ?? 'Player') : null,
        score: playerSetScore(row.scoresCsv, row.raw, onFirst ? 1 : 2),
        forfeit: outcome === 'forfeit',
      },
    ];
  });
  return { results, matches };
}
