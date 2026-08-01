import { describe, expect, it } from 'vitest';
import { LEAGUE_CATCH_ALL, defaultGlickoSettings } from '@smashclub/shared';
import {
  activityPenaltyFor,
  calibrateLeagueBands,
  computeLeaderboard,
  computePlayerScore,
  leagueForRating,
  seedingOrder,
} from '../src/score';
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
  lastPeriodIndex: 2,
  lastPlayedDate: '2025-03-01',
  missedEvents: 0,
  attendanceStreak: 3,
  tournamentIds: new Set(['t1', 't2', 't3']),
  eventKeys: new Set(['2025-01-01', '2025-02-01', '2025-03-01']),
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

describe('computeLeaderboard', () => {
  it('ranks by skill with deterministic tie-breaks', () => {
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
    expect(rows[0]!.skillSd).toBeGreaterThan(0); // uncertainty is exposed, not hidden
  });

  it('costs a lapsed player places — via the stated penalty, not a widened band', () => {
    // Two identical records; one has sat out four club nights. The board has to
    // separate them, and it is the penalty that does it: skill is untouched.
    const active = makeState({ playerId: 'active', rating: 1600, missedEvents: 0 });
    const absent = makeState({ playerId: 'absent', rating: 1600, missedEvents: 4, attendanceStreak: 0 });
    const rows = computeLeaderboard(
      new Map([
        ['absent', absent],
        ['active', active],
      ]),
      settings,
    );
    expect(rows.map((r) => r.playerId)).toEqual(['active', 'absent']);
    expect(rows[0]!.skillRating).toBeCloseTo(rows[1]!.skillRating, 9);
    // 4 missed, 1 free, 3 charged at 40 = 120, which is also the cap.
    expect(rows[1]!.activityPenalty).toBe(120);
    expect(rows[1]!.clubRating).toBeCloseTo(rows[1]!.skillRating - 120, 9);
  });

  it('leaves the every-other-event regular alone: one missed night is free', () => {
    const steady = makeState({ playerId: 'steady', rating: 1600, missedEvents: 0 });
    const irregular = makeState({ playerId: 'irregular', rating: 1600, missedEvents: 1, attendanceStreak: 0 });
    const rows = computeLeaderboard(
      new Map([
        ['steady', steady],
        ['irregular', irregular],
      ]),
      settings,
    );
    const irregularRow = rows.find((r) => r.playerId === 'irregular')!;
    expect(irregularRow.activityPenalty).toBe(0);
    expect(irregularRow.clubRating).toBeCloseTo(irregularRow.skillRating, 9);
    // Their next miss is the one that starts costing, and they can be told so.
    expect(irregularRow.nextMissPenalty).toBe(settings.activityPenaltyPerEvent);
  });

  it('publishes what the next missed night costs, including once capped', () => {
    const capped = makeState({ playerId: 'gone', missedEvents: 9, attendanceStreak: 0 });
    const [row] = computeLeaderboard(new Map([['gone', capped]]), settings);
    expect(row!.activityPenalty).toBe(settings.activityPenaltyCap);
    expect(row!.nextMissPenalty).toBe(0);
  });

  it('does not sink an unproven player the way the conservative rating did', () => {
    // The prospect looks strong on four sets. Shrinkage already pulls a thin
    // record toward the middle; the board should not *also* charge them for
    // being unknown, which is what ranking on skill − 2·RD did.
    const prospect = makeState({
      playerId: 'prospect',
      rating: 1850,
      rd: 240,
      matchCount: 4,
      wins: 4,
      losses: 0,
      mainMatchCount: 4,
      tournamentIds: new Set(['t1']),
      eventKeys: new Set(['2025-03-01']),
      opponentIds: new Set(['x', 'y']),
    });
    const regular = makeState({ playerId: 'regular', rating: 1560, rd: 70 });
    const rows = computeLeaderboard(
      new Map([
        ['prospect', prospect],
        ['regular', regular],
      ]),
      settings,
    );
    const prospectRow = rows.find((r) => r.playerId === 'prospect')!;
    // Held near the middle rather than dumped at the bottom, and badged so a
    // reader knows why.
    expect(prospectRow.isProvisional).toBe(true);
    expect(prospectRow.clubRating).toBeGreaterThan(1400);
    expect(prospectRow.conservativeRating).toBeLessThan(1200);
  });

  it('board and bracket deliberately disagree about a returner', () => {
    // Back after a long absence: the club rating says they are still good (one
    // night back clears the penalty), the seed says we cannot vouch for them
    // yet, because their band is wide. Both are right for their own question.
    const returner = makeState({ playerId: 'returner', rating: 1700, rd: 240, missedEvents: 0 });
    const regular = makeState({ playerId: 'regular', rating: 1600, rd: 60, missedEvents: 0 });
    const rows = computeLeaderboard(
      new Map([
        ['returner', returner],
        ['regular', regular],
      ]),
      settings,
    );
    const scores = rows.map(({ rank: _rank, league: _league, ...score }) => score);

    expect(rows.map((r) => r.playerId)).toEqual(['returner', 'regular']);
    expect(seedingOrder(scores).map((s) => s.playerId)).toEqual(['regular', 'returner']);
  });

  it('labels leagues from the ranked number, so order and league agree', () => {
    const bands = [
      { name: 'Top', minRating: 1550 },
      { name: 'Rest', minRating: LEAGUE_CATCH_ALL },
    ];
    const banded = { ...settings, leagueBands: bands };
    // Same skill; only the one who has kept turning up clears the threshold.
    const rows = computeLeaderboard(
      new Map([
        ['present', makeState({ playerId: 'present', rating: 1600, missedEvents: 0 })],
        ['gone', makeState({ playerId: 'gone', rating: 1600, missedEvents: 5, attendanceStreak: 0 })],
      ]),
      banded,
    );
    expect(rows.map((r) => r.playerId)).toEqual(['present', 'gone']);
    expect(rows.map((r) => r.league)).toEqual(['Top', 'Rest']);
  });
});

describe('activityPenaltyFor', () => {
  it('is free inside the grace window, flat after it, and capped', () => {
    const missed = [0, 1, 2, 3, 4, 5, 12];
    expect(missed.map((m) => activityPenaltyFor(m, settings))).toEqual([0, 0, 40, 80, 120, 120, 120]);
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
