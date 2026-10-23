import { buildEliminationTree } from './elimination';
import type { StructureMatch, TournamentSlot } from './structure';

/** Padded seeded draw with explicit winner/loser feeds and an optional reset. */
export function buildDoubleEliminationTree(stageId: string, entrants: readonly TournamentSlot[]) {
  if (entrants.length < 2) return buildEliminationTree(stageId, entrants);
  const winners = buildEliminationTree(`${stageId}:W`, entrants);
  const depth = winners.at(-1)!.round;
  const matches: StructureMatch[] = [];
  let wave = 0;
  const winner = (m: StructureMatch): TournamentSlot => ({ kind: 'winner', matchId: m.id });
  const loser = (m: StructureMatch): TournamentSlot => ({ kind: 'loser', matchId: m.id });
  const addRound = (
    sides: [TournamentSlot, TournamentSlot][],
    lane: 'winners' | 'losers' | 'final' | 'reset',
    bracketRound: number,
  ) => {
    wave++;
    const round = sides.map((pair, slot): StructureMatch => ({
      id: `${stageId}:${lane}:${bracketRound}:${slot}`,
      stageId,
      round: wave,
      slot,
      sides: pair,
      bracketLane: lane,
      bracketRound,
      dependsOn: [
        ...new Set(
          pair.flatMap((s) => (s.kind === 'winner' || s.kind === 'loser' ? [s.matchId] : [])),
        ),
      ],
    }));
    matches.push(...round);
    return round;
  };
  let w = addRound(
    winners.filter((m) => m.round === 1).map((m) => m.sides),
    'winners',
    1,
  );
  let l: StructureMatch[] = [];
  if (depth > 1) {
    l = addRound(
      Array.from({ length: w.length / 2 }, (_, i) => [loser(w[i * 2]!), loser(w[i * 2 + 1]!)]),
      'losers',
      1,
    );
    for (let r = 2; r <= depth; r++) {
      w = addRound(
        Array.from({ length: w.length / 2 }, (_, i) => [winner(w[i * 2]!), winner(w[i * 2 + 1]!)]),
        'winners',
        r,
      );
      l = addRound(
        l.map((m, i) => [winner(m), loser(w[w.length - 1 - i]!)]),
        'losers',
        r * 2 - 2,
      );
      if (r < depth)
        l = addRound(
          Array.from({ length: l.length / 2 }, (_, i) => [
            winner(l[i * 2]!),
            winner(l[i * 2 + 1]!),
          ]),
          'losers',
          r * 2 - 1,
        );
    }
  }
  const final = addRound(
    [[winner(w[0]!), depth === 1 ? loser(w[0]!) : winner(l[0]!)]],
    'final',
    depth + 1,
  )[0]!;
  const reset = addRound([[winner(final), loser(final)]], 'reset', depth + 1)[0]!;
  reset.activation = { matchId: final.id, winnerSide: 2 };
  return matches;
}
