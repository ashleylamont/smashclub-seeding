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

  it('chains each evening’s per-set deltas into one continuous ledger', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });

    // Within a night the rows chain (post of one set = pre of the next), and
    // the chain continues across nights, so the log reads as one trajectory.
    for (const playerId of ['alice', 'falco', 'kirby']) {
      const events = run.events.filter((e) => e.playerId === playerId);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.preRating, `${playerId} row ${i} chains`).toBeCloseTo(events[i - 1]!.postRating, 9);
      }
      expect(events[0]!.preRating).toBeCloseTo(settings.initialRating, 9);
    }
  });

  it('attributes a night’s whole movement across its sets, with no double counting', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });

    // Alice plays two sets in main1. Both carry a share of the night's
    // movement, and the shares sum to exactly the night's total — the value
    // the fit assigns her at that time.
    const aliceFirstDay = run.events.filter(
      (e) => e.playerId === 'alice' && e.tournamentId === 'main1',
    );
    expect(aliceFirstDay).toHaveLength(2);
    const total = aliceFirstDay.reduce((sum, e) => sum + (e.postRating - e.preRating), 0);
    expect(total).toBeCloseTo(aliceFirstDay[1]!.postRating - settings.initialRating, 9);
    // Two wins against distinct opponents: neither row should read as +0.0 —
    // the failure mode of booking the whole night on the first set.
    for (const event of aliceFirstDay) {
      expect(Math.abs(event.postRating - event.preRating)).toBeGreaterThan(0.05);
    }
  });

  it('freezes the ledger: appending a later event never rewrites earlier rows', () => {
    const { tournaments, sets } = club();
    const firstNightOnly = runWhrModel({
      sets: sets.filter((s) => ['main1', 'rookie1'].includes(s.tournamentId)),
      tournaments,
      settings,
    });
    const full = runWhrModel({ sets, tournaments, settings });

    for (const before of firstNightOnly.events) {
      const after = full.events.find((e) => e.playerId === before.playerId && e.setId === before.setId)!;
      expect(after.preRating, `${before.playerId} pre`).toBeCloseTo(before.preRating, 9);
      expect(after.postRating, `${before.playerId} post`).toBeCloseTo(before.postRating, 9);
      expect(after.preRd).toBeCloseTo(before.preRd, 9);
      expect(after.postRd).toBeCloseTo(before.postRd, 9);
    }
  });

  it('carries the current fit’s hindsight estimate on every event row', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });

    for (const event of run.events) {
      expect(event.revisedRating).toBeTypeOf('number');
      expect(event.revisedSd).toBeGreaterThan(0);
    }
    // On the latest night, hindsight and the ledger agree — nothing later has
    // revised it yet. Alice's last set is in main2.
    const aliceLast = run.events.filter((e) => e.playerId === 'alice').at(-1)!;
    expect(aliceLast.revisedRating).toBeCloseTo(aliceLast.postRating, 6);
  });

  it('counts a decisive scoreline as more evidence than a close one', () => {
    const tournaments = [tournament('t1', '2025-01-10T18:00:00.000Z')];
    const base = { suggestedPlayOrder: 1, completedAt: null, challongeMatchId: 1 };
    const sweep: EngineSet[] = [
      { id: 's-a', tournamentId: 't1', p1PlayerId: 'a', p2PlayerId: 'b', winner: 1, ...base, p1Games: 3, p2Games: 0 },
    ];
    const close: EngineSet[] = [
      { id: 's-a', tournamentId: 't1', p1PlayerId: 'a', p2PlayerId: 'b', winner: 1, ...base, p1Games: 3, p2Games: 2 },
    ];
    const sweepRun = runWhrModel({ sets: sweep, tournaments, settings });
    const closeRun = runWhrModel({ sets: close, tournaments, settings });

    const ratingOf = (run: ReturnType<typeof runWhrModel>, id: string): number =>
      run.leaderboard.find((r) => r.playerId === id)!.skillRating;
    expect(ratingOf(sweepRun, 'a')).toBeGreaterThan(ratingOf(closeRun, 'a'));
    // The extra evidence is visible on the row as its weight.
    expect(sweepRun.events[0]!.weight).toBeCloseTo(2, 9);
    expect(closeRun.events[0]!.weight).toBeCloseTo(1, 9);
  });

  it('reports the previous night’s board for the movement column', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });

    // The prefix without the latest night ranks exactly the players who had
    // played by then.
    const firstNight = runWhrModel({
      sets: sets.filter((s) => ['main1', 'rookie1'].includes(s.tournamentId)),
      tournaments,
      settings,
    });
    expect(run.previousRanks.size).toBe(firstNight.leaderboard.length);
    for (const row of firstNight.leaderboard) {
      expect(run.previousRanks.get(row.playerId)).toBe(row.rank);
    }
  });

  it('widens the published uncertainty of a player who has been away', () => {
    const tournaments = [
      tournament('t1', '2025-01-10T18:00:00.000Z', false, 1),
      tournament('t2', '2025-07-10T18:00:00.000Z', false, 2),
    ];
    // Everyone plays night one; only carol and dave return six months later.
    const sets = [
      makeSet('t1', 'alice', 'bob', 1),
      makeSet('t1', 'carol', 'dave', 1),
      makeSet('t2', 'carol', 'dave', 2),
    ];
    const run = runWhrModel({ sets, tournaments, settings });
    const withTwoNights = new Map(run.leaderboard.map((r) => [r.playerId, r]));

    const firstNightOnly = runWhrModel({
      sets: sets.filter((s) => s.tournamentId === 't1'),
      tournaments,
      settings,
    });
    const asOfNightOne = new Map(firstNightOnly.leaderboard.map((r) => [r.playerId, r]));

    // Alice sat out six months: her band is wider than it was the night she
    // played, so her conservative seeding score honestly drops with absence.
    expect(withTwoNights.get('alice')!.skillSd).toBeGreaterThan(asOfNightOne.get('alice')!.skillSd);
    expect(withTwoNights.get('alice')!.sampleConfidence).toBeLessThan(
      asOfNightOne.get('alice')!.sampleConfidence,
    );
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

  /**
   * `seq` is the replay's global processing order, and readers use it as one:
   * "everything before this night" is `seq < the night's first seq`. A
   * per-player counter — which this used to be — numbered every player's first
   * set 1, so a night containing anyone new had a first seq of 1 and nothing
   * in club history sorted before it. The recap read that as a room full of
   * first-timers, every night.
   */
  it('numbers events in one global chronological sequence', () => {
    const { tournaments, sets } = club();
    const run = runWhrModel({ sets, tournaments, settings });

    const seqs = run.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(run.events.length);

    // Every event of the first evening comes before every event of the second.
    const firstNight = run.events.filter((e) => e.tournamentId.endsWith('1'));
    const secondNight = run.events.filter((e) => e.tournamentId.endsWith('2'));
    expect(Math.max(...firstNight.map((e) => e.seq))).toBeLessThan(
      Math.min(...secondNight.map((e) => e.seq)),
    );
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

describe('rookie-island calibration', () => {
  const row = (run: ReturnType<typeof runWhrModel>, playerId: string) =>
    run.leaderboard.find((r) => r.playerId === playerId)!;

  it('gives rookie-bracket debutants the rookie prior and leaves the main pool alone', () => {
    const { tournaments, sets } = club();
    const before = runWhrModel({ sets, tournaments, settings });
    const after = runWhrModel({ sets, tournaments, settings: { ...settings, whrRookieDebutPrior: 1350 } });

    // falco farms the rookie island unbeaten; his whole component sinks with
    // its priors, while the disconnected main pool is untouched.
    expect(row(after, 'falco').skillRating).toBeLessThan(row(before, 'falco').skillRating);
    expect(row(after, 'kirby').skillRating).toBeLessThan(row(before, 'kirby').skillRating);
    // Same component-decoupled fit; only convergence noise may differ.
    expect(row(after, 'alice').skillRating).toBeCloseTo(row(before, 'alice').skillRating, 2);
  });

  it('anchors an islander’s displayed rating without touching bridged players', () => {
    const { tournaments, sets } = club();
    const raw = runWhrModel({ sets, tournaments, settings });
    const anchored = runWhrModel({ sets, tournaments, settings: { ...settings, whrIsolationAnchor: true } });

    // falco: all matches rookie, no opponent has main experience — fully
    // isolated, so the displayed rating shrinks toward the prior.
    expect(row(anchored, 'falco').isolationFactor).toBeGreaterThan(0.9);
    expect(row(anchored, 'falco').skillRating).toBeLessThan(row(raw, 'falco').skillRating);
    expect(row(anchored, 'falco').skillRating).toBeGreaterThan(1500);
    // alice never plays a rookie bracket: no anchor.
    expect(row(anchored, 'alice').isolationFactor).toBe(0);
    expect(row(anchored, 'alice').skillRating).toBeCloseTo(row(raw, 'alice').skillRating, 8);
    // The fit itself is untouched — only the published number moves.
    expect(row(anchored, 'falco').rating).toBeCloseTo(row(raw, 'falco').rating, 8);
  });

  it('measures bridging by match share, not by having met five main players once', () => {
    // An islander who has brushed past several main-bracket regulars inside
    // the rookie bracket, but whose record is still 6/7 intra-island.
    const tournaments = [
      tournament('m1', '2025-01-10T18:00:00.000Z', false, 1),
      tournament('r1', '2025-01-10T20:30:00.000Z', true, 2),
      tournament('m2', '2025-02-10T18:00:00.000Z', false, 3),
      tournament('r2', '2025-02-10T20:30:00.000Z', true, 4),
    ];
    const sets = [
      // Five main-bracket regulars establish main experience.
      makeSet('m1', 'v1', 'v2', 1),
      makeSet('m1', 'v3', 'v4', 1),
      makeSet('m2', 'v5', 'v1', 1),
      // The islander meets one veteran once, then farms rookies.
      makeSet('r1', 'island', 'v5', 1),
      makeSet('r1', 'island', 'r-a', 1),
      makeSet('r1', 'island', 'r-b', 1),
      makeSet('r2', 'island', 'r-c', 1),
      makeSet('r2', 'island', 'r-d', 1),
      makeSet('r2', 'island', 'r-e', 1),
      makeSet('r2', 'island', 'r-f', 1),
    ];
    const run = runWhrModel({ sets, tournaments, settings: { ...settings, whrIsolationAnchor: true } });
    const islander = run.leaderboard.find((r) => r.playerId === 'island')!;
    // One bridge match in seven is thin exposure; the old count-based test
    // would have scored this same record 1/5 bridged per *opponent* and, at
    // five veterans, called it fully bridged.
    expect(islander.isolationFactor).toBeGreaterThan(0.5);
  });

  it('keeps a rookie-only record provisional no matter how long it grows', () => {
    const tournaments = [
      tournament('r1', '2025-01-10T18:00:00.000Z', true, 1),
      tournament('r2', '2025-02-10T18:00:00.000Z', true, 2),
      tournament('m1', '2025-03-10T18:00:00.000Z', false, 3),
    ];
    const sets = [
      ...Array.from({ length: 4 }, (_, i) => makeSet('r1', 'grinder', `op-${i}`, 1 as const)),
      ...Array.from({ length: 4 }, (_, i) => makeSet('r2', 'grinder', `op-${4 + i}`, 1 as const)),
      // A main-bracket player with the same volume graduates as before.
      ...Array.from({ length: 4 }, (_, i) => makeSet('m1', 'regular', `mo-${i}`, 1 as const)),
      ...Array.from({ length: 4 }, (_, i) => makeSet('r1', 'regular', `mo-${4 + i}`, 1 as const)),
    ];
    const run = runWhrModel({ sets, tournaments, settings });
    expect(run.leaderboard.find((r) => r.playerId === 'grinder')!.isProvisional).toBe(true);
    expect(run.leaderboard.find((r) => r.playerId === 'regular')!.isProvisional).toBe(false);
  });
});
