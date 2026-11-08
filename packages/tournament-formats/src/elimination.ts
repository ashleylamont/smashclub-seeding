import { standardBracketOrder } from './advancement';
import type { StructureMatch, TournamentSlot } from './structure';

/** Includes explicit automatic byes, including an uncontested one-entrant stage. */
export function buildEliminationTree(stageId: string, entrants: readonly TournamentSlot[]) {
  const matches: StructureMatch[] = [];
  if (!entrants.length) return matches;
  let size = 2;
  while (size < entrants.length) size *= 2;
  const slots = standardBracketOrder(size).map(
    (seed): TournamentSlot => entrants[seed - 1] ?? { kind: 'bye' },
  );
  let previous: StructureMatch[] = [];
  for (let width = size / 2, round = 1; width >= 1; width /= 2, round++) {
    const current: StructureMatch[] = [];
    for (let slot = 0; slot < width; slot++) {
      const parents = round === 1 ? [] : previous.slice(slot * 2, slot * 2 + 2);
      current.push({
        id: `${stageId}:${round}:${slot}`,
        stageId,
        round,
        slot,
        sides:
          round === 1
            ? [slots[slot * 2]!, slots[slot * 2 + 1]!]
            : [
                { kind: 'winner', matchId: parents[0]!.id },
                { kind: 'winner', matchId: parents[1]!.id },
              ],
        dependsOn: parents.map((p) => p.id),
      });
    }
    matches.push(...current);
    previous = current;
  }
  return matches;
}
