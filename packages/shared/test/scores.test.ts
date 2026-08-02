import { describe, expect, it } from 'vitest';
import { scoresIndicateBye, scoresIndicateForfeit, scoresIndicateUnplayed } from '../src/scores';

/**
 * Which `scores_csv` values describe a set someone actually played. Three
 * layers ask this — the sync (does it count towards ratings), the recap (is
 * there a story here) and the web (what do we print) — and they must agree.
 */

describe('scoresIndicateBye', () => {
  it('recognises the club convention for an unplayed slot', () => {
    expect(scoresIndicateBye('99-0')).toBe(true);
    expect(scoresIndicateBye('0-99')).toBe(true);
  });

  it('leaves real sets alone, including a best-of-five', () => {
    for (const score of ['2-0', '2-1', '1-2', '0-2', '3-0', '3-2']) {
      expect(scoresIndicateBye(score)).toBe(false);
    }
  });

  it('reads per-game scorelines too', () => {
    expect(scoresIndicateBye('1-0,0-1,1-0')).toBe(false);
    expect(scoresIndicateBye('99-0,0-0')).toBe(true);
  });

  it('has nothing to say about a missing or unreadable score', () => {
    expect(scoresIndicateBye(null)).toBe(false);
    expect(scoresIndicateBye('')).toBe(false);
    expect(scoresIndicateBye('W/O')).toBe(false);
  });
});

describe('scoresIndicateForfeit', () => {
  it('recognises Challonge’s negative-score convention', () => {
    expect(scoresIndicateForfeit('-1-0')).toBe(true);
    expect(scoresIndicateForfeit('2-0')).toBe(false);
  });
});

describe('scoresIndicateUnplayed', () => {
  it('covers both a walkover and a bye', () => {
    expect(scoresIndicateUnplayed('-1-0')).toBe(true);
    expect(scoresIndicateUnplayed('99-0')).toBe(true);
    expect(scoresIndicateUnplayed('2-1')).toBe(false);
  });
});
