import type { LiveMatch } from './eventDisplay';

export type BracketBackupData = {
  plan: { bracketMode: string };
  nativeBrackets: { id: string; division: string; stage: string; entrantIds: string[] }[];
  brackets: { division: string; stage: string; slug: string | null }[];
  matches: LiveMatch[];
  entrants: { id: string; name: string }[];
  withdrawals?: { playerId: string }[];
};

function blankMatches(data: BracketBackupData, division: string, stage: string) {
  if (data.plan.bracketMode !== 'native')
    return Array.from({ length: 16 }, (_, index) => ({
      key: `blank-${index}`,
      label: `Match ${index + 1}`,
      round: 'Round ____',
      player1: '',
      player2: '',
      recorded: '',
    }));
  const withdrawn = new Set(data.withdrawals?.map((item) => item.playerId) ?? []);
  const pools = new Map<number, Set<string>>();
  for (const match of data.matches.filter(
    (item) => item.stage === 'group' && item.division === division,
  )) {
    const pool = pools.get(match.poolIndex ?? 0) ?? new Set<string>();
    for (const id of [match.player1Id, match.player2Id]) if (id && !withdrawn.has(id)) pool.add(id);
    pools.set(match.poolIndex ?? 0, pool);
  }
  const expected = [...pools.values()].reduce((total, pool) => {
    const qualifying = Math.min(pool.size, Math.max(2, Math.ceil(pool.size / 2)));
    return total + (stage === 'main' ? qualifying : pool.size - qualifying);
  }, 0);
  let capacity = 4;
  while (capacity < expected) capacity *= 2;
  const rows = [];
  for (let width = capacity / 2, round = 1; width >= 1; width /= 2, round++)
    for (let slot = 0; slot < width; slot++)
      rows.push({
        key: `blank-${round}-${slot}`,
        label: `M${slot + 1}`,
        round: `Round ${round}`,
        player1: round === 1 ? '' : `Winner of R${round - 1} M${slot * 2 + 1}`,
        player2: round === 1 ? '' : `Winner of R${round - 1} M${slot * 2 + 2}`,
        recorded: '',
      });
  return rows;
}

export function bracketBackupSheets(data: BracketBackupData) {
  const names = new Map(data.entrants.map((player) => [player.id, player.name]));
  const groupNames = (division: string) =>
    [
      ...new Set(
        data.matches
          .filter((match) => match.stage === 'group' && match.division === division)
          .flatMap((match) => [match.player1Name, match.player2Name])
          .filter(
            (name): name is string => typeof name === 'string' && name !== '' && name !== 'TBD',
          ),
      ),
    ].sort((a, b) => a.localeCompare(b));
  return (['upper', 'lower'] as const).flatMap((division) =>
    (['main', 'consolation'] as const).map((stage) => {
      const bracket = data.nativeBrackets.find(
        (item) => item.division === division && item.stage === stage,
      );
      const linked = data.brackets.find(
        (item) => item.division === division && item.stage === stage,
      );
      const matches = data.matches
        .filter((match) =>
          bracket
            ? match.nativeBracketId === bracket.id
            : data.plan.bracketMode !== 'native' &&
              match.division === division &&
              match.stage === stage,
        )
        .sort(
          (a, b) =>
            (a.nativeRound ?? 0) - (b.nativeRound ?? 0) ||
            (a.nativeSlot ?? 0) - (b.nativeSlot ?? 0) ||
            a.label.localeCompare(b.label, undefined, { numeric: true }),
        );
      const labels = new Map(matches.map((match) => [match.id, match.label]));
      const player = (id: string | null, name: string | null, parent?: string | null) =>
        id
          ? (name ?? names.get(id) ?? 'Player')
          : parent
            ? `Winner of ${labels.get(parent) ?? 'previous match'}`
            : '';
      return {
        key: `${division}:${stage}`,
        title: `${division === 'upper' ? 'Upper' : 'Lower'} ${stage === 'main' ? 'Championship' : 'Consolation'}`,
        source:
          data.plan.bracketMode === 'native'
            ? bracket
              ? 'Generated Nemesis draw'
              : 'Draw not generated yet — estimated paper template from current pool sizes'
            : linked?.slug
              ? `Challonge: ${linked.slug}`
              : 'Challonge draw not attached — blank contingency worksheet',
        blank: !bracket && matches.length === 0,
        roster: bracket
          ? bracket.entrantIds.map((id) =>
              id.startsWith('pending:')
                ? `Pool ${String.fromCharCode(65 + Number(id.split(':')[2]))} place ${id.split(':')[3]} TBD`
                : (names.get(id) ?? 'Player'),
            )
          : groupNames(division),
        matches:
          matches.length || bracket
            ? matches.map((match) => ({
                key: match.id,
                label: match.label,
                round: match.nativeRound ? `Round ${match.nativeRound}` : '',
                player1: player(match.player1Id, match.player1Name, match.parent1MatchId),
                player2: player(match.player2Id, match.player2Name, match.parent2MatchId),
                recorded:
                  match.status === 'complete'
                    ? match.outcome === 'bye'
                      ? 'Bye'
                      : match.outcome === 'forfeit'
                        ? 'Forfeit'
                        : match.outcome === 'played'
                          ? `${match.score1 ?? '–'}–${match.score2 ?? '–'}`
                          : 'Complete'
                    : '',
              }))
            : blankMatches(data, division, stage),
      };
    }),
  );
}
