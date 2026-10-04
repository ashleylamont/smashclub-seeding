import { describe, expect, it } from 'vitest';
import { captureBaseline, decide, reduceDecision, stableId } from '../src/tournament/domain';
import {
  Decision,
  LiveState,
  type TournamentCommand,
  type TournamentState,
} from '../src/tournament/schemas';
import { envelope, pureBaseline, pureState } from './helpers/nativeLiveFixture';

function apply(state: TournamentState, command: TournamentCommand, actor = 'TO', operator = true) {
  const event = decide(state, envelope(command, { actorId: actor, operator }))!;
  Decision.parse(event);
  return LiveState.parse(reduceDecision(state, event));
}
const score = (match: TournamentState['matches'][number], score1 = 2, score2 = 0) => ({
  kind: 'score' as const,
  matchId: match.id,
  expectedRevision: match.revision,
  score1,
  score2,
  outcome: 'played' as const,
});

describe('native tournament decisions', () => {
  it('deduplicates exact actor/request commands and rejects identifier reuse', () => {
    const before = pureState();
    const request = envelope(score(before.matches[0]!));
    const event = decide(before, request)!;
    const after = reduceDecision(before, event);
    expect(decide(after, request)).toBeUndefined();
    expect(() => decide(after, { ...request, command: score(before.matches[1]!) })).toThrow(
      /identifier/,
    );
    expect(before.matches[0]!.outcome).toBeNull();
  });
  it('accepts unrelated and agreeing stale reports, but retains disputes and rejects TO-corrected stale reports', () => {
    const initial = pureState();
    const target = initial.matches[0]!;
    let state = apply(initial, score(initial.matches[6]!));
    state = apply(state, score(target), 'player-a', false);
    state = apply(state, score(target), 'player-b', false);
    state = apply(state, score(target, 0, 2), 'player-c', false);
    expect(state.matches[0]!.revision).toBe(1);
    expect(state.reports.map((r) => [r.status, r.isDispute])).toEqual([
      ['approved', false],
      ['approved', false],
      ['pending', true],
    ]);
    state = apply(state, score(state.matches[0]!, 2, 1));
    expect(() => apply(state, score(target), 'player-d', false)).toThrow(/changed/);
    state = apply(state, {
      kind: 'review',
      reportId: state.reports[2]!.id,
      approve: false,
      expectedRevision: state.matches[0]!.revision,
    });
    expect(state.reports[2]!.status).toBe('rejected');
  });
  it('preserves approval mode and decisive-winner validation', () => {
    const state = pureState();
    state.settings.scoreReportingMode = 'to_review';
    const pending = apply(state, score(state.matches[0]!), 'player', false);
    expect(pending.matches[0]!.status).toBe('ready');
    expect(pending.reports[0]!.status).toBe('pending');
    expect(() => apply(state, score(state.matches[0]!, 1, 1))).toThrow(/decisive/);
    expect(() =>
      apply(state, { ...score(state.matches[0]!), winnerId: state.matches[0]!.player2Id! }),
    ).toThrow(/disagrees/);
  });
  it('rechecks shared capacity and player availability while dispatch leaves score revisions alone', () => {
    let state = pureState();
    const target = state.matches[0]!;
    state = apply(state, {
      kind: 'dispatch',
      matchId: target.id,
      stationId: null,
      expectedRevision: 0,
      expectedResourceRevision: 0,
    });
    expect(state.matches[0]!.revision).toBe(0);
    expect(() =>
      apply(state, {
        kind: 'dispatch',
        matchId: state.matches[6]!.id,
        stationId: null,
        expectedRevision: 0,
        expectedResourceRevision: 1,
      }),
    ).toThrow(/capacity/);
    state = apply(state, score(target), 'player', false);
    expect(state.matches[0]!.status).toBe('complete');
    const entrant = state.entrants[4]!;
    state = apply(state, {
      kind: 'availability',
      playerId: entrant.playerId,
      expectedRevision: 0,
      availability: 'snoozed',
      reason: 'Taking a break',
    });
    expect(() =>
      apply(state, {
        kind: 'dispatch',
        matchId: state.matches[6]!.id,
        stationId: null,
        expectedRevision: 0,
        expectedResourceRevision: state.settings.resourceRevision,
      }),
    ).toThrow(/unavailable/);
  });
  it('records forfeits without games, freezes chosen finals, and replays without rerunning decisions', () => {
    let state = pureState();
    const baseline = pureBaseline();
    const events: ReturnType<typeof decide>[] = [];
    function execute(command: TournamentCommand) {
      const event = decide(state, envelope(command))!;
      events.push(event);
      state = reduceDecision(state, event);
    }
    execute({ kind: 'unlock' });
    execute({ kind: 'relock' });
    const first = state.matches[0]!;
    execute({
      kind: 'score',
      matchId: first.id,
      expectedRevision: 0,
      score1: null,
      score2: null,
      outcome: 'forfeit',
      winnerId: first.player1Id!,
    });
    for (const match of state.matches.filter((m) => m.status === 'ready')) execute(score(match));
    for (const pool of state.pools)
      execute({
        kind: 'placements',
        poolId: pool.id,
        order: pool.entrantIds,
        expectedRevision: pool.revision,
        matchRevisions: Object.fromEntries(
          state.matches.filter((m) => m.poolId === pool.id).map((m) => [m.id, m.revision]),
        ),
      });
    execute({ kind: 'drawFinals' });
    const finals = structuredClone(state.brackets);
    for (const match of state.matches.filter((m) => m.status === 'ready')) execute(score(match));
    execute({ kind: 'finalize' });
    let replayed = captureBaseline(baseline);
    for (const event of events) replayed = reduceDecision(replayed, event!);
    expect(replayed).toEqual(state);
    expect(state.brackets).toEqual(finals);
    expect(state.result!.matches[0]).toMatchObject({
      outcome: 'forfeit',
      score1: null,
      score2: null,
    });
    expect(state.lifecycle).toBe('finalized');
    expect(() => execute(score(state.matches[1]!))).toThrow(/sealed/);
  });
  it('validates immutable baseline identities and unplayed adoption', () => {
    const baseline = pureBaseline();
    baseline.matches[0]!.started = true;
    expect(() => captureBaseline(baseline)).toThrow(/unplayed/);
    const duplicated = pureBaseline();
    duplicated.entrants[1]!.playerId = duplicated.entrants[0]!.playerId;
    expect(() => captureBaseline(duplicated)).toThrow(/Duplicate/);
    expect(stableId('slot')).toBe(stableId('slot'));
  });
  it('versions reporting independently and enforces reserved pool stations', () => {
    let state = pureState();
    const stationId = stableId('reserved');
    state = apply(state, {
      kind: 'resources',
      capacity: 2,
      stations: [{ id: stationId, name: 'Main stage', enabled: true, revision: 0 }],
      expectedResourceRevision: 0,
    });
    state = apply(state, {
      kind: 'poolResources',
      poolId: state.pools[0]!.id,
      active: true,
      stationIds: [stationId],
      selfRun: true,
      autoAcceptScores: true,
      expectedResourceRevision: 1,
    });
    state = apply(state, {
      kind: 'reporting',
      published: true,
      playerReports: true,
      mode: 'to_review',
      expectedRevision: 0,
    });
    expect(state.settings.resourceRevision).toBe(2);
    const lower = state.matches.find((m) => m.division === 'lower')!;
    expect(() =>
      apply(state, {
        kind: 'dispatch',
        matchId: lower.id,
        stationId,
        expectedRevision: lower.revision,
        expectedResourceRevision: 2,
      }),
    ).toThrow(/another unfinished pool/);
    const upper = state.matches[0]!;
    state = apply(state, {
      kind: 'dispatch',
      matchId: upper.id,
      stationId,
      expectedRevision: upper.revision,
      expectedResourceRevision: 2,
    });
    state = apply(state, score(upper), 'self-running-player', false);
    expect(state.reports[0]!.autoApproved).toBe(true);
    expect(state.matches[0]!.status).toBe('complete');
    expect(() =>
      apply(state, {
        kind: 'reporting',
        published: false,
        playerReports: false,
        mode: 'to_review',
        expectedRevision: 0,
      }),
    ).toThrow(/settings changed/);
  });
});
