import { finalsToken } from '../src/tournament/operations';
import { attendancePreview } from '../src/tournament/attendance';
import { buildEliminationTree } from '@smashclub/engine';
import { instantiateElimination } from '../src/tournament/structureAdapter';
import { describe, expect, it } from 'vitest';
import { captureBaseline, decide, reduceDecision, stableId } from '../src/tournament/domain';
import {
  dispatchAvailability,
  dispatchDesk,
  dispatchQueue,
  ordinaryUsage,
  publicSettings,
} from '../src/tournament/dispatch';
import {
  Decision,
  LiveState,
  type TournamentCommand,
  type TournamentDecision,
  type TournamentState,
} from '../src/tournament/schemas';
import { envelope, pureBaseline, pureState } from './helpers/nativeLiveFixture';

function apply(state: TournamentState, command: TournamentCommand, operator = true) {
  const event = decide(state, envelope(command, { operator }))!;
  Decision.parse(event);
  return LiveState.parse(reduceDecision(state, event));
}
function setup(state = pureState(), capacity = 1, reservedStationIds: string[] = []) {
  return apply(state, {
    kind: 'configureDispatch',
    capacity,
    reservedStationIds,
    expectedResourceRevision: state.settings.resourceRevision,
  });
}
function call(
  state: TournamentState,
  matchId = state.matches[0]!.id,
  stationId: string | null = null,
  callOnly?: boolean,
) {
  return apply(state, {
    kind: 'dispatch',
    matchId,
    stationId,
    expectedRevision: state.matches.find((m) => m.id === matchId)!.revision,
    expectedResourceRevision: state.settings.resourceRevision,
    callOnly,
  });
}
function release(state: TournamentState, matchId = state.matches[0]!.id) {
  return apply(state, {
    kind: 'matchControl',
    matchId,
    expectedRevision: state.matches.find((m) => m.id === matchId)!.revision,
    expectedResourceRevision: state.settings.resourceRevision,
    stationId: null,
    reason: null,
    status: 'ready',
  });
}

describe('shared native dispatch', () => {
  it('separates ordinary occupancy from named stations and keeps counts through rename/add/remove', () => {
    let state = pureState();
    const named = stableId('Main stage');
    state.stations = [{ id: named, name: 'Main stage', enabled: true, revision: 0 }];
    state = setup(state, 1, [named]);
    state = call(state);
    expect(state.matches[0]!.started).toBe(false);
    const lower = state.matches.find((m) => m.division === 'lower')!;
    expect(dispatchAvailability(state, lower)).toMatchObject({
      canDispatchOrdinary: false,
      canStart: true,
      eligibleStationIds: [named],
    });
    state = call(state, lower.id, named);
    expect(ordinaryUsage(state)).toBe(1);
    expect(state.matches.find((m) => m.id === lower.id)!.started).toBe(true);
    state = apply(state, {
      kind: 'station',
      id: named,
      name: 'Broadcast',
      expectedResourceRevision: state.settings.resourceRevision,
    });
    expect(state.settings.capacity).toBe(1);
    const extra = stableId('extra');
    state = apply(state, {
      kind: 'station',
      id: extra,
      name: 'Side stage',
      expectedResourceRevision: state.settings.resourceRevision,
    });
    expect(state.settings.capacity).toBe(1);
    expect(state.settings.reservedStationIds).toContain(extra);
    state = apply(state, {
      kind: 'station',
      id: extra,
      name: null,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    expect(state.settings.capacity).toBe(1);
    expect(state.settings.reservedStationIds).not.toContain(extra);
  });

  it('retains active matches when capacity drops and refuses further calls until below the cap', () => {
    let state = setup(pureState(), 2);
    state = call(state);
    state = call(state, state.matches[6]!.id);
    const active = structuredClone(state.matches.filter((m) => m.status === 'playing'));
    state = setup(state, 0);
    expect(state.matches.filter((m) => m.status === 'playing')).toEqual(active);
    expect(dispatchDesk(state)).toMatchObject({ capacity: 0, active: 2, overCapacity: 2 });
    state = release(state);
    state = release(state, state.matches[6]!.id);
    expect(() => call(state)).toThrow(/capacity/);
    state = setup(state, 1);
    expect(call(state).matches[0]!.status).toBe('playing');
  });

  it('rechecks capacity, feeder readiness, availability and doubles members rather than trusting suggestions', () => {
    let state = setup();
    const before = state;
    state = call(state);
    expect(() =>
      apply(state, {
        kind: 'dispatch',
        matchId: state.matches[6]!.id,
        stationId: null,
        expectedRevision: 0,
        expectedResourceRevision: before.settings.resourceRevision,
      }),
    ).toThrow(/changed/);
    expect(() => call(state, state.matches[6]!.id)).toThrow(/capacity/);
    state = release(state);
    const member = stableId('pair member');
    state.entrants[0]!.memberPlayerIds = [state.entrants[0]!.playerId, member];
    state.entrants[0]!.memberAvailability = { [member]: 'snoozed' };
    expect(() => call(state)).toThrow(/unavailable/);
    expect(dispatchQueue(state).find((r) => r.matchId === state.matches[0]!.id)?.state).toBe(
      'blocked',
    );
    state.entrants[0]!.memberAvailability = { [member]: 'available' };
    state = call(state);
    // Deliberately share a member in a synthetic opponent to test the dispatch
    // guard independently of roster validation (which also forbids this).
    state.entrants[4]!.memberPlayerIds = [member];
    state = setup(state, 3);
    expect(() => call(state, state.matches[6]!.id)).toThrow(/already called/);
    state = release(state);
    const target = state.matches[6]!;
    target.parent1Id = state.matches[0]!.id;
    expect(() => call(state, target.id)).toThrow(/feeder/);
  });

  it('keeps calls separate from actual play through return, progress and replay', () => {
    let state = setup();
    const baseline = structuredClone(state);
    const events: TournamentDecision[] = [];
    const execute = (command: TournamentCommand) => {
      const event = decide(state, envelope(command))!;
      events.push(event);
      state = reduceDecision(state, event);
    };
    const first = state.matches[0]!;
    execute({
      kind: 'dispatch',
      matchId: first.id,
      stationId: null,
      callLocation: 'Window',
      expectedRevision: 0,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    expect(state.matches[0]).toMatchObject({ started: false, revision: 0, callLocation: 'Window' });
    execute({
      kind: 'matchControl',
      matchId: first.id,
      status: 'ready',
      stationId: null,
      reason: null,
      expectedRevision: 0,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    expect(state.matches[0]).toMatchObject({ started: false, calledAt: null, callLocation: null });
    execute({
      kind: 'dispatch',
      matchId: first.id,
      stationId: null,
      expectedRevision: 0,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    execute({
      kind: 'progress',
      matchId: first.id,
      expectedRevision: 0,
      expectedProgressRevision: 0,
      score1: 1,
      score2: 0,
    });
    execute({
      kind: 'matchControl',
      matchId: first.id,
      status: 'ready',
      stationId: null,
      reason: null,
      expectedRevision: 0,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    expect(state.matches[0]).toMatchObject({ started: true, liveScore1: 1 });
    let replay = baseline;
    for (const event of events) replay = reduceDecision(replay, Decision.parse(event));
    expect(replay).toEqual(state);
    expect(() => apply(state, { kind: 'unlock' })).toThrow(/Play has started/);
  });

  it('converts station banks with active play without changing actual station IDs, scores or holds', () => {
    let state = pureState();
    const ordinary = stableId('ordinary'),
      main = stableId('main');
    state.stations = [
      { id: ordinary, name: 'Window setup', enabled: true, revision: 0 },
      { id: main, name: 'Main stage', enabled: true, revision: 0 },
    ];
    state.settings.capacity = 2;
    state.pools[0]!.stationIds = [ordinary];
    state.pools[1]!.active = false;
    state = call(state, state.matches[0]!.id, ordinary);
    const playing = structuredClone(state.matches[0]!);
    state = setup(state, 1, [main]);
    expect(state.matches[0]).toMatchObject({ ...playing, callLocation: 'Window setup' });
    expect(state.pools[0]!.stationIds).toEqual([]);
    expect(state.pools[1]!.active).toBe(false);
    expect(ordinaryUsage(state)).toBe(1);
    expect(captureBaseline(pureBaseline()).settings.dispatchMode).toBeUndefined();
  });

  it('orders by waiting bands then dependencies, with manual reorder protected independently of resources', () => {
    let state = setup(pureState(), 3);
    const older = state.matches[0]!,
      newer = state.matches[6]!;
    older.readySince = 1000;
    newer.readySince = state.baseline!.capturedAt + 600_000;
    expect(dispatchQueue(state).findIndex((r) => r.matchId === older.id)).toBeLessThan(
      dispatchQueue(state).findIndex((r) => r.matchId === newer.id),
    );
    const beforeResources = state.settings.resourceRevision;
    state = apply(state, {
      kind: 'queueMove',
      matchId: newer.id,
      beforeMatchId: older.id,
      expectedQueueRevision: 0,
    });
    expect(dispatchQueue(state)[0]!.matchId).toBe(newer.id);
    expect(state.settings.resourceRevision).toBe(beforeResources);
    expect(() =>
      apply(state, {
        kind: 'queueMove',
        matchId: older.id,
        beforeMatchId: null,
        expectedQueueRevision: 0,
      }),
    ).toThrow(/Queue order changed/);
    expect(publicSettings(state)).not.toHaveProperty('queueOrder');
    expect(publicSettings(state)).not.toHaveProperty('queueRevision');
  });

  it('holds a reported pairing for score review without consuming capacity and restores readiness on rejection', () => {
    let state = setup();
    state.settings.scoreReportingMode = 'to_review';
    const target = state.matches[0]!;
    state = apply(
      state,
      {
        kind: 'score',
        matchId: target.id,
        expectedRevision: 0,
        score1: 2,
        score2: 0,
        outcome: 'played',
      },
      false,
    );
    expect(ordinaryUsage(state)).toBe(0);
    expect(dispatchAvailability(state, state.matches[0]!).reasons.map((r) => r.code)).toContain(
      'score_review_pending',
    );
    expect(() => call(state)).toThrow(/awaiting TO review/);
    state = apply(state, {
      kind: 'review',
      reportId: state.reports[0]!.id,
      approve: false,
      expectedRevision: 0,
    });
    expect(dispatchAvailability(state, state.matches[0]!).canDispatchOrdinary).toBe(true);
  });

  it('requires an explicit untaken-call return before changing a feeder winner and retains actual play after release', () => {
    const baseline = pureBaseline();
    baseline.version = 2;
    baseline.competitionFormat = 'singles';
    baseline.structure = 'single_elimination';
    baseline.entrants = baseline.entrants.slice(0, 4);
    baseline.pools = [];
    const bracketId = stableId('correction-bracket');
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
    let state = setup(captureBaseline(baseline));
    for (const match of state.matches.filter((m) => m.round === 1))
      state = apply(state, {
        kind: 'score',
        matchId: match.id,
        expectedRevision: 0,
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
    const final = state.matches.find((m) => m.round === 2)!;
    const feeder = state.matches.find((m) => m.id === final.parent1Id)!;
    state = call(state, final.id);
    const originalOpponents = [
      state.matches.find((m) => m.id === final.id)!.player1Id,
      final.player2Id,
    ];
    const correction: TournamentCommand = {
      kind: 'score',
      matchId: feeder.id,
      expectedRevision: feeder.revision,
      score1: 0,
      score2: 2,
      outcome: 'played',
    };
    expect(() => apply(state, correction)).toThrow(/Return an untaken call/);
    expect([state.matches.find((m) => m.id === final.id)!.player1Id, final.player2Id]).toEqual(
      originalOpponents,
    );
    state = release(state, final.id);
    state = apply(state, correction);
    expect(state.matches.find((m) => m.id === final.id)!.player1Id).toBe(feeder.player2Id);
    state = call(state, final.id);
    state = apply(state, {
      kind: 'beginPlay',
      matchId: final.id,
      expectedRevision: state.matches.find((m) => m.id === final.id)!.revision,
      expectedResourceRevision: state.settings.resourceRevision,
    });
    state = release(state, final.id);
    expect(state.matches.find((m) => m.id === final.id)!.started).toBe(true);
    expect(() =>
      apply(state, {
        ...correction,
        expectedRevision: state.matches.find((m) => m.id === feeder.id)!.revision,
        score1: 2,
        score2: 0,
      }),
    ).toThrow(/downstream actual play/);
  });

  it('requires explicit call return before no-show removal, queue reset or draw pause', () => {
    let state = call(setup());
    const entrant = state.matches[0]!.player1Id!;
    const preview = attendancePreview(state, { action: 'no_show', playerId: entrant });
    expect(preview.allowed).toBe(false);
    expect(preview.issues.join(' ')).toMatch(/Return.*untaken call/);
    expect(() => apply(state, { kind: 'resetQueue' })).toThrow(/Return untaken calls/);
    expect(() => apply(state, { kind: 'unlock' })).toThrow(/called/);
    state = release(state);
    expect(attendancePreview(state, { action: 'no_show', playerId: entrant }).allowed).toBe(true);
    expect(apply(state, { kind: 'resetQueue' }).matches.every((match) => !match.started)).toBe(
      true,
    );
    expect(apply(state, { kind: 'unlock' }).lifecycle).toBe('unlocked');
  });

  it('preserves a called finals draw until the TO explicitly returns its untaken call', () => {
    let state = setup();
    for (const match of state.matches)
      state = apply(state, {
        kind: 'score',
        matchId: match.id,
        expectedRevision: match.revision,
        score1: 2,
        score2: 0,
        outcome: 'played',
      });
    for (const pool of state.pools)
      state = apply(state, {
        kind: 'placements',
        poolId: pool.id,
        order: pool.entrantIds,
        expectedRevision: pool.revision,
        matchRevisions: Object.fromEntries(
          state.matches
            .filter((match) => match.poolId === pool.id)
            .map((match) => [match.id, match.revision]),
        ),
      });
    state = apply(state, { kind: 'drawFinals' });
    const final = state.matches.find((match) => match.bracketId && match.status === 'ready')!;
    state = call(state, final.id);
    expect(() => apply(state, { kind: 'resetFinals', revisionToken: finalsToken(state) })).toThrow(
      /Return untaken finals calls/,
    );
    state = release(state, final.id);
    expect(
      apply(state, { kind: 'resetFinals', revisionToken: finalsToken(state) }).brackets,
    ).toEqual([]);
  });

  it('keeps historical reports from holding a new match revision', () => {
    let state = setup();
    state.settings.scoreReportingMode = 'to_review';
    state = apply(
      state,
      {
        kind: 'score',
        matchId: state.matches[0]!.id,
        expectedRevision: 0,
        score1: 2,
        score2: 0,
        outcome: 'played',
      },
      false,
    );
    expect(dispatchAvailability(state, state.matches[0]!).canDispatchOrdinary).toBe(false);
    state.matches[0]!.revision++;
    expect(dispatchAvailability(state, state.matches[0]!).canDispatchOrdinary).toBe(true);
  });

  it('does not let attendees dispatch through the private queue or reserve a pool bank after conversion', () => {
    const state = setup();
    expect(() =>
      apply(
        state,
        {
          kind: 'dispatch',
          matchId: state.matches[0]!.id,
          stationId: null,
          expectedRevision: 0,
          expectedResourceRevision: state.settings.resourceRevision,
        },
        false,
      ),
    ).toThrow(/organiser/);
    expect(() =>
      apply(state, {
        kind: 'poolResources',
        poolId: state.pools[0]!.id,
        active: true,
        stationIds: [stableId('station')],
        selfRun: true,
        autoAcceptScores: true,
        expectedResourceRevision: state.settings.resourceRevision,
      }),
    ).toThrow(/do not reserve/);
  });
});
