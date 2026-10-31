import { describe, expect, it } from 'vitest';
import {
  liveBracketFeeds,
  liveBracketLanes,
  liveBracketSide,
  liveBracketStatus,
  liveBracketWinner,
} from '../src/lib/eventBracket';
import { eliminationLaneLayout } from '../src/lib/eliminationLayout';
import { bracketFixture, TEAM_ALIAS } from './fixtures/brackets';

const card = { width: 250, height: 230, column: 286, row: 254, top: 40, side1: 115, side2: 184 };

describe('public bracket semantics', () => {
  it('distinguishes an automatic bye from an unresolved winner or loser feed', () => {
    const matches = bracketFixture(3);
    const labels = new Map(matches.map((m) => [m.id, m.label]));
    const bye = matches.find((m) => m.outcome === 'bye')!;
    const emptySide = bye.player1Id ? 1 : 0;
    expect(liveBracketSide({ ...bye, parent2MatchId: 'unknown' }, emptySide, labels)).toBe('Bye');
    expect(liveBracketStatus(bye)).toBe('Bye');
    const lower = matches.find((m) => m.bracketLane === 'losers')!;
    expect(liveBracketSide(lower, 0, labels)).toBe(`Loser of ${labels.get(lower.parent1MatchId!)}`);
    expect(liveBracketStatus(lower)).toBe('Waiting for feeders');
    expect(liveBracketSide({ ...lower, parent1MatchId: null }, 0, labels)).toBe('To be decided');
    expect(liveBracketSide({ ...lower, parent1MatchId: 'missing' }, 0, labels)).toBe(
      'Loser of previous match',
    );
    const team = matches.find((m) => m.player1Name === TEAM_ALIAS)!;
    expect(liveBracketSide(team, 0, labels)).toBe(TEAM_ALIAS);
  });

  it('only highlights confirmed participants and updates changed results without predicting a champion', () => {
    const match = bracketFixture(4).find((m) => m.player1Id && m.player2Id)!;
    const result = {
      ...match,
      status: 'complete',
      outcome: 'played',
      score1: 2,
      score2: 1,
      winnerId: match.player1Id,
    };
    expect(liveBracketWinner({ ...result, status: 'playing' }, match.player1Id)).toBe(false);
    expect(liveBracketWinner({ ...result, status: 'blocked' }, match.player1Id)).toBe(false);
    expect(liveBracketWinner(result, match.player1Id)).toBe(true);
    expect(liveBracketWinner({ ...result, winnerId: match.player2Id }, match.player1Id)).toBe(
      false,
    );
    expect(liveBracketStatus({ ...result, winnerId: null })).toBe('No contest');
    expect(liveBracketStatus({ ...result, outcome: 'forfeit' })).toBe('Forfeit');
    expect(liveBracketStatus({ ...result, called: true, status: 'playing' })).toBe('Called');
    expect(liveBracketSide({ ...result, player1Id: null, winnerId: null }, 0, new Map())).toBe(
      'No entrant',
    );
  });

  it('keeps conditional resets honest until active, and preserves every engine lane and feed', () => {
    const matches = bracketFixture(7);
    const lanes = liveBracketLanes(matches);
    expect(lanes.map((lane) => lane.key)).toEqual(['winners', 'losers', 'finals']);
    expect(
      lanes
        .flatMap((lane) => lane.matches)
        .map((m) => m.id)
        .sort(),
    ).toEqual(matches.map((m) => m.id).sort());
    const reset = matches.find((m) => m.bracketLane === 'reset')!;
    expect(liveBracketStatus(reset)).toBe('If needed');
    expect(liveBracketStatus({ ...reset, status: 'ready' })).toBe('Upcoming');
    expect(liveBracketStatus({ ...reset, status: 'playing' })).toBe('Playing now');
    expect(liveBracketFeeds(reset).map((feed) => feed.outcome)).toEqual(['winner', 'loser']);
    expect(liveBracketLanes(matches.filter((m) => m.id !== reset.id)).at(-1)!.matches).toHaveLength(
      1,
    );
    expect(liveBracketLanes(bracketFixture(4, false))).toHaveLength(1);
    expect(bracketFixture(0)).toEqual([]);
    expect(bracketFixture(1)).toHaveLength(1);
    expect(bracketFixture(1)[0]).toMatchObject({ outcome: 'bye', winnerId: 'entrant-0' });
  });
});

describe('shared public/planning graph geometry', () => {
  it('accepts measured participant ports and declines absent or backward sources', () => {
    const matches = bracketFixture(4, false);
    const layout = eliminationLaneLayout(
      matches,
      'winners',
      {
        id: (m) => m.id,
        round: (m) => m.nativeRound!,
        slot: (m) => m.nativeSlot!,
        feeds: liveBracketFeeds,
        sourcePort: (_m, outcome) => (outcome === 'winner' ? 93 : 141),
        targetPort: (_m, side) => (side === 0 ? 117 : 201),
      },
      card,
    );
    for (const edge of layout.edges) {
      const source = layout.nodes.find((n) => n.match.id === edge.from)!;
      const target = layout.nodes.find((n) => n.match.id === edge.to)!;
      expect(edge.start.y).toBe(source.y + 93);
      expect(edge.end.y).toBe(target.y + (edge.side === 0 ? 117 : 201));
    }
    expect(
      eliminationLaneLayout(
        matches,
        'winners',
        {
          id: (m) => m.id,
          round: () => 1,
          slot: (m) => m.nativeSlot!,
          feeds: liveBracketFeeds,
        },
        card,
      ).edges,
    ).toEqual([]);
  });

  it.each([2, 3, 4, 7, 16, 32, 64, 128])(
    'keeps %i entrants bounded, deterministic, disjoint and connected only to actual local sources',
    (size) => {
      for (const double of [false, true]) {
        const matches = bracketFixture(size, double);
        for (const lane of liveBracketLanes(matches)) {
          const read = {
            id: (m: (typeof matches)[number]) => m.id,
            round: (m: (typeof matches)[number]) =>
              lane.key === 'finals'
                ? m.bracketLane === 'reset'
                  ? 2
                  : 1
                : (m.bracketRound ?? m.nativeRound!),
            slot: (m: (typeof matches)[number]) => m.nativeSlot!,
            feeds: liveBracketFeeds,
          };
          const layout = eliminationLaneLayout(lane.matches, lane.key, read, card);
          expect(eliminationLaneLayout(lane.matches.toReversed(), lane.key, read, card)).toEqual(
            layout,
          );
          for (const node of layout.nodes) {
            expect(node.x).toBeGreaterThanOrEqual(0);
            expect(node.y).toBeGreaterThanOrEqual(card.top);
            expect(node.x + card.width).toBeLessThanOrEqual(layout.width);
            expect(node.y + card.height).toBeLessThanOrEqual(layout.height);
            expect(
              layout.nodes.filter(
                (other) =>
                  other !== node &&
                  node.x < other.x + card.width &&
                  node.x + card.width > other.x &&
                  node.y < other.y + card.height &&
                  node.y + card.height > other.y,
              ),
            ).toEqual([]);
          }
          const localIds = new Set(lane.matches.map((m) => m.id));
          const expected = lane.matches.flatMap((m) =>
            liveBracketFeeds(m)
              .filter((f) => localIds.has(f.matchId))
              .map((f) => [f.matchId, m.id, f.side]),
          );
          expect(layout.edges.map((edge) => [edge.from, edge.to, edge.side])).toEqual(expected);
          for (const edge of layout.edges) {
            const source = layout.nodes.find((n) => n.match.id === edge.from)!;
            const target = layout.nodes.find((n) => n.match.id === edge.to)!;
            expect(edge.start.x).toBe(source.x + card.width);
            expect(edge.end.x).toBe(target.x);
            expect(edge.end.y).toBeGreaterThan(target.y);
            expect(edge.end.y).toBeLessThan(target.y + card.height);
            expect(edge.path).not.toMatch(/NaN|Infinity/);
          }
        }
      }
    },
  );
});
