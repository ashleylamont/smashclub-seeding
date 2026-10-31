import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEliminationTree } from '@smashclub/engine';
import { captureBaseline, decide, hash, reduceDecision, stableId } from '../src/tournament/domain';
import { attendancePreview } from '../src/tournament/attendance';
import { instantiateElimination } from '../src/tournament/structureAdapter';
import {
  Baseline,
  Decision,
  LiveState,
  type TournamentCommand,
  type TournamentState,
} from '../src/tournament/schemas';
import { envelope, pureBaseline } from './helpers/nativeLiveFixture';

function initial() {
  const baseline = pureBaseline();
  Object.assign(baseline.settings, {
    poolOrderPolicy: 'unique_set_wins_v1',
    finalsProgression: 'rolling_pool_places_v1',
    dispatchMode: 'shared',
    capacity: 2,
  });
  return captureBaseline(baseline);
}
function apply(state: TournamentState, command: TournamentCommand, operator = true) {
  return LiveState.parse(
    reduceDecision(
      state,
      Decision.parse(decide(state, envelope(command, { operator, actorId: crypto.randomUUID() }))!),
    ),
  );
}
function attendance(
  state: TournamentState,
  action: 'withdraw' | 'restore',
  playerId = state.entrants[0]!.playerId,
  reason = 'Returned after an attendance mistake',
) {
  const preview = attendancePreview(state, { action, playerId, reason });
  return {
    kind: 'attendance' as const,
    action,
    playerId,
    reason,
    revisionToken: preview.revisionToken,
    approveRedistribution: false,
  };
}
const score = (match: TournamentState['matches'][number]) => ({
  kind: 'score' as const,
  matchId: match.id,
  expectedRevision: match.revision,
  score1: 2,
  score2: 0,
  outcome: 'played' as const,
});

describe('explicit native attendance restoration', () => {
  it('previews and atomically resumes safe unplayed pairings with identity intact, fresh versions and one retryable V4 receipt', () => {
    const original = initial();
    let state = apply(original, attendance(original, 'withdraw'));
    const target = state.entrants[0]!;
    const before = hash(state);
    const preview = attendancePreview(state, {
      action: 'restore',
      playerId: target.playerId,
      reason: 'Accidental withdrawal',
    });
    expect(hash(state)).toBe(before);
    expect(preview.allowed).toBe(true);
    expect(preview.restoration?.effects.filter((e) => e.effect === 'resumable')).toHaveLength(3);
    const restoreCommand = attendance(state, 'restore', target.playerId, 'Accidental withdrawal');
    const request = envelope(restoreCommand);
    const fact = Decision.parse(decide(state, request)!);
    expect(fact.version).toBe(4);
    state = LiveState.parse(reduceDecision(state, fact));
    expect(state.entrants[0]).toEqual({
      ...target,
      availability: 'available',
      revision: target.revision + 1,
    });
    expect(state.matches.map((m) => [m.id, m.player1Id, m.player2Id])).toEqual(
      original.matches.map((m) => [m.id, m.player1Id, m.player2Id]),
    );
    const resumed = state.matches.filter((m) =>
      [m.player1Id, m.player2Id].includes(target.playerId),
    );
    expect(
      resumed.every(
        (m) =>
          m.status === 'ready' &&
          m.revision === 1 &&
          m.blockedReason === null &&
          m.outcome === null,
      ),
    ).toBe(true);
    expect(decide(state, request)).toBeUndefined();
    expect(() =>
      decide(state, { ...request, command: { ...restoreCommand, reason: 'Different reason' } }),
    ).toThrow(/identifier/);
  });

  it('binds preview freshness to target, reason, current resources and result facts', () => {
    let state = initial();
    state = apply(state, attendance(state, 'withdraw'));
    state = apply(state, attendance(state, 'withdraw', state.entrants[4]!.playerId));
    const restore = attendance(state, 'restore');
    expect(() => apply(state, { ...restore, playerId: state.entrants[4]!.playerId })).toThrow(
      /changed since this preview/,
    );
    expect(() => apply(state, { ...restore, reason: 'Another approved consequence' })).toThrow(
      /changed since this preview/,
    );
    state = apply(state, {
      kind: 'configureDispatch',
      capacity: 3,
      reservedStationIds: [],
      expectedResourceRevision: state.settings.resourceRevision,
    });
    expect(() => apply(state, restore)).toThrow(/changed since this preview/);
    const updated = attendance(state, 'restore');
    state = apply(
      state,
      score(
        state.matches.find(
          (m) =>
            m.player1Id === state.entrants[2]!.playerId &&
            m.player2Id === state.entrants[3]!.playerId,
        )!,
      ),
    );
    expect(() => apply(state, updated)).toThrow(/changed since this preview/);
  });

  it('requires a current withdrawn entrant, an organiser, an open event and a nonempty reason', () => {
    let state = initial();
    expect(
      attendancePreview(state, {
        action: 'restore',
        playerId: state.entrants[0]!.playerId,
        reason: 'Back',
      }).allowed,
    ).toBe(false);
    state = apply(state, attendance(state, 'withdraw'));
    expect(
      attendancePreview(state, {
        action: 'restore',
        playerId: state.entrants[0]!.playerId,
        reason: '  ',
      }).issues,
    ).toContain('Give a reason for restoring this entrant.');
    expect(() => apply(state, attendance(state, 'restore'), false)).toThrow(/organiser/);
    state.lifecycle = 'finalized';
    expect(
      attendancePreview(state, {
        action: 'restore',
        playerId: state.entrants[0]!.playerId,
        reason: 'Back',
      }).allowed,
    ).toBe(false);
    expect(() => apply(state, attendance(state, 'restore'))).toThrow(/sealed/);
  });

  it('retains played and explicit forfeit facts and calls out the separate ruling while resuming only outstanding matches', () => {
    let state = initial();
    state = apply(state, score(state.matches[0]!));
    state = apply(state, attendance(state, 'withdraw'));
    const forfeit = state.matches[1]!;
    state = apply(state, {
      ...score(forfeit),
      outcome: 'forfeit',
      score1: null,
      score2: null,
      winnerId: forfeit.player2Id!,
    });
    const completed = structuredClone(state.matches.filter((m) => m.status === 'complete'));
    const preview = attendancePreview(state, {
      action: 'restore',
      playerId: state.entrants[0]!.playerId,
      reason: 'Returned',
    });
    expect(preview.restoration?.effects.find((m) => m.id === forfeit.id)!.reason).toMatch(
      /separate organiser ruling/,
    );
    state = apply(state, attendance(state, 'restore', state.entrants[0]!.playerId, 'Returned'));
    expect(state.matches.filter((m) => m.status === 'complete')).toEqual(completed);
    expect(state.matches[2]!.status).toBe('ready');
  });

  it('does not reopen an automatic no-contest between two withdrawn entrants', () => {
    let state = initial();
    state = apply(state, attendance(state, 'withdraw'));
    state = apply(state, attendance(state, 'withdraw', state.entrants[1]!.playerId));
    const result = structuredClone(state.matches[0]!);
    expect(result.outcome).toBe('no_contest');
    state = apply(state, attendance(state, 'restore'));
    expect(state.matches[0]).toEqual(result);
    expect(state.entrants[1]!.availability).toBe('withdrawn');
  });

  it('preserves explicit TO holds and their reason', () => {
    const baseline = pureBaseline();
    baseline.settings.dispatchMode = 'shared';
    let state = captureBaseline(baseline);
    state = apply(state, attendance(state, 'withdraw'));
    state = apply(state, {
      kind: 'matchControl',
      matchId: state.matches[0]!.id,
      status: 'blocked',
      stationId: null,
      reason: 'Head referee hold',
      expectedRevision: state.matches[0]!.revision,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    const held = structuredClone(state.matches[0]!);
    state = apply(state, attendance(state, 'restore'));
    expect(state.matches[0]).toEqual(held);
    expect(state.matches[1]!.status).toBe('ready');
  });

  it('retains current pending reports and their revision for normal approval after restoration', () => {
    let state = initial();
    state.settings.scoreReportingMode = 'to_review';
    state = apply(state, score(state.matches[0]!), false);
    state = apply(state, attendance(state, 'withdraw'));
    const pending = structuredClone(state.reports[0]!);
    const revision = state.matches[0]!.revision;
    const preview = attendancePreview(state, {
      action: 'restore',
      playerId: state.entrants[0]!.playerId,
      reason: 'Returned',
    });
    expect(preview.restoration?.effects.find((m) => m.id === state.matches[0]!.id)!.effect).toBe(
      'waiting',
    );
    state = apply(state, attendance(state, 'restore', state.entrants[0]!.playerId, 'Returned'));
    expect(state.reports[0]).toEqual(pending);
    expect(state.matches[0]!.revision).toBe(revision);
    state = apply(state, {
      kind: 'review',
      reportId: pending.id,
      approve: true,
      expectedRevision: revision,
    });
    expect(state.matches[0]!.outcome).toBe('played');
  });

  it('does not silently resume started/live-score matches that were withdrawal-blocked', () => {
    let state = initial();
    const id = state.matches[0]!.id;
    state = apply(state, {
      kind: 'dispatch',
      matchId: id,
      stationId: null,
      callOnly: false,
      expectedRevision: 0,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    state = apply(state, {
      kind: 'progress',
      matchId: id,
      expectedRevision: 0,
      expectedProgressRevision: 0,
      score1: 1,
      score2: 0,
    });
    state = apply(state, attendance(state, 'withdraw'));
    const actual = structuredClone(state.matches[0]!);
    const preview = attendancePreview(state, {
      action: 'restore',
      playerId: state.entrants[0]!.playerId,
      reason: 'Accidentally withdrawn during play',
    });
    expect(preview.restoration?.effects.find((m) => m.id === id)!.effect).toBe('ruling');
    state = apply(
      state,
      attendance(
        state,
        'restore',
        state.entrants[0]!.playerId,
        'Accidentally withdrawn during play',
      ),
    );
    expect(state.matches[0]).toEqual({
      ...actual,
      blockedReason: 'Actual play is retained; an organiser must resume this original pairing.',
    });
    expect(state.matches[0]).toMatchObject({
      started: true,
      status: 'blocked',
      liveScore1: 1,
      liveScore2: 0,
    });
  });

  it('restores a pair without clearing member snoozes or replacing team/member identity', () => {
    const baseline = pureBaseline();
    baseline.version = 2;
    baseline.competitionFormat = 'doubles';
    baseline.structure = 'dual_division';
    Object.assign(baseline.settings, {
      poolOrderPolicy: 'unique_set_wins_v1',
      finalsProgression: 'rolling_pool_places_v1',
      dispatchMode: 'shared',
    });
    for (const entrant of baseline.entrants)
      entrant.memberPlayerIds = [
        stableId(`${entrant.playerId}:one`),
        stableId(`${entrant.playerId}:two`),
      ];
    baseline.entrants[0]!.memberAvailability = {
      [baseline.entrants[0]!.memberPlayerIds![0]!]: 'snoozed',
    };
    let state = captureBaseline(baseline);
    state = apply(state, attendance(state, 'withdraw'));
    const pair = structuredClone(state.entrants[0]!);
    const preview = attendancePreview(state, {
      action: 'restore',
      playerId: pair.playerId,
      reason: 'Pair returned',
    });
    expect(preview.warnings.join(' ')).toContain('team-member availability hold');
    state = apply(state, attendance(state, 'restore', pair.playerId, 'Pair returned'));
    expect(state.entrants[0]).toEqual({
      ...pair,
      availability: 'available',
      revision: pair.revision + 1,
    });
    expect(preview.restoration?.effects.some((m) => m.effect === 'resumable')).toBe(false);
  });

  it('keeps frozen-out entrants excluded after restoration and a later pool win', () => {
    let state = initial();
    state = apply(state, attendance(state, 'withdraw'));
    state = apply(state, { kind: 'drawFinals' });
    const target = state.entrants[0]!.playerId;
    const field = structuredClone(state.pools[0]!.qualifierRoster);
    const preview = attendancePreview(state, {
      action: 'restore',
      playerId: target,
      reason: 'Back after finals reserved',
    });
    expect(preview.restoration?.qualification.status).toBe('frozen_excluded');
    state = apply(state, attendance(state, 'restore', target, 'Back after finals reserved'));
    for (const m of state.matches.filter((m) => m.poolId === state.pools[0]!.id))
      state = apply(state, score(m));
    expect(state.pools[0]!.order![0]).toBe(target);
    expect(state.pools[0]!.qualifierRoster).toEqual(field);
    expect(state.brackets.every((b) => !b.entrantIds.includes(target))).toBe(true);
  });

  it('restores attendance after a finals forfeit without reversing the forfeit or returning the run', () => {
    let state = initial();
    for (const m of state.matches.filter((m) => m.poolId === state.pools[0]!.id))
      state = apply(state, score(m));
    state = apply(state, { kind: 'drawFinals' });
    state = apply(state, attendance(state, 'withdraw'));
    const target = state.entrants[0]!.playerId;
    const completed = structuredClone(
      state.matches.filter((m) => [m.player1Id, m.player2Id].includes(target)),
    );
    expect(completed.some((m) => m.outcome === 'forfeit')).toBe(true);
    const preview = attendancePreview(state, {
      action: 'restore',
      playerId: target,
      reason: 'Returned after forfeit',
    });
    expect(preview.restoration?.qualification.status).toBe('frozen_included');
    expect(preview.warnings.join(' ')).toContain('No new match');
    state = apply(state, attendance(state, 'restore', target, 'Returned after forfeit'));
    expect(state.matches.filter((m) => [m.player1Id, m.player2Id].includes(target))).toEqual(
      completed,
    );
  });

  it('does not revive a knockout route already decided by withdrawal', () => {
    const baseline = pureBaseline();
    baseline.version = 2;
    baseline.competitionFormat = 'singles';
    baseline.structure = 'single_elimination';
    baseline.entrants = baseline.entrants.filter((e) => e.division === 'upper');
    baseline.pools = [];
    const bracketId = stableId('restore-knockout');
    baseline.brackets = [
      {
        id: bracketId,
        division: 'upper',
        stage: 'main',
        entrantIds: baseline.entrants.map((e) => e.playerId),
      },
    ];
    baseline.matches = instantiateElimination(
      buildEliminationTree(
        bracketId,
        baseline.entrants.map((e) => ({ kind: 'entrant', entrantId: e.playerId })),
      ),
      bracketId,
      'upper',
      'main',
    );
    let state = captureBaseline(baseline);
    state = apply(state, attendance(state, 'withdraw'));
    const before = structuredClone(state.matches);
    const preview = attendancePreview(state, {
      action: 'restore',
      playerId: state.entrants[0]!.playerId,
      reason: 'Returned to the venue',
    });
    expect(preview.restoration?.qualification.status).toBe('fixed_draw');
    state = apply(
      state,
      attendance(state, 'restore', state.entrants[0]!.playerId, 'Returned to the venue'),
    );
    expect(state.matches).toEqual(before);
  });

  it('folds immutable V1/V2/V3 journals with exact historical hashes and no version upgrade when restore is unused', () => {
    for (const file of [
      'native-pool-order-v1.json',
      'native-pool-order-v2.json',
      'native-pre-restore-v3.json',
    ]) {
      const journal = JSON.parse(
        readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8'),
      );
      const state = (journal.decisions as unknown[])
        .map((d) => Decision.parse(d))
        .reduce(reduceDecision, captureBaseline(Baseline.parse(journal.baseline)));
      expect(hash(state)).toBe(journal.stateHash);
      expect(decide(state, envelope(score(state.matches[0]!)))!.version).toBe(
        journal.decisions[0].version,
      );
    }
  });
});
