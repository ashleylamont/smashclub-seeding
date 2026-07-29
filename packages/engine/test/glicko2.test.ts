import { describe, expect, it } from 'vitest';
import { applyRatingPeriodWithoutGames, updateRating } from '../src/glicko2';

describe('updateRating', () => {
  it("matches the worked example from Glickman's Glicko-2 paper", () => {
    // Player 1500/200/0.06, tau 0.5, one period: beats 1400/30, loses to
    // 1550/100 and 1700/300. Paper: r' ≈ 1464.06, RD' ≈ 151.52, vol ≈ 0.05999.
    const result = updateRating(
      { rating: 1500, rd: 200, vol: 0.06 },
      [
        { rating: 1400, rd: 30, outcome: 1 },
        { rating: 1550, rd: 100, outcome: 0 },
        { rating: 1700, rd: 300, outcome: 0 },
      ],
      0.5,
    );
    expect(result.rating).toBeCloseTo(1464.06, 1);
    expect(result.rd).toBeCloseTo(151.52, 1);
    expect(result.vol).toBeCloseTo(0.05999, 4);
  });

  it('raises the winner and lowers the loser symmetrically from pre values', () => {
    const a = { rating: 1500, rd: 350, vol: 0.06 };
    const b = { rating: 1500, rd: 350, vol: 0.06 };
    const newA = updateRating(a, [{ rating: b.rating, rd: b.rd, outcome: 1 }], 0.5);
    const newB = updateRating(b, [{ rating: a.rating, rd: a.rd, outcome: 0 }], 0.5);
    expect(newA.rating).toBeGreaterThan(1500);
    expect(newB.rating).toBeLessThan(1500);
    expect(newA.rating - 1500).toBeCloseTo(1500 - newB.rating, 6);
    expect(newA.rd).toBeLessThan(350);
    expect(newB.rd).toBeLessThan(350);
  });

  it('an upset moves ratings more than an expected result', () => {
    const favourite = { rating: 1800, rd: 100, vol: 0.06 };
    const underdog = { rating: 1400, rd: 100, vol: 0.06 };
    const favouriteWins = updateRating(favourite, [{ rating: 1400, rd: 100, outcome: 1 }], 0.5);
    const favouriteLoses = updateRating(favourite, [{ rating: 1400, rd: 100, outcome: 0 }], 0.5);
    expect(Math.abs(favouriteLoses.rating - favourite.rating)).toBeGreaterThan(
      Math.abs(favouriteWins.rating - favourite.rating),
    );
    const underdogWins = updateRating(underdog, [{ rating: 1800, rd: 100, outcome: 1 }], 0.5);
    expect(underdogWins.rating - underdog.rating).toBeGreaterThan(favouriteWins.rating - favourite.rating);
  });
});

describe('applyRatingPeriodWithoutGames', () => {
  it('grows RD and leaves rating and volatility unchanged', () => {
    const result = applyRatingPeriodWithoutGames({ rating: 1600, rd: 100, vol: 0.06 });
    expect(result.rating).toBe(1600);
    expect(result.vol).toBe(0.06);
    expect(result.rd).toBeGreaterThan(100);
  });
});
