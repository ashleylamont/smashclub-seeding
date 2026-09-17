import { poolLabel } from './pools';

/**
 * What happens to a pool once it has been played.
 *
 * First and second go on to the division's championship bracket, which
 * Challonge's own group stage advances automatically. Third and fourth are this
 * module's problem: they go into a separate single-elimination consolation
 * bracket, and the app has to say who plays whom, because Challonge is being
 * handed a flat participant list with seeds and will pair them by its standard
 * bracket shape.
 */

export interface PoolFinisher {
  playerId: string;
  poolIndex: number;
  /** 1-based position within the pool (including fifth in larger pools). */
  place: number;
}

export interface ConsolationEntrant {
  playerId: string;
  poolIndex: number;
  place: number;
  /** "A3", "C4" — shown beside the name so a pool card can be checked. */
  label: string;
  /** The seed to enter in Challonge. */
  bracketSeed: number;
}

export interface ConsolationBracket {
  /** In `bracketSeed` order: exactly the import order Challonge wants. */
  entrants: ConsolationEntrant[];
  /** Next power of two at or above the entrant count. */
  bracketSize: number;
  /** Round one as Challonge's standard bracket will draw it. `b` null = bye. */
  roundOne: Array<{ a: ConsolationEntrant; b: ConsolationEntrant | null }>;
  /** Pairs that are a pool rematch anyway — only possible with a single pool. */
  rematches: Array<{ a: ConsolationEntrant; b: ConsolationEntrant }>;
}

/**
 * What the repair pass is trying to minimise, in strict priority order.
 *
 * A pool rematch is the thing we are actually here to prevent, so it outweighs
 * everything. Below it comes seed integrity: a bracket's seeds *are* its
 * fairness argument, so a fix that shuffles the top of the draw is worse than
 * one that nudges two adjacent seeds, and byes keep going to the strongest
 * qualifiers rather than to whoever a swap happened to displace. Third-versus-
 * fourth is last and functions as a tie-breaker — the provisional ordering
 * already produces it wherever a full bracket allows it, and buying one more
 * such pairing is not worth re-cutting the seeds.
 */
const SAME_POOL_COST = 1000;
const DISPLACEMENT_COST = 10;
const SAME_PLACE_COST = 1;

/** A qualifier plus the seed the standard bracket would have given it. */
interface Seeded {
  finisher: PoolFinisher;
  provisionalSeed: number;
}

/**
 * Build the consolation bracket from confirmed pool placements.
 *
 * Provisional strength order is every third place by pool, then every fourth
 * place by pool — pool A holds the division's top seed, so A3 is the strongest
 * third on the same reasoning that made the pools. Laying that order onto a
 * standard single-elimination bracket already gives the two properties we want
 * for free: the strongest finishers start in opposite halves, and thirds meet
 * fourths.
 *
 * It does not always give the third: with an odd number of pools the byes fall
 * such that a pool's own third and fourth meet in round one. So the standard
 * arrangement is a *starting point*, and a repair pass swaps occupants between
 * slots until no pairing costs anything it does not have to. The result is
 * returned as explicit seeds rather than a running order, because "hand
 * Challonge this list in this order" is exactly the assumption that a rehearsal
 * needs to be able to check.
 */
export function buildConsolationBracket(finishers: readonly PoolFinisher[]): ConsolationBracket {
  const qualifiers = finishers.filter((finisher) => finisher.place >= 3);
  if (qualifiers.length === 0) {
    throw new Error('No consolation finishers to build a consolation bracket from.');
  }
  const seen = new Set<string>();
  for (const qualifier of qualifiers) {
    const key = `${qualifier.poolIndex}:${qualifier.place}`;
    if (seen.has(key)) {
      throw new Error(`Pool ${poolLabel(qualifier.poolIndex)} has two players in place ${qualifier.place}.`);
    }
    seen.add(key);
  }

  const ordered = [...qualifiers].sort((a, b) => a.place - b.place || a.poolIndex - b.poolIndex);
  const bracketSize = nextPowerOfTwo(ordered.length);
  const seedOrder = standardBracketOrder(bracketSize);

  // Slot i holds the qualifier whose provisional seed is seedOrder[i]; slots
  // whose seed is past the end of the field are byes.
  const slots: Array<Seeded | null> = seedOrder.map((seed) =>
    ordered[seed - 1] ? { finisher: ordered[seed - 1]!, provisionalSeed: seed } : null,
  );
  repairPairings(slots, seedOrder);

  const entrants: ConsolationEntrant[] = [];
  slots.forEach((occupant, index) => {
    if (!occupant) return;
    entrants.push({
      playerId: occupant.finisher.playerId,
      poolIndex: occupant.finisher.poolIndex,
      place: occupant.finisher.place,
      label: `${poolLabel(occupant.finisher.poolIndex)}${occupant.finisher.place}`,
      bracketSeed: seedOrder[index]!,
    });
  });
  entrants.sort((a, b) => a.bracketSeed - b.bracketSeed);

  const byPlayer = new Map(entrants.map((entrant) => [entrant.playerId, entrant]));
  const roundOne: ConsolationBracket['roundOne'] = [];
  const rematches: ConsolationBracket['rematches'] = [];
  for (let i = 0; i < slots.length; i += 2) {
    const left = slots[i] ? byPlayer.get(slots[i]!.finisher.playerId)! : null;
    const right = slots[i + 1] ? byPlayer.get(slots[i + 1]!.finisher.playerId)! : null;
    if (!left && !right) continue;
    // A bye is always drawn on the right, matching how Challonge shows it.
    const a = left ?? right!;
    const b = left ? right : null;
    roundOne.push({ a, b });
    if (b && a.poolIndex === b.poolIndex) rematches.push({ a, b });
  }

  return { entrants, bracketSize, roundOne, rematches };
}

/**
 * Swap occupants between slots while it strictly lowers the total pairing cost.
 *
 * Deterministic by construction: the best improving swap wins, ties go to the
 * lowest slot indices, and byes never move — a bye is not a participant, so
 * moving one would mean handing Challonge a seed it has nobody for.
 */
function repairPairings(slots: Array<Seeded | null>, seedOrder: readonly number[]): void {
  const occupied = slots.map((slot, index) => (slot ? index : -1)).filter((index) => index !== -1);
  // Each pass applies the single best strictly-improving swap, so the total
  // cost falls monotonically; the bound is belt and braces.
  for (let pass = 0; pass < slots.length * slots.length; pass++) {
    let bestGain = 0;
    let bestSwap: [number, number] | null = null;
    for (const i of occupied) {
      for (const j of occupied) {
        if (j <= i) continue;
        // Swapping within a pairing changes who is drawn on top, nothing else.
        if ((i >> 1) === (j >> 1)) continue;
        const before = pairCost(slots, seedOrder, i) + pairCost(slots, seedOrder, j);
        swap(slots, i, j);
        const after = pairCost(slots, seedOrder, i) + pairCost(slots, seedOrder, j);
        swap(slots, i, j);
        if (before - after > bestGain) {
          bestGain = before - after;
          bestSwap = [i, j];
        }
      }
    }
    if (!bestSwap) return;
    swap(slots, bestSwap[0], bestSwap[1]);
  }
}

/** Cost of the pairing `index` belongs to, plus its occupants' displacement. */
function pairCost(
  slots: ReadonlyArray<Seeded | null>,
  seedOrder: readonly number[],
  index: number,
): number {
  const first = index & ~1;
  const second = index | 1;
  const a = slots[first];
  const b = slots[second];
  const displacement =
    displacementCost(a, seedOrder[first]!) + displacementCost(b, seedOrder[second]!);
  if (!a || !b) return displacement;
  return (
    displacement +
    (a.finisher.poolIndex === b.finisher.poolIndex ? SAME_POOL_COST : 0) +
    (a.finisher.place === b.finisher.place ? SAME_PLACE_COST : 0)
  );
}

function displacementCost(occupant: Seeded | null | undefined, seed: number): number {
  return occupant ? DISPLACEMENT_COST * Math.abs(seed - occupant.provisionalSeed) : 0;
}

function swap<T>(items: T[], i: number, j: number): void {
  const temp = items[i]!;
  items[i] = items[j]!;
  items[j] = temp;
}

/**
 * Seeds in bracket-slot order: consecutive pairs meet in round one, and the
 * winners meet in the order the next round expects. 8 -> [1,8,4,5,2,7,3,6].
 */
export function standardBracketOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next: number[] = [];
    const opposite = order.length * 2 + 1;
    for (const seed of order) next.push(seed, opposite - seed);
    order = next;
  }
  return order;
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}

/** First and second from every pool, in pool then place order. */
export function championshipQualifiers(finishers: readonly PoolFinisher[]): Array<PoolFinisher & { label: string }> {
  return finishers
    .filter((finisher) => finisher.place === 1 || finisher.place === 2)
    .sort((a, b) => a.poolIndex - b.poolIndex || a.place - b.place)
    .map((finisher) => ({ ...finisher, label: `${poolLabel(finisher.poolIndex)}${finisher.place}` }));
}
