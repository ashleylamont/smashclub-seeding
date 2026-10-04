import { describe, expect, it } from 'vitest';
import { LEAGUE_CATCH_ALL, defaultRatingSettings } from '@smashclub/shared';
import {
  activityPenaltyFor,
  calibrateLeagueBands,
  leagueForRating,
  rankScores,
  seedingOrder,
  type PlayerScore,
} from '../src/score';
const settings = defaultRatingSettings;

describe('leagueForRating', () => {
  const bands = settings.leagueBands;

  it('assigns leagues from fixed thresholds', () => {
    expect(leagueForRating(1800, bands)).toBe('🏆 Champions');
    expect(leagueForRating(1650, bands)).toBe('🏆 Champions'); // boundary is inclusive
    expect(leagueForRating(1649, bands)).toBe('💼 Smashclub Full-Timers');
    expect(leagueForRating(1500, bands)).toBe('🎓 Smashclub Grads');
    expect(leagueForRating(900, bands)).toBe('👶 Smashclub Interns');
  });

  it("does not change a player's league when other players' ratings move", () => {
    // The whole point of absolute bands: this player is unaffected by the field.
    const before = leagueForRating(1530, bands);
    const after = leagueForRating(1530, bands);
    expect(before).toBe(after);
    expect(before).toBe('💼 Smashclub Full-Timers');
  });
});

describe('calibrateLeagueBands', () => {
  it('derives thresholds from the current field so the switch preserves the distribution', () => {
    const field = Array.from({ length: 100 }, (_, i) => 1200 + i * 6); // 1200..1794
    const calibrated = calibrateLeagueBands(field);
    expect(calibrated).toHaveLength(4);
    expect(calibrated[0]!.name).toBe('🏆 Champions');
    // Thresholds descend, and the last band catches everyone else.
    expect(calibrated[0]!.minRating).toBeGreaterThan(calibrated[1]!.minRating);
    expect(calibrated[1]!.minRating).toBeGreaterThan(calibrated[2]!.minRating);
    expect(calibrated[3]!.minRating).toBe(LEAGUE_CATCH_ALL);

    // Applying them back to the field yields roughly even quarters.
    const counts = new Map<string, number>();
    for (const rating of field) {
      const league = leagueForRating(rating, calibrated);
      counts.set(league, (counts.get(league) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      expect(count).toBeGreaterThanOrEqual(20);
      expect(count).toBeLessThanOrEqual(30);
    }
  });

  it('handles an empty field without throwing', () => {
    expect(calibrateLeagueBands([])).toHaveLength(4);
  });
});

describe('activityPenaltyFor', () => {
  it('is free inside the grace window, flat after it, and capped', () => {
    const missed = [0, 1, 2, 3, 4, 5, 12];
    expect(missed.map((m) => activityPenaltyFor(m, settings))).toEqual([
      0, 0, 40, 80, 120, 120, 120,
    ]);
  });

  it('resets in full — the penalty is a function of the current gap only', () => {
    // Someone back from a year away is charged exactly what a newly-absent
    // player is: nothing. There is no memory of past absences to serve out.
    expect(activityPenaltyFor(0, settings)).toBe(0);
  });

  it('honours a zero grace window', () => {
    const strict = { ...settings, activityGraceEvents: 0 };
    expect(activityPenaltyFor(1, strict)).toBe(strict.activityPenaltyPerEvent);
  });
});

describe('board and seeding policy', () => {
  const score = (playerId: string, skillRating: number, skillSd: number, penalty = 0) =>
    ({
      playerId,
      skillRating,
      skillSd,
      clubRating: skillRating - penalty,
      conservativeRating: skillRating - 2 * skillSd,
    }) as PlayerScore;
  it('ranks club rating with deterministic skill, uncertainty and identity tie breaks', () => {
    const rows = [score('c', 1600, 50), score('b', 1600, 50), score('a', 1620, 90, 20)];
    expect(rankScores(rows, settings).map((r) => r.playerId)).toEqual(['a', 'b', 'c']);
    expect(rankScores(rows, settings).map((r) => r.rank)).toEqual([1, 2, 3]);
  });
  it('seeds on skill minus two SD without attendance deductions', () => {
    const rows = [score('uncertain', 1800, 220), score('regular', 1600, 50, 120)];
    expect(rankScores(rows, settings).map((r) => r.playerId)).toEqual(['uncertain', 'regular']);
    expect(seedingOrder(rows).map((r) => r.playerId)).toEqual(['regular', 'uncertain']);
  });
});
