import { expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { defaultRatingSettings } from '@smashclub/shared';
import { fitWhr, probabilityFromRatings, whrSetTrials, type WhrSet } from '../src/whr';
import { runWhrModel } from '../src/whrRun';
import type { EngineSet, EngineTournament } from '../src/types';

/** Stable synthetic attendance, skill, score margins and bracket history. */
function history(nights = 12, players = 24, perNight = 60) {
  let seed = 0x5eed;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const tournaments: EngineTournament[] = [];
  const sets: EngineSet[] = [];
  for (let night = 0; night < nights; night++) {
    const tournamentId = `night-${String(night).padStart(2, '0')}`;
    tournaments.push({
      id: tournamentId,
      eventDate: new Date(Date.UTC(2025, 0, 1 + night * 14)).toISOString(),
      isRookie: false,
    });
    for (let game = 0; game < perNight; game++) {
      const a = Math.floor(random() * players);
      const b = (a + 1 + Math.floor(random() * (players - 1))) % players;
      const winner = random() < 1 / (1 + Math.exp(((b - a) / players) * 2)) ? 1 : 2;
      const close = random() < 0.5;
      sets.push({
        id: `${tournamentId}-game-${game}`,
        tournamentId,
        p1PlayerId: `p${a}`,
        p2PlayerId: `p${b}`,
        winner,
        suggestedPlayOrder: game + 1,
        p1Games: winner === 1 ? 3 : close ? 2 : 0,
        p2Games: winner === 2 ? 3 : close ? 2 : 0,
      });
    }
  }
  return { sets, tournaments, settings: defaultRatingSettings };
}

it('matches an independently solved symmetric MAP reference with four wins and one loss', () => {
  // One time point, two equal N(0, 1.2²) priors. Symmetry gives rB=-rA.
  // Solve rA/1.2² = 4 - 5*logistic(2*rA) independently by bisection.
  const sets: WhrSet[] = Array.from({ length: 5 }, (_, i) => ({
    p1PlayerId: 'a',
    p2PlayerId: 'b',
    winner: i < 4 ? 1 : 2,
    time: 0,
  }));
  const fit = fitWhr({ sets, config: { tolerance: 1e-10, maxIterations: 1000 } });
  expect(fit.converged).toBe(true);
  expect(fit.latest('a')!.r).toBeCloseTo(0.4990549731734546, 7);
  expect(fit.latest('b')!.r).toBeCloseTo(-0.4990549731734546, 7);
  expect(fit.latest('a')!.variance).toBeCloseTo(0.5958188680617603, 7);
});

it('weighted results agree with equivalent repeated evidence and swapped perspectives', () => {
  const sets: WhrSet[] = [
    { p1PlayerId: 'a', p2PlayerId: 'b', winner: 1, time: 0, trials: 2 },
    { p1PlayerId: 'a', p2PlayerId: 'b', winner: 2, time: 90 },
  ];
  const weighted = fitWhr({ sets });
  const repeated = fitWhr({
    sets: [sets[0]!, { ...sets[0]!, trials: 1 }, sets[1]!].map((set) => ({ ...set, trials: 1 })),
  });
  const swapped = fitWhr({
    sets: sets.map((s) => ({
      ...s,
      p1PlayerId: s.p2PlayerId,
      p2PlayerId: s.p1PlayerId,
      winner: s.winner === 1 ? 2 : 1,
    })),
  });
  for (const id of ['a', 'b'])
    for (const other of [repeated, swapped]) {
      expect(other.latest(id)!.r).toBeCloseTo(weighted.latest(id)!.r, 6);
      expect(other.latest(id)!.variance).toBeCloseTo(weighted.latest(id)!.variance, 6);
    }
});

it.each([0, 0.5, 1])(
  'evidence weighting %s is symmetric, bounded, and leaves unknown or DQ scores at one trial',
  (weight) => {
    for (let loser = 0; loser < 3; loser++) {
      const a = whrSetTrials({ winner: 1, p1Games: 3, p2Games: loser }, weight);
      expect(whrSetTrials({ winner: 2, p1Games: loser, p2Games: 3 }, weight)).toBe(a);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(2);
    }
    for (const scores of [
      {},
      { p1Games: 0, p2Games: 99 },
      { p1Games: 3, p2Games: -1 },
      { p1Games: null, p2Games: 0 },
    ])
      expect(whrSetTrials({ winner: 1, ...scores }, weight)).toBe(1);
  },
);

it('correction recomputation changes only the affected ledger prefix and restores exactly', () => {
  const input = history();
  const initial = runWhrModel(input);
  const correction = input.sets.findIndex((set) => set.tournamentId === 'night-06');
  const correctedSets = input.sets.map((set, index) =>
    index === correction
      ? {
          ...set,
          winner: set.winner === 1 ? (2 as const) : (1 as const),
          p1Games: set.p2Games,
          p2Games: set.p1Games,
        }
      : set,
  );
  const corrected = runWhrModel({ ...input, sets: correctedSets });
  const ledger = (events: typeof initial.events) =>
    events.map(({ revisedRating: _rating, revisedSd: _sd, ...event }) => event);
  expect(ledger(corrected.events.filter((e) => e.tournamentId < 'night-06'))).toEqual(
    ledger(initial.events.filter((e) => e.tournamentId < 'night-06')),
  );
  expect(corrected.leaderboard).not.toEqual(initial.leaderboard);
  expect(
    runWhrModel({
      ...input,
      sets: [...input.sets].reverse(),
      tournaments: [...input.tournaments].reverse(),
    }),
  ).toEqual(initial);
  const dateByTournament = new Map(input.tournaments.map((t) => [t.id, Date.parse(t.eventDate)]));
  const origin = Date.parse(input.tournaments[0]!.eventDate);
  const fitPrefix = (lastNight: string) =>
    fitWhr({
      sets: correctedSets
        .filter((s) => s.tournamentId <= lastNight)
        .map((s) => ({
          p1PlayerId: s.p1PlayerId,
          p2PlayerId: s.p2PlayerId,
          winner: s.winner,
          time: (dateByTournament.get(s.tournamentId)! - origin) / 86_400_000,
          trials: whrSetTrials(s, input.settings.whrGamesWeight),
        })),
      config: {
        priorSd: input.settings.whrPriorSd,
        driftVariancePerDay: input.settings.whrDriftVariancePerDay,
      },
    });
  for (const [index, tournament] of input.tournaments.entries()) {
    const before = fitPrefix(input.tournaments[index - 1]?.id ?? '');
    const after = fitPrefix(tournament.id);
    const time = (Date.parse(tournament.eventDate) - origin) / 86_400_000;
    // Every set repeats the independently fitted night boundaries. No invented
    // per-match chain or telescoping sum is a WHR contract.
    for (const event of corrected.events.filter((e) => e.tournamentId === tournament.id)) {
      const prior = before.display(event.playerId, time);
      const posterior = after.display(event.playerId, time);
      expect(event.preRating).toBeCloseTo(prior.rating, 8);
      expect(event.preRd).toBeCloseTo(prior.sd, 8);
      expect(event.postRating).toBeCloseTo(posterior.rating, 8);
      expect(event.postRd).toBeCloseTo(posterior.sd, 8);
    }
  }
  for (const row of corrected.leaderboard) {
    const events = corrected.events.filter((e) => e.playerId === row.playerId);
    expect(
      events.every(
        (e) =>
          Number.isFinite(e.revisedRating) && e.revisedSd! > 0 && e.weight >= 1 && e.weight <= 2,
      ),
    ).toBe(true);
  }
});

it('finite uncertainty survives long absences and near-adjacent time points; exhaustion is reported', () => {
  const sets: WhrSet[] = Array.from({ length: 100 }, (_, i) => ({
    p1PlayerId: 'a',
    p2PlayerId: 'b',
    winner: i % 7 === 0 ? 2 : 1,
    time: i < 50 ? 0 : 3650 + i * 0.001,
  }));
  const fit = fitWhr({ sets });
  expect(fit.converged).toBe(true);
  for (const id of fit.playerIds())
    for (const point of fit.track(id)!) {
      expect(Number.isFinite(point.r)).toBe(true);
      expect(Number.isFinite(point.variance) && point.variance > 0).toBe(true);
    }
  expect(fitWhr({ sets, config: { maxIterations: 1, tolerance: 1e-12 } }).converged).toBe(false);
  const p = fit.winProbability('a', 'b', 4000);
  expect(p).toBeGreaterThan(0);
  expect(p).toBeLessThan(1);
  expect(probabilityFromRatings(1e6, -1e6, 1)).toBe(1);
});

it('fits a realistic 1,440-set history within a generous recompute budget', () => {
  const input = history(24, 32, 60);
  runWhrModel(history(2)); // warm the JIT outside measurements
  const samples: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const start = performance.now();
    const result = runWhrModel(input);
    samples.push(performance.now() - start);
    expect(result.converged).toBe(true);
    expect(result.events).toHaveLength(2880);
  }
  const median = samples.toSorted((a, b) => a - b)[1]!;
  console.info(
    `WHR 1,440 sets / 24 nights median: ${median.toFixed(0)}ms (${samples.map((n) => n.toFixed(0)).join(', ')}ms)`,
  );
  // Five seconds leaves substantial CI headroom; catches catastrophic regressions,
  // not noisy microbenchmarks. Three samples absorb one runner scheduling stall.
  expect(median).toBeLessThan(5000);
}, 30_000);
