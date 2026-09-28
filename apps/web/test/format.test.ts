import { describe, expect, it } from 'vitest';
import { orientScore, roundLabel, scoreCell } from '../src/lib/format';

/**
 * Challonge reports scores player-one-first. Anywhere the winner is named
 * first — the venue ticker, a result card — printing that verbatim reads as
 * though the winner lost, which is what this guards.
 */
describe('orientScore', () => {
  it('leaves a player-one win alone', () => {
    expect(orientScore('3-1', 1)).toBe('3-1');
  });

  it('flips a player-two win so the winner leads', () => {
    expect(orientScore('1-3', 2)).toBe('3-1');
  });

  it('flips every game of a per-game scoreline', () => {
    expect(orientScore('0-1,1-0,0-1', 2)).toBe('1-0, 0-1, 1-0');
  });

  it('has nothing to show for a forfeit', () => {
    // Challonge marks forfeits with a negative score.
    expect(orientScore('-1-0', 1)).toBeNull();
  });

  it('has nothing to show for a missing or unreadable score', () => {
    expect(orientScore(null, 1)).toBeNull();
    expect(orientScore('', 1)).toBeNull();
    expect(orientScore('W/O', 1)).toBeNull();
  });

  it('has nothing to show when the set has no winner yet', () => {
    expect(orientScore('1-1', null)).toBeNull();
  });

  it('has nothing to show for a bye', () => {
    // `99-0` closes a slot nobody played; "won 99-0" is not a result.
    expect(orientScore('99-0', 1)).toBeNull();
    expect(orientScore('0-99', 2)).toBeNull();
  });

  it('still shows a best-of-five', () => {
    expect(orientScore('3-0', 1)).toBe('3-0');
  });
});

describe('scoreCell', () => {
  it('names what happened when there is no scoreline', () => {
    expect(scoreCell('99-0')).toBe('bye');
    expect(scoreCell('-1-0')).toBe('forfeit');
    expect(scoreCell(null)).toBe('—');
  });

  it('prints a real score as reported, player one first', () => {
    expect(scoreCell('1-2')).toBe('1-2');
  });
});

describe('roundLabel', () => {
  it('separates winners and losers rounds', () => {
    expect(roundLabel(3)).toBe('W3');
    expect(roundLabel(-3)).toBe('L3');
  });
});
