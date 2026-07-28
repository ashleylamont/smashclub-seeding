import { describe, expect, it } from 'vitest';
import { defaultGlickoSettings } from '@smashclub/shared';
import { computeLeaderboard, computePlayerScore, leagueForRating } from '../src/score';
import type { PlayerFinalState } from '../src/types';

const settings = defaultGlickoSettings;

const makeState = (overrides: Partial<PlayerFinalState> & { playerId: string }): PlayerFinalState => ({
  rating: 1600,
  rd: 100,
  vol: 0.06,
  matchCount: 10,
  wins: 6,
  losses: 4,
  mainMatchCount: 10,
  rookieMatchCount: 0,
  lastTournamentSequence: 2,
  lastPlayedDate: '2025-03-01',
  tournamentIds: new Set(['t1', 't2', 't3']),
  opponentIds: new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']),
  ...overrides,
});

describe('computePlayerScore', () => {
  it('gives an experienced main-bracket player full confidence', () => {
    const state = makeState({ playerId: 'p1' });
    const states = new Map([['p1', state]]);
    const score = computePlayerScore(state, states, settings);
    expect(score.sampleConfidence).toBe(1);
    expect(score.isolationFactor).toBe(0);
    expect(score.effectiveRating).toBeCloseTo(1600, 9);
    expect(score.effectiveRd).toBeCloseTo(100, 9);
    expect(score.conservativeRating).toBeCloseTo(1600 - 200, 9);
  });

  it('floors sample confidence for a tiny sample', () => {
    const state = makeState({
      playerId: 'p1',
      matchCount: 1,
      wins: 1,
      losses: 0,
      mainMatchCount: 1,
      tournamentIds: new Set(['t1']),
      opponentIds: new Set(['x']),
    });
    const states = new Map([['p1', state]]);
    const score = computePlayerScore(state, states, settings);
    // 0.45*(1/3) + 0.35*(1/8) + 0.2*(1/10) = 0.21375 -> floored to 0.35
    expect(score.sampleConfidence).toBeCloseTo(settings.confidenceFloor, 9);
    // Distance from 1500 shrinks by the confidence: 1500 + 100*1*0.35
    expect(score.effectiveRating).toBeCloseTo(1500 + (1600 - 1500) * 0.35, 9);
  });

  it('penalises a rookie-only island: inflated RD, anchored rating', () => {
    const island = makeState({
      playerId: 'rook',
      rating: 1700,
      rd: 150,
      matchCount: 4,
      wins: 4,
      losses: 0,
      mainMatchCount: 0,
      rookieMatchCount: 4,
      tournamentIds: new Set(['t1']),
      opponentIds: new Set(['other']),
    });
    // Their only opponent is also rookie-only, so bridge count is 0.
    const other = makeState({
      playerId: 'other',
      mainMatchCount: 0,
      rookieMatchCount: 4,
      matchCount: 4,
      opponentIds: new Set(['rook']),
    });
    const states = new Map([
      ['rook', island],
      ['other', other],
    ]);
    const score = computePlayerScore(island, states, settings);
    expect(score.bridgeOpponentCount).toBe(0);
    expect(score.isolationFactor).toBe(1);
    // rd multiplier = 1 + 0.9*1 + 0.5 = 2.4 -> 150*2.4 = 360, capped at 350
    expect(score.effectiveRd).toBe(settings.rdCap);
    // anchor = max(0.25, 1 - 0.65 - 0.2) = 0.25; confidence = anchorFloor 0.2
    expect(score.sampleConfidence).toBeCloseTo(settings.anchorFloor, 9);
    expect(score.effectiveRating).toBeCloseTo(1500 + 200 * 0.25 * 0.2, 9);
    // A 1700-rated rookie island seeds far below their raw rating.
    expect(score.conservativeRating).toBeLessThan(1000);
  });

  it('counts bridge opponents from opponents with main-bracket exposure', () => {
    const rook = makeState({
      playerId: 'rook',
      mainMatchCount: 0,
      rookieMatchCount: 5,
      matchCount: 5,
      opponentIds: new Set(['main1', 'main2']),
      tournamentIds: new Set(['t1']),
    });
    const main1 = makeState({ playerId: 'main1' });
    const main2 = makeState({ playerId: 'main2' });
    const states = new Map([
      ['rook', rook],
      ['main1', main1],
      ['main2', main2],
    ]);
    const score = computePlayerScore(rook, states, settings);
    expect(score.bridgeOpponentCount).toBe(2);
    expect(score.isolationFactor).toBeLessThan(1);
  });
});

describe('leagueForRating', () => {
  it('assigns quartile leagues with the legacy emoji labels', () => {
    const ratings = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700];
    expect(leagueForRating(1700, ratings)).toBe('🏆 Champions');
    expect(leagueForRating(1500, ratings)).toBe('🏆 Champions'); // >= sorted[n/4]=1500
    expect(leagueForRating(1400, ratings)).toBe('💼 Smashclub Full-Timers');
    expect(leagueForRating(1200, ratings)).toBe('🎓 Smashclub Grads');
    expect(leagueForRating(1000, ratings)).toBe('👶 Smashclub Interns');
  });
});

describe('computeLeaderboard', () => {
  it('ranks by conservative rating with deterministic tie-breaks', () => {
    const a = makeState({ playerId: 'a', rating: 1700, rd: 80 });
    const b = makeState({ playerId: 'b', rating: 1600, rd: 80 });
    const cTie = makeState({ playerId: 'c', rating: 1600, rd: 80 });
    const states = new Map([
      ['b', b],
      ['c', cTie],
      ['a', a],
    ]);
    const rows = computeLeaderboard(states, settings);
    expect(rows.map((r) => r.playerId)).toEqual(['a', 'b', 'c']);
    expect(rows[0]!.rank).toBe(1);
    expect(rows[0]!.league).toBe('🏆 Champions');
  });
});
