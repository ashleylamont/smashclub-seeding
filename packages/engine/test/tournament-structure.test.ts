import { describe, expect, it } from 'vitest';
import {
  buildRoundRobin,
  buildEliminationTree,
  compileTournament,
} from '../src/tournament/structure';

const ids = (count: number) => Array.from({ length: count }, (_, i) => `entrant-${i}`);
describe('surface-independent tournament generation', () => {
  it('compiles large round robins without spreading the match list into function arguments', () => {
    const graph = compileTournament({
      structure: 'round_robin',
      divisions: [{ id: 'open', entrantIds: ids(501) }],
    });
    expect(graph.matches).toHaveLength(125250);
    expect(graph.guaranteedSets.every((s) => s.count === 500)).toBe(true);
  });
  it('covers every pair exactly once per meeting, with disjoint circle rounds and reversed return sides', () => {
    for (const count of [2, 3, 4, 5, 9, 32, 129]) {
      const entrants = ids(count);
      const matches = buildRoundRobin(entrants, 2);
      expect(matches).toHaveLength(count * (count - 1));
      const counts = new Map<string, number>();
      for (const m of matches) {
        const key = JSON.stringify([m.player1Id, m.player2Id].sort());
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      expect(counts.size).toBe((count * (count - 1)) / 2);
      expect([...counts.values()].every((n) => n === 2)).toBe(true);
      const half = matches.length / 2;
      for (let i = 0; i < half; i++) {
        expect(matches[i]!.player1Id).toBe(matches[i + half]!.player2Id);
        expect(matches[i]!.player2Id).toBe(matches[i + half]!.player1Id);
      }
      for (const round of new Set(matches.map((m) => m.round))) {
        const playing = matches
          .filter((m) => m.round === round)
          .flatMap((m) => [m.player1Id, m.player2Id]);
        expect(new Set(playing).size).toBe(playing.length);
      }
    }
  });

  it('emits topological winner references and real byes for uneven elimination fields', () => {
    for (const count of [0, 1, 2, 3, 5, 8, 17]) {
      const matches = buildEliminationTree(
        'finals',
        ids(count).map((entrantId) => ({ kind: 'entrant', entrantId })),
      );
      const seen = new Set<string>();
      for (const match of matches) {
        expect(match.dependsOn.every((id) => seen.has(id))).toBe(true);
        for (const side of match.sides.filter((s) => s.kind === 'winner'))
          expect(seen.has(side.matchId)).toBe(true);
        seen.add(match.id);
      }
      expect(seen.size).toBe(matches.length);
      const played = matches.filter((m) => m.sides.every((s) => s.kind !== 'bye'));
      expect(played).toHaveLength(Math.max(0, count - 1));
    }
  });

  it('compiles neutral, serializable pool-place references and explicit stage dependencies', () => {
    const input = {
      structure: 'pools_finals' as const,
      divisions: [{ id: 'open', entrantIds: ids(17) }],
      options: { roundRobinMeetings: 2 },
    };
    const frozen = structuredClone(input);
    const graph = compileTournament(input);
    expect(input).toEqual(frozen);
    expect(compileTournament(input)).toEqual(graph);
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph);
    const pools = graph.stages.filter((s) => s.kind === 'round_robin');
    const finals = graph.stages.filter((s) => s.kind !== 'round_robin');
    expect(pools.map((p) => p.entrantIds.length)).toEqual([5, 4, 4, 4]);
    expect(finals.map((s) => s.entrants.length)).toEqual([9, 8]);
    const places = finals.flatMap((s) => s.entrants);
    expect(
      places.every((s) => s.kind === 'pool_place' && pools.some((p) => p.id === s.poolId)),
    ).toBe(true);
    expect(new Set(places.map((p) => JSON.stringify(p))).size).toBe(17);
    expect(finals.every((s) => s.dependsOn.length === pools.length)).toBe(true);
    expect(graph.matches.filter((m) => pools.some((p) => p.id === m.stageId))).toHaveLength(56);
  });

  it('rejects impossible structures, duplicate identities and invalid variants', () => {
    expect(() =>
      compileTournament({
        structure: 'dual_division',
        divisions: [{ id: 'one', entrantIds: ids(8) }],
      }),
    ).toThrow(/Division count/);
    expect(() =>
      compileTournament({
        structure: 'round_robin',
        divisions: [{ id: 'one', entrantIds: ['a', 'a'] }],
      }),
    ).toThrow(/unique/);
    expect(() => buildRoundRobin(ids(3), 0)).toThrow(/positive integer/);
  });
});
