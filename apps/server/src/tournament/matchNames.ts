import { knockoutMatchName } from '@smashclub/tournament-formats';
import type { Match, TournamentState } from './schemas';

type Draw = Pick<TournamentState, 'matches' | 'brackets'>;
type ProjectedMatchLabel = { label: string; labelFromStructure?: true };

/** Presentation only: never rename stored facts, source keys, links or receipts.
 * Entrant count comes from the fixed draw, including reserved qualifier places;
 * results, withdrawals and byes cannot turn an earlier round into a final. */
export function projectMatchLabels(draw: Draw): Map<string, ProjectedMatchLabel> {
  const labels = new Map<string, ProjectedMatchLabel>();
  const brackets = draw.brackets.filter((bracket) => bracket.entrantIds.length);
  const divisions = new Set(brackets.map((bracket) => bracket.division));
  const stages = new Set(brackets.map((bracket) => bracket.stage));
  const byBracket = new Map<string, Match[]>();
  for (const match of draw.matches) {
    if (!match.bracketId || match.stage === 'group') continue;
    const group = byBracket.get(match.bracketId) ?? [];
    group.push(match);
    byBracket.set(match.bracketId, group);
  }
  for (const bracket of brackets) {
    const matches = byBracket.get(bracket.id) ?? [];
    const entrants = bracket.entrantIds.length;
    const rounds = Math.ceil(Math.log2(Math.max(2, entrants)));
    const winners = matches.filter(
      (match) => !match.bracketLane || match.bracketLane === 'winners',
    );
    // An incomplete imported graph is insufficient evidence for structural names.
    if (winners.length !== 2 ** rounds - 1) continue;
    if (
      Array.from({ length: rounds }, (_, i) => i + 1).some((round) => {
        const rows = winners.filter((match) => (match.bracketRound ?? match.round) === round);
        const width = 2 ** (rounds - round);
        return (
          rows.length !== width ||
          new Set(rows.map((match) => match.slot)).size !== width ||
          rows.some(
            (match) => !Number.isInteger(match.slot) || match.slot < 0 || match.slot >= width,
          )
        );
      })
    )
      continue;
    const context = [
      divisions.size > 1 ? (bracket.division === 'upper' ? 'Upper' : 'Lower') : '',
      stages.size > 1 ? (bracket.stage === 'main' ? 'Championship' : 'Consolation') : '',
    ]
      .filter(Boolean)
      .join(' · ');
    for (const match of matches) {
      const name = knockoutMatchName(match, entrants);
      labels.set(match.id, {
        label: `${context ? `${context} · ` : ''}${name ?? match.label}`,
        ...(name === undefined ? {} : { labelFromStructure: true }),
      });
    }
  }
  return labels;
}

export function matchNames(draw: Draw): Map<string, string> {
  const labels = projectMatchLabels(draw);
  return new Map(
    draw.matches.map((match) => [match.id, labels.get(match.id)?.label ?? match.label]),
  );
}
