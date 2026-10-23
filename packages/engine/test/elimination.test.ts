import { describe, expect, it } from 'vitest';
import {
  compileTournament,
  type StructureMatch,
  type TournamentSlot,
} from '../src/tournament/structure';

function play(tree: StructureMatch[], decisions: number) {
  const results = new Map<string, { a: string | null; b: string | null; winner: string | null }>();
  const losses = new Map<string, number>();
  let played = 0,
    reset = false,
    champion: string | null = null;
  const resolve = (source: TournamentSlot): string | null => {
    if (source.kind === 'entrant') return source.entrantId;
    if (source.kind === 'bye') return null;
    if (source.kind === 'pool_place') throw new Error('Unexpected unresolved qualifier.');
    const p = results.get(source.matchId);
    if (!p) throw new Error('Dependency was not generated before its consumer.');
    return source.kind === 'winner' ? p.winner : p.winner ? (p.winner === p.a ? p.b : p.a) : null;
  };
  for (const match of tree) {
    if (match.activation) {
      const p = results.get(match.activation.matchId)!;
      if (p.winner !== (match.activation.winnerSide === 1 ? p.a : p.b)) continue;
      reset = true;
    }
    const a = resolve(match.sides[0]),
      b = resolve(match.sides[1]);
    if (a && a === b) throw new Error('An entrant was paired with themselves.');
    let winner = a ?? b;
    if (a && b) {
      winner = decisions % 2 ? b : a;
      decisions = Math.floor(decisions / 2);
      const loser = winner === a ? b : a;
      losses.set(loser, (losses.get(loser) ?? 0) + 1);
      played++;
    }
    results.set(match.id, { a, b, winner });
    champion = winner;
  }
  return { played, losses, champion, reset };
}

describe('single and double elimination', () => {
  it('resolves every winner choice in small odd/even fields without phantom games or extra lives', () => {
    for (let count = 2; count <= 5; count++) {
      const entrants = Array.from({ length: count }, (_, i) => `seed-${i + 1}`);
      for (const structure of ['single_elimination', 'double_elimination'] as const) {
        const graph = compileTournament({
          structure,
          divisions: [{ id: 'open', entrantIds: entrants }],
        });
        const double = structure === 'double_elimination';
        for (let choices = 0; choices < 2 ** (double ? count * 2 - 1 : count - 1); choices++) {
          const result = play(graph.matches, choices);
          expect(entrants).toContain(result.champion);
          expect(result.played).toBe(double ? count * 2 - 2 + Number(result.reset) : count - 1);
          expect(
            entrants
              .filter((id) => id !== result.champion)
              .every((id) => result.losses.get(id) === (double ? 2 : 1)),
          ).toBe(true);
          expect(result.losses.get(result.champion!) ?? 0).toBeLessThan(double ? 2 : 1);
        }
      }
    }
  });

  it('preserves unique topological identities and truthful workloads across wider non-power-of-two draws', () => {
    for (const count of [6, 7, 8, 9, 15, 16, 17, 31, 32, 65, 129]) {
      const graph = compileTournament({
        structure: 'double_elimination',
        divisions: [{ id: 'open', entrantIds: Array.from({ length: count }, (_, i) => `${i}`) }],
      });
      const seen = new Set<string>();
      for (const m of graph.matches) {
        expect(m.dependsOn.every((id) => seen.has(id))).toBe(true);
        seen.add(m.id);
      }
      expect(seen.size).toBe(graph.matches.length);
      for (const choices of [0, 1, 31, 65535]) {
        const outcome = play(graph.matches, choices);
        expect(outcome.played).toBe(2 * count - 2 + Number(outcome.reset));
        expect(
          [...outcome.losses]
            .filter(([id]) => id !== outcome.champion)
            .every(([, losses]) => losses === 2),
        ).toBe(true);
      }
    }
  });
});
