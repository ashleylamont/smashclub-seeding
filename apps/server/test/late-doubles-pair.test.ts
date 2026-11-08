import { expect, it } from 'vitest';
import { captureBaseline, decide, reduceDecision, stableId } from '../src/tournament/domain';
import { reviewLateDoublesPair, type LateDoublesPair } from '../src/tournament/lateDoublesPair';
import type { TournamentBaseline } from '../src/tournament/schemas';
import { attendancePreview } from '../src/tournament/attendance';
import { pendingStrengthFinals } from '../src/tournament/strengthFinals';
import { envelope, pureBaseline } from './helpers/nativeLiveFixture';

function draw(structure: TournamentBaseline['structure'] = 'dual_division') {
  const baseline = pureBaseline();
  baseline.version = 2;
  baseline.competitionFormat = 'doubles';
  baseline.structure = structure;
  baseline.structureOptions = { roundRobinMeetings: 1, consolation: true, playoffSize: 2 };
  for (const entrant of baseline.entrants)
    entrant.memberPlayerIds = [stableId(`${entrant.id}:a`), stableId(`${entrant.id}:b`)];
  if (structure !== 'dual_division') {
    baseline.entrants = baseline.entrants.filter((entry) => entry.division === 'upper');
    baseline.pools = baseline.pools.filter((pool) => pool.division === 'upper');
    baseline.matches = baseline.matches.filter((match) => match.division === 'upper');
  }
  return captureBaseline(baseline);
}

function request(division: LateDoublesPair['division'] = 'upper'): LateDoublesPair {
  return {
    division,
    memberPlayerIds: [stableId('new member A'), stableId('new member B')],
    reason: 'Arrived before pool play',
    identity: { name: 'New A / New B', memberNames: ['New A', 'New B'], memberAliases: [] },
  };
}

it('keeps the selected division and chooses the smallest pristine pool, then its index', () => {
  const state = draw();
  const lower = state.pools[1]!;
  expect(reviewLateDoublesPair(state, request('lower')).pool?.id).toBe(lower.id);
  lower.division = 'upper';
  lower.index = 1;
  const first = state.pools[0]!;
  expect(reviewLateDoublesPair(state, request()).pool?.id).toBe(first.id);

  lower.entrantIds.pop();
  expect(reviewLateDoublesPair(state, request()).pool?.id).toBe(lower.id);
  const called = state.matches.find((match) => match.poolId === lower.id)!;
  called.status = 'playing';
  called.calledAt = state.baseline!.capturedAt;
  expect(reviewLateDoublesPair(state, request()).pool?.id).toBe(first.id);
  first.qualifierRoster = [...first.entrantIds];
  expect(reviewLateDoublesPair(state, request())).toMatchObject({
    allowed: false,
    issues: ['Return the untaken calls in Pool B, then review again.'],
    returnCallMatchIds: [called.id],
  });
  called.started = true;
  expect(reviewLateDoublesPair(state, request())).toMatchObject({
    allowed: false,
    issues: [expect.stringMatching(/calls, recorded play, reports or confirmed qualification/)],
    returnCallMatchIds: [],
  });
});

it('invalidates a preview when a report arrives, even if the result was never accepted', () => {
  const state = draw('pools_finals');
  const before = reviewLateDoublesPair(state, request());
  expect(before.allowed).toBe(true);
  state.settings.scoreReportingMode = 'to_review';
  const match = state.matches[0]!;
  const report = decide(
    state,
    envelope(
      {
        kind: 'score',
        matchId: match.id,
        expectedRevision: match.revision,
        outcome: 'played',
        score1: 2,
        score2: 1,
      },
      { operator: false },
    ),
  )!;
  const reported = reduceDecision(state, report);
  const reviewed = decide(
    reported,
    envelope({
      kind: 'review',
      reportId: report.receipt.reportId!,
      expectedRevision: match.revision,
      approve: false,
    }),
  )!;
  const rejected = reduceDecision(reported, reviewed);
  expect(rejected.reports[0]?.status).toBe('rejected');
  expect(reviewLateDoublesPair(rejected, request()).allowed).toBe(false);
  expect(() =>
    decide(
      rejected,
      envelope({
        ...request(),
        kind: 'addLateDoublesPair',
        revisionToken: before.revisionToken,
      }),
    ),
  ).toThrow(/changed since this preview/);
});

it('calculates scheduling from assigned teams and finals places from eligible teams', () => {
  const initial = draw('pools_finals');
  initial.settings.finalsProgression = 'rolling_pool_places_v1';
  const withdrawn = initial.entrants[0]!.playerId;
  const state = reduceDecision(
    initial,
    decide(
      initial,
      envelope({
        kind: 'attendance',
        action: 'withdraw',
        playerId: withdrawn,
        reason: 'Left early',
        revisionToken: attendancePreview(initial, { action: 'withdraw', playerId: withdrawn })
          .revisionToken,
        approveRedistribution: false,
      }),
    )!,
  );
  const input = request();
  const preview = reviewLateDoublesPair(state, input);
  expect(preview).toMatchObject({
    allowed: true,
    assignedTeams: 4,
    addedMatches: 4,
    pendingForfeits: 1,
    totalMatches: 10,
    finals: { championship: { before: 2, after: 2 }, consolation: { before: 1, after: 2 } },
  });
  const added = reduceDecision(
    state,
    decide(
      state,
      envelope({
        ...input,
        kind: 'addLateDoublesPair',
        revisionToken: preview.revisionToken,
      }),
    )!,
  );
  expect(added.matches.slice(0, state.matches.length)).toEqual(state.matches);
  const newMatches = added.matches.slice(state.matches.length);
  const forfeits = newMatches.filter((match) => match.status === 'blocked');
  expect(forfeits).toHaveLength(preview.pendingForfeits);
  expect([forfeits[0]!.player1Id, forfeits[0]!.player2Id]).toContain(withdrawn);
  expect(forfeits[0]).toMatchObject({
    blockedReason: 'Player withdrawn: awaiting organiser forfeit decision',
    outcome: null,
    winnerId: null,
    score1: null,
    score2: null,
  });
  const finalists = (value: typeof state) =>
    Object.fromEntries(pendingStrengthFinals(value).map((item) => [item.stage, item.slots.length]));
  expect(finalists(state)).toEqual({
    main: preview.finals!.championship.before,
    consolation: preview.finals!.consolation.before,
  });
  expect(finalists(added)).toEqual({
    main: preview.finals!.championship.after,
    consolation: preview.finals!.consolation.after,
  });
  expect(reviewLateDoublesPair(draw('round_robin_finals'), request()).finals).toEqual({
    championship: { before: 2, after: 2 },
    consolation: { before: 2, after: 3 },
  });
  expect(reviewLateDoublesPair(state, request('lower')).issues).toContain(
    'There is no pool in the selected division.',
  );
});

it('keeps the multi-pool cap and allows a single round robin to grow beyond five teams', () => {
  const state = draw('pools_finals');
  const preview = reviewLateDoublesPair(state, request());
  const newPair = (token: string) =>
    envelope({
      ...request(),
      kind: 'addLateDoublesPair',
      revisionToken: token,
    });
  const filled = reduceDecision(state, decide(state, newPair(preview.revisionToken))!);
  const otherPair = {
    ...request(),
    memberPlayerIds: [stableId('another A'), stableId('another B')] as [string, string],
  };
  expect(reviewLateDoublesPair(filled, otherPair).issues).toContain(
    'Every pool in this division is full.',
  );
  const single = draw('round_robin');
  const first = reviewLateDoublesPair(single, request());
  const next = reduceDecision(single, decide(single, newPair(first.revisionToken))!);
  expect(reviewLateDoublesPair(next, otherPair)).toMatchObject({
    allowed: true,
    assignedTeams: 5,
    addedMatches: 5,
    finals: null,
  });
});

it('allows a clean Lower pool after combined Upper finals while retaining the legacy whole-event freeze', () => {
  const state = draw();
  const comparison = { byes: [], rematchesByRound: [] };
  state.brackets.push({
    id: stableId('upper finals'),
    division: 'upper',
    stage: 'main',
    entrantIds: [],
    strengthSeeding: {
      policy: 'pool_place_whr_v1',
      poolPlaceCost: 150,
      seeds: [],
      comparison: { poolPlaces: comparison, combined: comparison },
    },
  });
  expect(reviewLateDoublesPair(state, request('lower')).allowed).toBe(true);
  expect(reviewLateDoublesPair(state, request('upper')).allowed).toBe(false);
  delete state.brackets[0]!.strengthSeeding;
  expect(reviewLateDoublesPair(state, request('lower')).allowed).toBe(false);
});

it('rejects existing registered members, identity redirects, or duplicate selections', () => {
  const state = draw();
  const input = request();
  const existing = state.entrants[0]!.memberPlayerIds![0]!;
  expect(
    reviewLateDoublesPair(state, {
      ...input,
      memberPlayerIds: [existing, input.memberPlayerIds[1]],
    }).allowed,
  ).toBe(false);
  expect(
    reviewLateDoublesPair(state, {
      ...input,
      identity: { ...input.identity!, memberAliases: [existing] },
    }).allowed,
  ).toBe(false);
  expect(
    reviewLateDoublesPair(state, {
      ...input,
      memberPlayerIds: [input.memberPlayerIds[0], input.memberPlayerIds[0]],
    }).allowed,
  ).toBe(false);
});
