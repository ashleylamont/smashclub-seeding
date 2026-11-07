import { poolLabel } from './pools';

/**
 * What happens to a pool once it has been played.
 *
 * The upper half (rounded up) go on to the division's championship bracket,
 * which Challonge's own group stage advances automatically. The remainder are this
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

/** Keep two qualifiers in a two-player pool; a five-player pool advances three. */
export function winnersCount(poolSize: number): number {
  return Math.min(poolSize, Math.max(2, Math.ceil(poolSize / 2)));
}

export function consolationQualifiers<T extends PoolFinisher>(finishers: readonly T[]): T[] {
  const counts = new Map<number, number>();
  for (const finisher of finishers)
    counts.set(finisher.poolIndex, (counts.get(finisher.poolIndex) ?? 0) + 1);
  return finishers.filter(
    (finisher) => finisher.place > winnersCount(counts.get(finisher.poolIndex)!),
  );
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
  roundOne: { a: ConsolationEntrant; b: ConsolationEntrant | null }[];
  /** Pairs that are a pool rematch anyway — only possible with a single pool. */
  rematches: { a: ConsolationEntrant; b: ConsolationEntrant }[];
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
 * Provisional strength order is finishing place, then pool order — pool A
 * holds the division's top seed, so A3 leads the thirds on the same reasoning
 * that made the pools. Laying that order onto a
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
  return seedPoolFinishers(consolationQualifiers(finishers));
}

/** Seed an already selected field. Qualification and bracket seeding are separate rules. */
export function seedPoolFinishers(qualifiers: readonly PoolFinisher[]): ConsolationBracket {
  return placeSeeds([...qualifiers].sort(comparePoolPlaces), repairPairings);
}

function comparePoolPlaces(a: PoolFinisher, b: PoolFinisher) {
  return a.place - b.place || a.poolIndex - b.poolIndex;
}

export const FINALS_POOL_PLACE_COST = 150;

export interface StrengthSeedInput extends PoolFinisher {
  /** Frozen conservative WHR, on the display scale. */
  strength: number;
}

export function seedFinalistsByStrength(qualifiers: readonly StrengthSeedInput[]) {
  const ordered = qualifiers
    .map((q) => ({
      ...q,
      combinedScore: q.strength - FINALS_POOL_PLACE_COST * (q.place - 1),
    }))
    .sort((a, b) => b.combinedScore - a.combinedScore || comparePoolPlaces(a, b));
  const draw = placeSeeds(ordered, repairStrengthPairings);
  const evidence = new Map(
    ordered.map(({ playerId, strength, combinedScore }, index) => [
      playerId,
      { provisionalSeed: index + 1, strength, combinedScore },
    ]),
  );
  return {
    ...draw,
    seeds: draw.entrants.map((entrant) => ({ ...entrant, ...evidence.get(entrant.playerId)! })),
  };
}

/** Earliest possible same-pool meetings in the fixed single-elimination tree. */
export function poolRematchRounds(draw: ConsolationBracket) {
  const slots = new Map(standardBracketOrder(draw.bracketSize).map((seed, index) => [seed, index]));
  const counts = Array<number>(Math.log2(draw.bracketSize)).fill(0);
  const pools = new Map<number, number[]>();
  for (const entrant of draw.entrants) {
    const position = slots.get(entrant.bracketSeed)!;
    const group = pools.get(entrant.poolIndex) ?? [];
    for (const other of group) counts[meetingRound(position, other) - 1]!++;
    group.push(position);
    pools.set(entrant.poolIndex, group);
  }
  return counts;
}

function meetingRound(a: number, b: number) {
  return 32 - Math.clz32(a ^ b);
}

function placeSeeds(
  qualifiers: readonly PoolFinisher[],
  repair: (slots: (Seeded | null)[], seedOrder: readonly number[]) => void,
): ConsolationBracket {
  if (qualifiers.length === 0) {
    throw new Error('No consolation finishers to build a consolation bracket from.');
  }
  const seen = new Set<string>();
  for (const qualifier of qualifiers) {
    const key = `${qualifier.poolIndex}:${qualifier.place}`;
    if (seen.has(key)) {
      throw new Error(
        `Pool ${poolLabel(qualifier.poolIndex)} has two players in place ${qualifier.place}.`,
      );
    }
    seen.add(key);
  }

  const bracketSize = nextPowerOfTwo(qualifiers.length);
  const seedOrder = standardBracketOrder(bracketSize);

  // Slot i holds the qualifier whose provisional seed is seedOrder[i]; slots
  // whose seed is past the end of the field are byes.
  const slots: (Seeded | null)[] = seedOrder.map((seed) =>
    qualifiers[seed - 1] ? { finisher: qualifiers[seed - 1]!, provisionalSeed: seed } : null,
  );
  repair(slots, seedOrder);

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
function repairPairings(slots: (Seeded | null)[], seedOrder: readonly number[]): void {
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
        if (i >> 1 === j >> 1) continue;
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

/**
 * Exchanges between nearby provisional seeds are a bounded local search.
 * Protect the original bye recipients and top seed paths. Within those
 * constraints prefer fewer opening rematches, then fewer early later-round
 * meetings, then smaller displacement. No estimated winners are required.
 */
function repairStrengthPairings(slots: (Seeded | null)[], seedOrder: readonly number[]) {
  const rounds = Math.log2(slots.length);
  const positions = new Map(seedOrder.map((seed, index) => [seed, index]));
  for (let pass = 0; pass < slots.length; pass++) {
    const poolSlots = new Map<number, number[]>();
    slots.forEach((slot, index) => {
      if (!slot) return;
      const group = poolSlots.get(slot.finisher.poolIndex) ?? [];
      group.push(index);
      poolSlots.set(slot.finisher.poolIndex, group);
    });
    if (poolSlots.size < 2) return;
    let best: { positions: [number, number]; change: number[] } | undefined;
    for (const [i, a] of slots.entries()) {
      if (!a || !slots[i ^ 1]) continue;
      for (let rank = a.provisionalSeed + 1; rank <= a.provisionalSeed + 3; rank++) {
        const candidate = positions.get(rank);
        if (candidate === undefined) continue;
        const b = slots[candidate];
        if (!b || !slots[candidate ^ 1]) continue;
        if (
          !sameSeedSection(a.provisionalSeed, i, candidate, rounds) ||
          !sameSeedSection(b.provisionalSeed, candidate, i, rounds)
        )
          continue;
        const change = Array<number>(rounds + 1).fill(0);
        if (a.finisher.poolIndex !== b.finisher.poolIndex) {
          countMovedRematches(change, poolSlots.get(a.finisher.poolIndex)!, i, candidate);
          countMovedRematches(change, poolSlots.get(b.finisher.poolIndex)!, candidate, i);
        }
        change[rounds] =
          displacementCost(a, seedOrder[candidate]!) +
          displacementCost(b, seedOrder[i]!) -
          displacementCost(a, seedOrder[i]!) -
          displacementCost(b, seedOrder[candidate]!);
        const firstRound = change.findIndex((value, round) => value !== (best?.change[round] ?? 0));
        if (firstRound >= 0 && change[firstRound]! < (best?.change[firstRound] ?? 0)) {
          best = { positions: [i, candidate], change };
        }
      }
    }
    if (!best) return;
    const [i, j] = best.positions;
    swap(slots, i, j);
    positions.set(slots[i]!.provisionalSeed, i);
    positions.set(slots[j]!.provisionalSeed, j);
  }
}

function sameSeedSection(seed: number, from: number, to: number, rounds: number) {
  if (seed <= 4 && rounds >= 3) return from >> (rounds - 2) === to >> (rounds - 2);
  if (seed <= 2 && rounds >= 2) return from >> (rounds - 1) === to >> (rounds - 1);
  return true;
}

function countMovedRematches(change: number[], poolSlots: number[], from: number, to: number) {
  for (const other of poolSlots) {
    if (other === from) continue;
    change[meetingRound(from, other) - 1]!--;
    change[meetingRound(to, other) - 1]!++;
  }
}

/** Cost of the pairing `index` belongs to, plus its occupants' displacement. */
function pairCost(
  slots: readonly (Seeded | null)[],
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

/** Upper half of each pool, rounded up, in pool then place order. */
export function championshipQualifiers<T extends PoolFinisher>(
  finishers: readonly T[],
): (T & { label: string })[] {
  const counts = new Map<number, number>();
  for (const finisher of finishers)
    counts.set(finisher.poolIndex, (counts.get(finisher.poolIndex) ?? 0) + 1);
  return finishers
    .filter((finisher) => finisher.place <= winnersCount(counts.get(finisher.poolIndex)!))
    .sort((a, b) => a.poolIndex - b.poolIndex || a.place - b.place)
    .map((finisher) => ({
      ...finisher,
      label: `${poolLabel(finisher.poolIndex)}${finisher.place}`,
    }));
}
