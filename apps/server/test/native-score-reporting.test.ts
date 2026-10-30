import { describe, expect, it } from 'vitest';
import { captureBaseline, decide, reduceDecision, stableId } from '../src/tournament/domain';
import { envelope, pureBaseline, pureState } from './helpers/nativeLiveFixture';
import type {
  CommandEnvelope,
  TournamentCommand,
  TournamentState,
} from '../src/tournament/schemas';

function apply(
  state: TournamentState,
  command: TournamentCommand,
  options: Partial<CommandEnvelope> = {},
) {
  return reduceDecision(state, decide(state, envelope(command, options))!);
}
const score = (match: TournamentState['matches'][number], score1 = 2, score2 = 0) => ({
  kind: 'score' as const,
  matchId: match.id,
  expectedRevision: match.revision,
  score1,
  score2,
  outcome: 'played' as const,
});
const attendee = { actorId: 'attendee', operator: false };

describe('reporting native played results independently of dispatch', () => {
  it.each([false, true])(
    'accepts an unstarted self-running pairing despite a held pool and full capacity (guest=%s)',
    (guest) => {
      const baseline = pureBaseline();
      baseline.settings.scoreReportingMode = 'to_review';
      const upper = baseline.pools[0]!;
      Object.assign(upper, { active: false, selfRun: true, autoAcceptScores: true });
      let state = captureBaseline(baseline);
      const playing = state.matches.find((m) => m.division === 'lower')!;
      state = apply(state, {
        kind: 'dispatch',
        matchId: playing.id,
        expectedRevision: playing.revision,
        expectedResourceRevision: state.settings.resourceRevision,
        stationId: null,
      });
      const target = state.matches.find(
        (m) => m.poolId === upper.id && m.id !== state.matches[0]!.id,
      )!;
      const originalPlaying = structuredClone(state.matches.find((m) => m.id === playing.id));
      const request = envelope(score(target, 0, 2), { ...attendee, guest });
      const event = decide(state, request)!;
      const completed = reduceDecision(state, event);
      expect(completed.matches.find((m) => m.id === target.id)).toMatchObject({
        status: 'complete',
        score1: 0,
        score2: 2,
        winnerId: target.player2Id,
        started: false,
        stationId: null,
      });
      expect(completed.reports).toMatchObject([{ status: 'approved', autoApproved: true }]);
      expect(completed.matches.find((m) => m.id === playing.id)).toEqual(originalPlaying);
      expect(completed.matches.filter((m) => m.status === 'playing')).toHaveLength(1);
      expect(completed.pools[0]!.active).toBe(false);
      expect(decide(completed, request)).toBeUndefined();
      // Replaying stores the actual result without synthesizing a Start or rerunning policy.
      expect(reduceDecision(state, event)).toEqual(completed);
    },
  );

  it('retains TO review when per-pool immediate acceptance is disabled', () => {
    const state = pureState();
    state.settings.scoreReportingMode = 'to_review';
    state.pools[0]!.selfRun = true;
    const target = state.matches[0]!;
    const reported = apply(state, score(target), attendee);
    expect(reported.reports[0]).toMatchObject({ status: 'pending', autoApproved: false });
    expect(reported.matches[0]).toEqual(target);
    expect(reported.settings.resourceRevision).toBe(state.settings.resourceRevision);
  });

  it.each(['to_review', 'approve_unless_disputed'] as const)(
    'uses the pairing revision after unrelated dispatch, preserving confirmations and disputes (%s)',
    (mode) => {
      let state = pureState();
      state.settings.scoreReportingMode = mode;
      state.pools[0]!.selfRun = true;
      state.pools[0]!.autoAcceptScores = true;
      const target = structuredClone(state.matches[0]!);
      const other = state.matches.find((m) => m.division === 'lower')!;
      state = apply(state, {
        kind: 'dispatch',
        matchId: other.id,
        expectedRevision: other.revision,
        expectedResourceRevision: state.settings.resourceRevision,
        stationId: null,
      });
      state = apply(state, score(target), attendee);
      state = apply(state, score(target), { ...attendee, actorId: 'confirming-attendee' });
      state = apply(state, score(target, 0, 2), {
        ...attendee,
        actorId: 'guest:disputing-attendee',
        guest: true,
      });
      expect(state.matches[0]).toMatchObject({
        score1: 2,
        score2: 0,
        winnerId: target.player1Id,
        revision: target.revision + 1,
        started: false,
      });
      expect(state.reports.map((r) => [r.status, r.isDispute])).toEqual([
        ['approved', false],
        ['approved', false],
        ['pending', true],
      ]);
      expect(state.matches.find((m) => m.id === other.id)!.status).toBe('playing');
      state = apply(state, score(state.matches[0]!, 2, 1));
      expect(() => apply(state, score(target), { ...attendee, actorId: 'stale-attendee' })).toThrow(
        /changed/,
      );
    },
  );

  it('rejects an old form after the actual pairing changes', () => {
    const state = pureState();
    const previous = structuredClone(state.matches[0]!);
    state.matches[0]!.player2Id = state.entrants[2]!.playerId;
    state.matches[0]!.revision++;
    expect(() => apply(state, score(previous), attendee)).toThrow(/changed/);
    expect(state.reports).toHaveLength(0);
  });

  it('keeps unresolved opponents, withdrawals, closed events and privileged outcomes protected', () => {
    const state = pureState();
    const target = state.matches[0]!;
    const unresolved = structuredClone(state);
    unresolved.matches[0]!.player2Id = null;
    unresolved.matches[0]!.status = 'blocked';
    expect(() => apply(unresolved, score(target), attendee)).toThrow(/opponents/);
    const withdrawn = structuredClone(state);
    withdrawn.entrants.find((e) => e.playerId === target.player2Id)!.availability = 'withdrawn';
    expect(() => apply(withdrawn, score(target), attendee)).toThrow(/withdrawn/);
    const closed = structuredClone(state);
    closed.lifecycle = 'cancelled';
    expect(() => apply(closed, score(target), attendee)).toThrow(/sealed/);
    const unpublished = structuredClone(state);
    unpublished.settings.published = false;
    expect(() => apply(unpublished, score(target), attendee)).toThrow(/unavailable/);
    expect(() =>
      apply(
        state,
        {
          ...score(target),
          outcome: 'forfeit',
          score1: null,
          score2: null,
          winnerId: target.player1Id!,
        },
        attendee,
      ),
    ).toThrow(/unavailable/);
    expect(() => apply(state, score(target, 1, 1), attendee)).toThrow(/decisive/);
    expect(() =>
      apply(state, { ...score(target), winnerId: stableId('not-a-participant') }, attendee),
    ).toThrow(/disagrees/);
  });
});
