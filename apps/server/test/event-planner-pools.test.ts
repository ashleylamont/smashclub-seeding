import { describe, expect, it } from 'vitest';
import { poolCountFor, poolLabel, stripeIntoPools } from '../src/event-planner/pools';

const seeds = (n: number) => Array.from({ length: n }, (_, index) => index + 1);

describe('stripeIntoPools', () => {
  it('matches the documented 16-entrant layout', () => {
    expect(stripeIntoPools(seeds(16))).toEqual([
      [1, 8, 9, 16],
      [2, 7, 10, 15],
      [3, 6, 11, 14],
      [4, 5, 12, 13],
    ]);
  });

  it('snakes an 8-entrant division into two pools', () => {
    expect(stripeIntoPools(seeds(8))).toEqual([
      [1, 4, 5, 8],
      [2, 3, 6, 7],
    ]);
  });

  it('snakes a 12-entrant division into three pools', () => {
    expect(stripeIntoPools(seeds(12))).toEqual([
      [1, 6, 7, 12],
      [2, 5, 8, 11],
      [3, 4, 9, 10],
    ]);
  });

  it('snakes a 20-entrant division into five pools', () => {
    expect(stripeIntoPools(seeds(20))).toEqual([
      [1, 10, 11, 20],
      [2, 9, 12, 19],
      [3, 8, 13, 18],
      [4, 7, 14, 17],
      [5, 6, 15, 16],
    ]);
  });

  it('snakes a 24-entrant division into six pools', () => {
    expect(stripeIntoPools(seeds(24))).toEqual([
      [1, 12, 13, 24],
      [2, 11, 14, 23],
      [3, 10, 15, 22],
      [4, 9, 16, 21],
      [5, 8, 17, 20],
      [6, 7, 18, 19],
    ]);
  });

  it.each([8, 12, 16, 20, 24])('places every entrant exactly once (%i)', (size) => {
    const pools = stripeIntoPools(seeds(size));
    expect(pools.flat().sort((a, b) => a - b)).toEqual(seeds(size));
    expect(pools).toHaveLength(size / 4);
    for (const pool of pools) expect(pool).toHaveLength(4);
  });

  it('gives every pool the same seed total, which is the point of striping', () => {
    const totals = stripeIntoPools(seeds(16)).map((pool) => pool.reduce((sum, seed) => sum + seed, 0));
    expect(new Set(totals).size).toBe(1);
  });

  it('is deterministic', () => {
    expect(stripeIntoPools(seeds(20))).toEqual(stripeIntoPools(seeds(20)));
  });

  it('rejects a division that does not divide into whole pools', () => {
    expect(() => stripeIntoPools(seeds(14))).toThrow(/do not divide/);
    expect(() => stripeIntoPools([])).toThrow(/empty division/);
  });

  it('preserves the entrants themselves, not just their order', () => {
    const players = seeds(8).map((seed) => ({ id: `p${seed}`, seed }));
    const pools = stripeIntoPools(players);
    expect(pools[0]!.map((player) => player.id)).toEqual(['p1', 'p4', 'p5', 'p8']);
  });
});

describe('poolLabel', () => {
  it('labels pools A, B, C ...', () => {
    expect([0, 1, 2, 25].map(poolLabel)).toEqual(['A', 'B', 'C', 'Z']);
  });

  it('keeps going past Z', () => {
    expect(poolLabel(26)).toBe('AA');
  });
});

describe('poolCountFor', () => {
  it('reports pools per division', () => {
    expect(poolCountFor(16)).toBe(4);
    expect(poolCountFor(12)).toBe(3);
  });
});
