import { describe, expect, it } from 'vitest';
import { breakthroughSearch, summariseBreakthrough, type BreakthroughPlayer } from '../src/lib/breakthrough';

const player: BreakthroughPlayer = { playerId: 'a', name: 'A', priorNights: 2, priorSets: 8,
  baseline: { rating: 1400, sd: 100 }, sets: [0.2, 0.6, 0.3].map((expected, i) => ({
    setId: String(i), tournamentId: 't', opponentId: String(i), opponentName: 'Opponent',
    opponentPriorNights: 2, won: i !== 2, expected, score: '2-1', stage: 'final',
  })) };

describe('TO comparison controls', () => {
  it('keeps wins, expected wins and smoothing on the same comparable subset', () => {
    const result = summariseBreakthrough({ ...player, sets: [...player.sets, { ...player.sets[0]!, setId: 'new', expected: null, won: true }] }, breakthroughSearch({}));
    expect(result.wins).toBe(3);
    expect(result.assessedWins).toBe(2);
    expect(result.expected).toBeCloseTo(1.1);
    expect(result.surplus).toBeCloseTo(0.9);
    expect(result.adjusted).toBeCloseTo(15);
    expect(result.withoutBest).toBeCloseTo(2);
    expect(result.unassessed).toBe(1);
    expect(result.meetsCriteria).toBe(true);
  });
  it('lets organisers turn smoothing off and flags repeat opponents', () => {
    expect(summariseBreakthrough(player, breakthroughSearch({ smoothing: 0 })).adjusted).toBeCloseTo(30);
    const result = summariseBreakthrough({ ...player, sets: player.sets.map((s) => ({ ...s, opponentId: 'same' })) }, breakthroughSearch({}));
    expect(result.meetsCriteria).toBe(false);
    expect(result.reasons).toContain('1/3 comparable opponents');
  });
  it('never presents no evidence as zero performance, even with all thresholds disabled', () => {
    const result = summariseBreakthrough({ ...player, baseline: null, sets: [] }, breakthroughSearch({ priorNights: 0, priorSets: 0, nightSets: 0, opponents: 0, smoothing: 0 }));
    expect(result.adjusted).toBeNull();
    expect(result.withoutBest).toBeNull();
    expect(result.meetsCriteria).toBe(false);
  });
  it('validates shared URL criteria and rejects invalid dates and non-finite values', () => {
    const result = breakthroughSearch({ event: '2026-02-30', smoothing: -1, priorNights: '2', nightSets: Infinity, priorSets: 1.5, showAll: 'false' });
    expect(result.event).toBe('');
    expect(result.smoothing).toBe(3);
    expect(result.nightSets).toBe(3);
    expect(result.priorSets).toBe(8);
    expect(result.showAll).toBe(false);
  });
});
