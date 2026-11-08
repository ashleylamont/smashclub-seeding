import {
  finalsRoles,
  isKnockout,
  type StructureOptions,
  type TournamentStructure,
} from '@smashclub/shared';
import { knockoutMatchName, selectFormatFinalists } from '@smashclub/tournament-formats';
import type { LiveMatch } from './eventDisplay';
import { liveBracketSide, liveBracketStatus } from './eventBracket';

export type BracketBackupData = {
  plan: {
    bracketMode: string;
    structure?: TournamentStructure;
    structureOptions?: StructureOptions;
  };
  nativeBrackets: { id: string; division: string; stage: string; entrantIds: string[] }[];
  brackets: { division: string; stage: string; slug: string | null }[];
  matches: LiveMatch[];
  entrants: { id: string; name: string }[];
  withdrawals?: { playerId: string }[];
};

function blankMatches(data: BracketBackupData, division: string, stage: 'main' | 'consolation') {
  if (data.plan.bracketMode !== 'native')
    return Array.from({ length: 16 }, (_, index) => ({
      key: `blank-${index}`,
      label: `Match ${index + 1}`,
      round: 'Round ____',
      player1: '',
      player2: '',
      recorded: '',
    }));
  if (isKnockout(data.plan.structure)) return [];
  const withdrawn = new Set(data.withdrawals?.map((item) => item.playerId) ?? []);
  const pools = new Map<number, Set<string>>();
  for (const match of data.matches.filter(
    (item) => item.stage === 'group' && item.division === division,
  )) {
    const pool = pools.get(match.poolIndex ?? 0) ?? new Set<string>();
    for (const id of [match.player1Id, match.player2Id]) if (id && !withdrawn.has(id)) pool.add(id);
    pools.set(match.poolIndex ?? 0, pool);
  }
  // Only the count matters for paper. Use provisional places, with no seed or result assumptions.
  const finishers = [...pools].flatMap(([poolIndex, ids]) =>
    [...ids].map((playerId, index) => ({ playerId, poolIndex, place: index + 1 })),
  );
  const expected = selectFormatFinalists(
    data.plan.structure,
    finishers,
    stage,
    data.plan.structureOptions,
  ).length;
  let capacity = 4;
  while (capacity < expected) capacity *= 2;
  // Name the fixed paper positions, including the spare slots a TO can mark as byes.
  const name = (round: number, slot: number) => knockoutMatchName({ round, slot }, capacity)!;
  const rows = [];
  for (let width = capacity / 2, round = 1; width >= 1; width /= 2, round++)
    for (let slot = 0; slot < width; slot++)
      rows.push({
        key: `blank-${round}-${slot}`,
        label: name(round, slot),
        round: '',
        player1: round === 1 ? '' : `Winner of ${name(round - 1, slot * 2)}`,
        player2: round === 1 ? '' : `Winner of ${name(round - 1, slot * 2 + 1)}`,
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
  const divisions =
    data.plan.structure && data.plan.structure !== 'dual_division'
      ? (['upper'] as const)
      : (['upper', 'lower'] as const);
  const roles =
    data.plan.structure === 'round_robin'
      ? []
      : finalsRoles(data.plan.structure, data.plan.structureOptions);
  return divisions.flatMap((division) =>
    roles.map((stage) => {
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
      return {
        key: `${division}:${stage}`,
        title: `${data.plan.structure && data.plan.structure !== 'dual_division' ? 'Open' : division === 'upper' ? 'Upper' : 'Lower'} ${stage === 'main' ? 'Championship' : 'Consolation'}`,
        source:
          data.plan.bracketMode === 'native'
            ? bracket
              ? 'Generated Nemesis draw'
              : isKnockout(data.plan.structure)
                ? 'Lock the draw to print its chosen match order'
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
                player1: liveBracketSide(
                  {
                    ...match,
                    player1Name: match.player1Name || names.get(match.player1Id ?? '') || null,
                  },
                  0,
                  labels,
                ),
                player2: liveBracketSide(
                  {
                    ...match,
                    player2Name: match.player2Name || names.get(match.player2Id ?? '') || null,
                  },
                  1,
                  labels,
                ),
                recorded:
                  match.status === 'complete'
                    ? match.outcome === 'played'
                      ? `${match.score1 ?? '–'}–${match.score2 ?? '–'}`
                      : liveBracketStatus(match)
                    : match.bracketLane === 'reset'
                      ? 'If needed'
                      : '',
              }))
            : blankMatches(data, division, stage),
      };
    }),
  );
}
