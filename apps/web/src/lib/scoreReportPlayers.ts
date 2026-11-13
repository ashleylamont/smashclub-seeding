import type { LiveMatch } from './eventDisplay';

export type ScoreReportPlayer = { id: string; name: string };

export function scoreReportPlayers(
  match: LiveMatch,
  memberNames: Readonly<Record<string, string>> = {},
): ScoreReportPlayer[] {
  return [
    { id: match.player1Id, name: match.player1Name, members: match.player1MemberIds },
    { id: match.player2Id, name: match.player2Name, members: match.player2MemberIds },
  ].flatMap(({ id, name, members }) =>
    members?.length
      ? members.map((member, index) => ({
          id: member,
          name: memberNames[member] ?? `${name ?? 'Pair'} · player ${index + 1}`,
        }))
      : id
        ? [{ id, name: name ?? 'Player' }]
        : [],
  );
}
