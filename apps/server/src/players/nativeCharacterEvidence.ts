import { setCharacterReports, type Db } from '@smashclub/db';
import type { SetCharacterPick } from '@smashclub/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { memberIds } from '../tournament/entrants';
import type { Match, TournamentState } from '../tournament/schemas';
import { agreedCharacters } from './characterEvidence';

export function nativeCharacterPlayers(
  entrants: TournamentState['entrants'],
  match: Pick<Match, 'player1Id' | 'player2Id'>,
) {
  return [match.player1Id, match.player2Id].flatMap((id) => {
    const entrant = entrants.find((entry) => entry.playerId === id);
    return entrant ? memberIds(entrant) : [];
  });
}

export async function lateCharacterReports(db: Db, kind: 'native' | 'archive', ids: string[]) {
  if (!ids.length) return [];
  return db
    .select({
      matchId: setCharacterReports.matchId,
      picks: setCharacterReports.picks,
      participantIds: setCharacterReports.participantIds,
    })
    .from(setCharacterReports)
    .where(and(eq(setCharacterReports.kind, kind), inArray(setCharacterReports.matchId, ids)));
}

export function sameCharacterParticipants(first: string[], second: string[]) {
  return (
    first.length === second.length && first.toSorted().join(',') === second.toSorted().join(',')
  );
}

export async function nativeCharacterEvidence(
  db: Db,
  state: TournamentState,
  matches: readonly Match[] = [
    ...state.matches,
    ...(state.supersededPlayedSets ?? []).map(({ match }) => match),
  ],
  canonical: (id: string) => string = (id) => id,
) {
  const played = matches.filter(
    (match) => match.status === 'complete' && match.outcome === 'played',
  );
  const byId = new Map(played.map((match) => [match.id, match]));
  const reports = new Map<string, SetCharacterPick[][]>();
  const add = (id: string, picks: SetCharacterPick[]) => {
    const previous = reports.get(id) ?? [];
    previous.push(picks);
    reports.set(id, previous);
  };
  for (const report of state.reports) {
    const match = byId.get(report.matchId);
    if (
      match &&
      report.characterPicks?.length &&
      report.status === 'approved' &&
      report.outcome === 'played' &&
      report.score1 === match.score1 &&
      report.score2 === match.score2 &&
      report.winnerId === match.winnerId &&
      report.expectedRevision >= match.revision - 1 &&
      report.expectedRevision <= match.revision
    )
      add(match.id, report.characterPicks);
  }
  for (const report of await lateCharacterReports(db, 'native', [...byId.keys()])) {
    const players = nativeCharacterPlayers(state.entrants, byId.get(report.matchId)!).map(
      canonical,
    );
    if (sameCharacterParticipants(players, report.participantIds.map(canonical)))
      add(report.matchId, report.picks);
  }
  return new Map(
    [...reports].map(([id, values]) => {
      const players = nativeCharacterPlayers(state.entrants, byId.get(id)!).map(canonical);
      const picks = agreedCharacters(
        values.map((report) =>
          report.map((pick) => ({ ...pick, playerId: canonical(pick.playerId) })),
        ),
      ).filter((pick) => players.includes(pick.playerId));
      return [id, picks];
    }),
  );
}
