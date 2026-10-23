import { describe, expect, it } from 'vitest';
import type { ProjectedMatch } from '../src/pages/admin/eventPlanner/projectionView';
import {
  bracketCard,
  projectionDuration,
  projectionFinish,
  projectionLaneLayout,
  projectionMatchName,
  projectionPairing,
} from '../src/pages/admin/eventPlanner/projectionBracketLayout';

function match(
  lane: NonNullable<ProjectedMatch['bracketLane']>,
  round: number,
  slot = 0,
): ProjectedMatch {
  return {
    id: `${lane}:${round}:${slot}`,
    label: 'Open championship',
    stage: 'main',
    section: 'OM',
    round: round * 3,
    bracketLane: lane,
    bracketRound: round,
    slot,
    sides: ['Seed 1', 'Seed 2'],
    resources: [],
    feeds: [],
    dependsOn: [],
    bye: false,
    startMinute: 0,
    endMinute: 10,
    station: 1,
  };
}

describe('double-elimination preview layout', () => {
  it.each([2, 3, 4, 7])(
    'keeps both bracket lanes bounded and cards disjoint at depth %i',
    (depth) => {
      for (const lane of ['winners', 'losers'] as const) {
        const rounds = lane === 'winners' ? depth : 2 * depth - 2;
        const matches = Array.from({ length: rounds }, (_, r) =>
          Array.from(
            {
              length:
                lane === 'winners' ? 2 ** (depth - r - 1) : 2 ** (depth - 2 - Math.floor(r / 2)),
            },
            (_, slot) => match(lane, r + 1, slot),
          ),
        ).flat();
        const layout = projectionLaneLayout(matches.toReversed(), lane);
        expect(layout.rounds).toHaveLength(rounds);
        for (const node of layout.nodes) {
          expect(node.x).toBeGreaterThanOrEqual(0);
          expect(node.y).toBeGreaterThanOrEqual(bracketCard.top);
          expect(node.x + bracketCard.width).toBeLessThanOrEqual(layout.width);
          expect(node.y + bracketCard.height).toBeLessThanOrEqual(layout.height);
          const overlapping = layout.nodes.filter(
            (other) =>
              other !== node &&
              node.x < other.x + bracketCard.width &&
              node.x + bracketCard.width > other.x &&
              node.y < other.y + bracketCard.height &&
              node.y + bracketCard.height > other.y,
          );
          expect(overlapping).toEqual([]);
        }
        expect(projectionLaneLayout(matches, lane)).toEqual(layout);
      }
    },
  );

  it('connects local winner feeds and names cross-bracket loser drops without drawing through another lane', () => {
    const a = match('winners', 1),
      b = match('winners', 1, 1),
      final = match('winners', 2);
    final.feeds = [a, b].map((m, side) => ({
      matchId: m.id,
      outcome: 'winner',
      side: side as 0 | 1,
    }));
    const lower = match('losers', 1);
    lower.feeds = [a, b].map((m, side) => ({
      matchId: m.id,
      outcome: 'loser',
      side: side as 0 | 1,
    }));
    const all = new Map([a, b, final, lower].map((m) => [m.id, m]));
    expect(projectionPairing(final, all)).toEqual(['Winner W1.1', 'Winner W1.2']);
    expect(projectionPairing(lower, all)).toEqual(['Loser W1.1', 'Loser W1.2']);
    expect(projectionPairing({ ...lower, sides: ['Bye', 'Loser W1.2'] }, all)).toEqual([
      'Bye',
      'Loser W1.2',
    ]);
    expect(projectionPairing({ ...a, sides: ['O seed 1', 'O seed 8'] }, all)).toEqual([
      'Seed 1',
      'Seed 8',
    ]);
    const winners = projectionLaneLayout([a, b, final], 'winners');
    expect(winners.edges.map((e) => [e.from, e.to, e.side])).toEqual([
      [a.id, final.id, 0],
      [b.id, final.id, 1],
    ]);
    expect(projectionLaneLayout([lower], 'losers').edges).toEqual([]);
  });

  it('puts the possible reset beside the grand final and separates its timing from the normal finish', () => {
    const grand = { ...match('final', 7), startMinute: 60, endMinute: 70 };
    const reset = { ...match('reset', 7), startMinute: 72, endMinute: 82, conditional: true };
    reset.feeds = [
      { matchId: grand.id, outcome: 'winner', side: 0 },
      { matchId: grand.id, outcome: 'loser', side: 1 },
    ];
    const layout = projectionLaneLayout([reset, grand], 'finals');
    expect(layout.rounds.map((r) => r.label)).toEqual(['Grand final', 'Reset · if needed']);
    expect(layout.nodes.map((n) => n.x)).toEqual([12, 276]);
    expect(layout.edges.map((edge) => edge.outcome)).toEqual(['winner', 'loser']);
    expect(projectionMatchName(grand)).toBe('Grand final');
    expect(projectionMatchName(reset)).toBe('Reset final');
    expect(projectionDuration({ matches: [grand, reset], totalMinutes: 82 })).toBe('1h 10m–1h 22m');
    expect(projectionDuration({ matches: [grand], totalMinutes: 70 })).toBe('1h 10m');
    expect(projectionFinish({ matches: [grand, reset], totalMinutes: 82 }, '23:40')).toBe(
      '00:50 (+1d)–01:02 (+1d)',
    );
  });
});
