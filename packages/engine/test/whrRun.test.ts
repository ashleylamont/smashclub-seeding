import { describe, expect, it } from 'vitest';
import { defaultGlickoSettings } from '@smashclub/shared';
import { runWhrModel } from '../src/whrRun';
import { replayRatings } from '../src/replay';
import { computeLeaderboard } from '../src/score';
import type { EngineSet, EngineTournament } from '../src/types';

/**
 * The production WHR path: the same input the Glicko replay takes, the same
 * output shape, and the two structural decisions that differ from it — periods
 * are event days, and movement is booked per period rather than per set.
 */

const settings = defaultGlickoSettings;

const tournament = (id: string, eventDate: string, isRookie = false, challongeId?: number): EngineTournament => ({
  id,
  eventDate,
  isRookie,
  challongeId: challongeId ?? null,
});

let counter = 0;
const makeSet = (tournamentId: string, p1: string, p2: string, winner: 1 | 2): EngineSet => ({
  id: `s-${++counter}`,
  tournamentId,
  p1PlayerId: p1,
  p2PlayerId: p2,
  winner,
  suggestedPlayOrder: counter,
  completedAt: null,
  challongeMatchId: counter,
});

/** Two evenings, each with a main and a rookie bracket; one crossover player. */
function club(): { tournaments: EngineTournament[]; sets: EngineSet[] } {
  return {
    tournaments: [
      tournament('main1', '2025-01-10T18:00:00.000Z', false, 1),
      tournament('rookie1', '2025-01-10T20:30:00.000Z', true, 2),
      tournament('main2', '2025-02-10T18:00:00.000Z', false, 3),
      tournament('rookie2', '2025-02-10T20:30:00.000Z', true, 4),
    ],
    sets: [
      makeSet('main1', 'alice', 'bob', 1),
      makeSet('main1', 'alice', 'carol', 1),
      makeSet('rookie1', 'falco', 'kirby', 1),
      makeSet('main2', 'alice', 'bob', 2),
      makeSet('rookie2', 'falco', 'yoshi', 1),
      makeSet('rookie2', 'kirby', 'yoshi', 1),
    ],
  };
}

describe('runWhrModel', () => {
  it('produces a dense leaderboard where seeding stays below skill', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });

    expect(run.converged).toBe(true);
    expect(run.leaderboard).toHaveLength(6);
    expect(run.leaderboard.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6]);

    for (const row of run.leaderboard) {
      expect(Number.isFinite(row.skillRating)).toBe(true);
      expect(row.skillSd).toBeGreaterThan(0);
      // Seeding is the pessimistic estimate under this model too.
      expect(row.conservativeRating).toBeCloseTo(row.skillRating - 2 * row.skillSd, 9);
      expect(row.league).toBeTruthy();
    }

    // Ranked on skill, descending, with uncertainty breaking ties.
    const ratings = run.leaderboard.map((row) => row.skillRating);
    expect([...ratings].sort((a, b) => b - a)).toEqual(ratings);
  });

  it('counts one period per event day, not per bracket', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });
    // Four brackets across two evenings.
    expect(run.periods).toBe(2);
  });

  it('holds a player at one rating for a whole evening, across both brackets', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });

    // Falco plays a rookie set on each evening; kirby plays on both too.
    for (const playerId of ['alice', 'falco', 'kirby']) {
      const events = run.events.filter((e) => e.playerId === playerId);
      const byDay = new Map<string, Set<number>>();
      for (const event of events) {
        const day = tournaments.find((t) => t.id === event.tournamentId)!.eventDate.slice(0, 10);
        const ratings = byDay.get(day) ?? new Set<number>();
        ratings.add(event.postRating);
        byDay.set(day, ratings);
      }
      for (const [day, ratings] of byDay) {
        expect(ratings.size, `${playerId} has multiple ratings on ${day}`).toBe(1);
      }
    }
  });

  it('books each period’s movement exactly once, so per-set deltas do not double count', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });

    // Alice plays two sets in main1: the first carries the move, the second is flat.
    const aliceFirstDay = run.events.filter(
      (e) => e.playerId === 'alice' && e.tournamentId === 'main1',
    );
    expect(aliceFirstDay).toHaveLength(2);
    expect(aliceFirstDay.filter((e) => e.preRating !== e.postRating)).toHaveLength(1);
    expect(aliceFirstDay[0]!.preRating).toBeCloseTo(settings.initialRating, 9);
    expect(aliceFirstDay[1]!.preRating).toBeCloseTo(aliceFirstDay[1]!.postRating, 9);
  });

  it('emits no decay rows — uncertainty grows from elapsed time inside the fit', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });
    expect(run.events.some((e) => e.isDecay)).toBe(false);
    expect(run.events.every((e) => e.opponentId !== null)).toBe(true);
    expect(run.events.every((e) => e.setId !== null)).toBe(true);
  });

  it('gives every player a win/loss record that matches their sets', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });

    const expected = new Map<string, { wins: number; losses: number }>();
    for (const set of sets) {
      const winner = set.winner === 1 ? set.p1PlayerId : set.p2PlayerId;
      const loser = set.winner === 1 ? set.p2PlayerId : set.p1PlayerId;
      (expected.get(winner) ?? expected.set(winner, { wins: 0, losses: 0 }).get(winner)!).wins += 1;
      (expected.get(loser) ?? expected.set(loser, { wins: 0, losses: 0 }).get(loser)!).losses += 1;
    }
    for (const row of run.leaderboard) {
      expect({ wins: row.wins, losses: row.losses }).toEqual(expected.get(row.playerId));
      expect(row.matchCount).toBe(row.wins + row.losses);
    }
  });

  it('counts events attended, not brackets entered', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });

    // Falco plays a rookie set on each of the two evenings: two brackets, two
    // events. Kirby plays rookie1 and rookie2 as well.
    const falco = run.leaderboard.find((r) => r.playerId === 'falco')!;
    expect(falco.tournamentCount).toBe(2);
    expect(falco.eventCount).toBe(2);

    // Alice plays two sets in main1 and one in main2 — two brackets, two events.
    const alice = run.leaderboard.find((r) => r.playerId === 'alice')!;
    expect(alice.tournamentCount).toBe(2);
    expect(alice.eventCount).toBe(2);

    // Nobody can attend more events than brackets.
    for (const row of run.leaderboard) {
      expect(row.eventCount).toBeLessThanOrEqual(row.tournamentCount);
    }
  });

  it('agrees with the Glicko replay on how many events each player attended', () => {
    const { tournaments, sets } = club();
    // One player in both brackets of one evening — the case the two paths could
    // disagree on if they derived "same occasion" differently.
    sets.push(makeSet('rookie1', 'alice', 'kirby', 1));

    const whr = runWhrModel({ sets, tournaments, settings });
    const glicko = computeLeaderboard(
      replayRatings({ sets, tournaments, settings }).finalStates,
      settings,
    );

    const whrEvents = new Map(whr.leaderboard.map((r) => [r.playerId, r.eventCount]));
    for (const row of glicko) {
      expect(whrEvents.get(row.playerId), row.playerId).toBe(row.eventCount);
    }
  });

  it('is invariant to the order sets are supplied in', () => {
    const { tournaments, sets } = club();
    const forward = runWhrModel({ sets, tournaments, settings });
    const reversed = runWhrModel({ sets: [...sets].reverse(), tournaments, settings });

    // The whole point of a batch fit: input order cannot be a rating input.
    expect(reversed.leaderboard.map((r) => r.playerId)).toEqual(forward.leaderboard.map((r) => r.playerId));
    for (const [index, row] of forward.leaderboard.entries()) {
      expect(reversed.leaderboard[index]!.skillRating).toBeCloseTo(row.skillRating, 9);
      expect(reversed.leaderboard[index]!.skillSd).toBeCloseTo(row.skillSd, 9);
    }
  });

  it('separates a player who only wins from one who only loses', () => {
    const tournaments = [tournament('t1', '2025-01-10T18:00:00.000Z')];
    const sets = [
      makeSet('t1', 'winner', 'loser', 1),
      makeSet('t1', 'winner', 'loser', 1),
      makeSet('t1', 'winner', 'loser', 1),
    ];
    const run = runWhrModel({ sets, tournaments, settings });
    const winner = run.leaderboard.find((r) => r.playerId === 'winner')!;
    const loser = run.leaderboard.find((r) => r.playerId === 'loser')!;
    expect(winner.skillRating).toBeGreaterThan(loser.skillRating);
    expect(winner.rank).toBeLessThan(loser.rank);
  });

  it('returns an empty result rather than throwing when there is nothing to rate', () => {
    const run = runWhrModel({ sets: [], tournaments: [tournament('t1', '2025-01-10')], settings });
    expect(run.leaderboard).toEqual([]);
    expect(run.events).toEqual([]);
    expect(run.periods).toBe(0);
    expect(run.converged).toBe(true);
  });

  it('ignores sets whose tournament is unknown, and self-play', () => {
    const tournaments = [tournament('t1', '2025-01-10T18:00:00.000Z')];
    const sets = [
      makeSet('t1', 'alice', 'bob', 1),
      makeSet('ghost', 'alice', 'carol', 1),
      makeSet('t1', 'dave', 'dave', 1),
    ];
    const run = runWhrModel({ sets, tournaments, settings });
    expect(run.leaderboard.map((r) => r.playerId).sort()).toEqual(['alice', 'bob']);
  });
});
