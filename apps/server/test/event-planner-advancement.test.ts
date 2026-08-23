import { describe, expect, it } from 'vitest';
import {
  buildConsolationBracket,
  championshipQualifiers,
  standardBracketOrder,
  type PoolFinisher,
} from '../src/event-planner/advancement';

/** Every pool's 1-4, for a division of `poolCount` pools. */
function finishers(poolCount: number): PoolFinisher[] {
  const rows: PoolFinisher[] = [];
  for (let poolIndex = 0; poolIndex < poolCount; poolIndex++) {
    for (let place = 1; place <= 4; place++) {
      rows.push({ playerId: `p${poolIndex}-${place}`, poolIndex, place });
    }
  }
  return rows;
}

describe('standardBracketOrder', () => {
  it('pairs top against bottom, recursively', () => {
    expect(standardBracketOrder(2)).toEqual([1, 2]);
    expect(standardBracketOrder(4)).toEqual([1, 4, 2, 3]);
    expect(standardBracketOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
});

describe('buildConsolationBracket', () => {
  it('takes only third and fourth places', () => {
    const bracket = buildConsolationBracket(finishers(4));
    expect(bracket.entrants).toHaveLength(8);
    expect(new Set(bracket.entrants.map((entrant) => entrant.place))).toEqual(new Set([3, 4]));
  });

  it.each([2, 3, 4, 5, 6])('never draws a round-one pool rematch (%i pools)', (poolCount) => {
    const bracket = buildConsolationBracket(finishers(poolCount));
    expect(bracket.rematches).toEqual([]);
    for (const pair of bracket.roundOne) {
      if (pair.b) expect(pair.a.poolIndex).not.toBe(pair.b.poolIndex);
    }
  });

  it.each([2, 3, 4, 5, 6])('includes every qualifier exactly once (%i pools)', (poolCount) => {
    const bracket = buildConsolationBracket(finishers(poolCount));
    const ids = bracket.entrants.map((entrant) => entrant.playerId);
    expect(new Set(ids).size).toBe(poolCount * 2);
    const drawn = bracket.roundOne.flatMap((pair) => (pair.b ? [pair.a.playerId, pair.b.playerId] : [pair.a.playerId]));
    expect(new Set(drawn)).toEqual(new Set(ids));
  });

  it.each([2, 3, 4, 5, 6])('numbers seeds 1..n with no gaps (%i pools)', (poolCount) => {
    const bracket = buildConsolationBracket(finishers(poolCount));
    expect(bracket.entrants.map((entrant) => entrant.bracketSeed)).toEqual(
      Array.from({ length: poolCount * 2 }, (_, index) => index + 1),
    );
  });

  it('pairs a third against a fourth when the field allows it', () => {
    const bracket = buildConsolationBracket(finishers(4));
    for (const pair of bracket.roundOne) {
      expect(new Set([pair.a.place, pair.b!.place])).toEqual(new Set([3, 4]));
    }
  });

  it('separates the strongest thirds into different halves', () => {
    const bracket = buildConsolationBracket(finishers(4));
    // A3 and B3 are the two best consolation entrants; they must not meet until
    // the final, so they start in opposite halves of the draw.
    const half = (label: string) => {
      const index = bracket.roundOne.findIndex((pair) => pair.a.label === label || pair.b?.label === label);
      return index < bracket.roundOne.length / 2 ? 'top' : 'bottom';
    };
    expect(half('A3')).not.toBe(half('B3'));
  });

  it('labels entrants by pool and place for the audit trail', () => {
    const bracket = buildConsolationBracket(finishers(2));
    expect(bracket.entrants.map((entrant) => entrant.label).sort()).toEqual(['A3', 'A4', 'B3', 'B4']);
  });

  it('gives byes to the strongest qualifiers when the field is not a power of two', () => {
    const bracket = buildConsolationBracket(finishers(3));
    expect(bracket.bracketSize).toBe(8);
    const byes = bracket.roundOne.filter((pair) => pair.b === null).map((pair) => pair.a.label);
    expect(byes.sort()).toEqual(['A3', 'B3']);
  });

  it('is deterministic', () => {
    const first = buildConsolationBracket(finishers(5));
    const second = buildConsolationBracket(finishers(5));
    expect(first.entrants).toEqual(second.entrants);
  });

  it('reports the unavoidable rematch when a division has a single pool', () => {
    const bracket = buildConsolationBracket(finishers(1));
    expect(bracket.entrants).toHaveLength(2);
    expect(bracket.rematches).toHaveLength(1);
  });

  it('rejects a pool with two players in the same place', () => {
    expect(() =>
      buildConsolationBracket([
        { playerId: 'a', poolIndex: 0, place: 3 },
        { playerId: 'b', poolIndex: 0, place: 3 },
      ]),
    ).toThrow(/two players in place 3/);
  });

  it('rejects a field with nobody to seed', () => {
    expect(() => buildConsolationBracket([{ playerId: 'a', poolIndex: 0, place: 1 }])).toThrow(/No third-/);
  });
});

describe('championshipQualifiers', () => {
  it('is first and second from every pool, in pool order', () => {
    expect(championshipQualifiers(finishers(2)).map((qualifier) => qualifier.label)).toEqual([
      'A1',
      'A2',
      'B1',
      'B2',
    ]);
  });
});
