import type { Match, TournamentState } from './schemas';

type Draw = Pick<TournamentState, 'matches' | 'brackets'>;

function roundName(remaining: number) {
  if (remaining === 0) return 'Final';
  if (remaining === 1) return 'Semi-final';
  if (remaining === 2) return 'Quarter-final';
  return `Round of ${2 ** (remaining + 1)}`;
}

function knockoutName(match: Match, rounds: number, entrants: number) {
  if (match.bracketLane === 'final') return 'Grand final';
  if (match.bracketLane === 'reset') return 'Reset final (if needed)';
  if (match.bracketLane === 'losers')
    return match.bracketRound
      ? `Losers round ${match.bracketRound} · Match ${match.slot + 1}`
      : match.label;
  if (entrants === 1) return 'Uncontested bracket';
  const round = match.bracketRound ?? match.round;
  const remaining = rounds - round;
  if (remaining < 0 || round < 1) return match.label;
  const name = `${roundName(remaining)}${remaining ? ` ${match.slot + 1}` : ''}`;
  return match.bracketLane === 'winners' ? `Winners ${name.toLowerCase()}` : name;
}

/** Presentation only: never rename stored facts, source keys, links or receipts.
 * Entrant count comes from the fixed draw, including reserved qualifier places;
 * results, withdrawals and byes cannot turn an earlier round into a final. */
export function matchNames(draw: Draw): Map<string, string> {
  const labels = new Map(draw.matches.map((match) => [match.id, match.label]));
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
      const name = knockoutName(match, rounds, entrants);
      labels.set(match.id, `${context ? `${context} · ` : ''}${name}`);
    }
  }
  return labels;
}
