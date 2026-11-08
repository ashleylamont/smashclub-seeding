import type { StructureMatch } from './structure';

type KnockoutPosition = Pick<StructureMatch, 'bracketLane' | 'bracketRound' | 'round' | 'slot'>;

function roundName(remaining: number) {
  if (remaining === 0) return 'Final';
  if (remaining === 1) return 'Semi-final';
  if (remaining === 2) return 'Quarter-final';
  return `Round of ${2 ** (remaining + 1)}`;
}

/** Wording for a fixed knockout position, including padded slots and unresolved entrants. */
export function knockoutMatchName(match: KnockoutPosition, entrants: number) {
  if (match.bracketLane === 'final') return 'Grand final';
  if (match.bracketLane === 'reset') return 'Reset final (if needed)';
  if (match.bracketLane === 'losers')
    return match.bracketRound
      ? `Losers round ${match.bracketRound} · Match ${match.slot + 1}`
      : undefined;
  if (entrants === 1) return 'Uncontested bracket';
  const round = match.bracketRound ?? match.round;
  const remaining = Math.ceil(Math.log2(Math.max(2, entrants))) - round;
  if (remaining < 0 || round < 1) return undefined;
  const name = `${roundName(remaining)}${remaining ? ` ${match.slot + 1}` : ''}`;
  return match.bracketLane === 'winners' ? `Winners ${name.toLowerCase()}` : name;
}
