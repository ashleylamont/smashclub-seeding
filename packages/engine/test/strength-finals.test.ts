import { describe, expect, it } from 'vitest';
import {
  poolRematchRounds,
  seedFinalistsByStrength,
  seedPoolFinishers,
  standardBracketOrder,
} from '../src/tournament/advancement';
import { selectFormatFinalists } from '../src/tournament/structure';

const strength = [
  [1600, 1900, 1500],
  [1690, 1560, 1500],
  [1660, 1550, 1490],
  [1640, 1540, 1480],
];

function field(sizes: number[]) {
  const finishers = sizes.flatMap((size, poolIndex) =>
    Array.from({ length: size }, (_, index) => ({
      playerId: String.fromCharCode(65 + poolIndex) + (index + 1),
      poolIndex,
      place: index + 1,
      strength: strength[poolIndex]![index] ?? 1400,
    })),
  );
  return selectFormatFinalists('pools_finals', finishers, 'main');
}

describe('combined finals seeds', () => {
  it('lets frozen WHR outweigh one finishing place without changing who qualifies', () => {
    const entrants = field([4, 4, 4, 4]);
    const poolPlaces = seedPoolFinishers(entrants);
    const combined = seedFinalistsByStrength(entrants);
    expect(combined.entrants.map((seed) => seed.playerId).sort()).toEqual(
      entrants.map((entrant) => entrant.playerId).sort(),
    );
    expect(poolPlaces.entrants[0]!.playerId).toBe('A1');
    expect(combined.seeds[0]).toMatchObject({
      playerId: 'A2',
      place: 2,
      strength: 1900,
      combinedScore: 1750,
      bracketSeed: 1,
    });
    expect(combined.rematches).toHaveLength(0);
    expect(seedFinalistsByStrength([...entrants].reverse())).toEqual(combined);
  });

  it('gives the bye to the top combined rank on an uneven seven-player field', () => {
    const entrants = field([4, 4, 5]);
    const byes = (draw: ReturnType<typeof seedPoolFinishers>) =>
      draw.roundOne.filter(({ b }) => !b).map(({ a }) => a.playerId);
    expect(byes(seedPoolFinishers(entrants))).toEqual(['A1']);
    const combined = seedFinalistsByStrength(entrants);
    expect(byes(combined)).toEqual(['A2']);
    expect(combined.rematches).toHaveLength(0);
  });

  it('can delay possible pool rematches while preserving the four strongest seed paths', () => {
    const ratings = [
      1748, 1471, 1938, 1517, 1638, 1473, 1952, 1567, 1648, 1785, 1844, 1989, 1674, 1751, 1760,
      1797,
    ];
    const entrants = ratings.map((strength, i) => ({
      playerId: String(i),
      poolIndex: i >> 1,
      place: (i % 2) + 1,
      strength,
    }));
    const combined = seedFinalistsByStrength(entrants);
    expect(poolRematchRounds(seedPoolFinishers(entrants))).toEqual([0, 8, 0, 0]);
    expect(poolRematchRounds(combined)).toEqual([0, 0, 0, 8]);
    const order = standardBracketOrder(combined.bracketSize);
    const quarters = combined.seeds
      .filter((seed) => seed.provisionalSeed <= 4)
      .map((seed) => order.indexOf(seed.bracketSeed) >> 2);
    expect(new Set(quarters).size).toBe(4);
  });
});
