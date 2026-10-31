import { describe, expect, it } from 'vitest';
import { broadcastOrientation } from '@smashclub/shared';
import { decide, hash, reduceDecision, stableId } from '../src/tournament/domain';
import {
  Decision,
  initialState,
  LiveState,
  type TournamentCommand,
  type TournamentState,
} from '../src/tournament/schemas';
import { envelope, pureState } from './helpers/nativeLiveFixture';

const stage = stableId('broadcast-stage');
function apply(state: TournamentState, command: TournamentCommand) {
  const fact = decide(state, envelope(command))!;
  return LiveState.parse(reduceDecision(state, Decision.parse(fact)));
}
function active(rolling = false) {
  let state = pureState();
  state.stations = [{ id: stage, name: 'Stage', enabled: true, revision: 0 }];
  state.settings.dispatchMode = 'shared';
  state.settings.reservedStationIds = [stage];
  if (rolling) {
    state.settings.poolOrderPolicy = 'unique_set_wins_v1';
    state.settings.finalsProgression = 'rolling_pool_places_v1';
  }
  state = apply(state, {
    kind: 'dispatch',
    matchId: state.matches[0]!.id,
    stationId: stage,
    expectedRevision: 0,
    expectedResourceRevision: 0,
    callOnly: true,
  });
  return state;
}
function swap(
  state: TournamentState,
  swapped = true,
): Extract<TournamentCommand, { kind: 'broadcastSides' }> {
  const match = state.matches.find((item) => item.stationId === stage)!;
  return {
    kind: 'broadcastSides',
    stationId: stage,
    matchId: match.id,
    player1Id: match.player1Id!,
    player2Id: match.player2Id!,
    expectedMatchRevision: match.revision,
    expectedRevision: state.broadcastSides?.[stage]?.revision ?? 0,
    swapped,
  };
}
const competitive = ({
  broadcastSides: _display,
  receipts: _receipts,
  sequence: _sequence,
  ...state
}: TournamentState) => state;

describe('native presentation-only broadcast sides', () => {
  for (const rolling of [false, true])
    it(`records a V4 display preference for a called pairing without changing ${rolling ? 'rolling' : 'original'} competition facts`, () => {
      const before = active(rolling);
      // Imported facts may precede automatic qualification; a display action must not settle them.
      if (rolling)
        for (const match of before.matches.filter((item) => item.division === 'lower'))
          Object.assign(match, {
            status: 'complete',
            score1: 2,
            score2: 0,
            winnerId: match.player1Id,
            outcome: 'played',
            revision: 1,
            completedAt: 1791072000000,
          });
      const fact = decide(before, envelope(swap(before)))!;
      expect(fact.version).toBe(4);
      expect(Object.keys(fact.after)).toEqual(['broadcastSides']);
      const after = reduceDecision(before, Decision.parse(fact));
      expect(competitive(after)).toEqual(competitive(before));
      expect(after.broadcastSides?.[stage]).toMatchObject({
        matchId: before.matches[0]!.id,
        swapped: true,
        revision: 1,
      });
      expect(after.matches[0]!.started).toBe(false);
    });

  it('keeps old state/fact shapes absent rather than backfilling display metadata', () => {
    expect(initialState()).not.toHaveProperty('broadcastSides');
    const before = pureState();
    const fact = decide(
      before,
      envelope(
        {
          kind: 'reporting',
          published: false,
          playerReports: true,
          mode: 'to_review',
          expectedRevision: 0,
        },
        {
          id: stableId('broadcast-old-fact'),
          requestId: 'broadcast-unused-compatibility',
          at: 1791072100000,
        },
      ),
    )!;
    // Golden reporting fact from the pre-broadcast 53cf0d2 implementation.
    expect(hash(fact)).toBe('f0ae27aed12e6e3d297f014a31a26ace499242ffca307ca2d13d9aaf29a94d1a');
    expect(fact.version).toBe(1);
    expect(fact.after).not.toHaveProperty('broadcastSides');
    expect(Decision.parse(fact)).toEqual(fact);
    expect(LiveState.parse(reduceDecision(before, fact))).not.toHaveProperty('broadcastSides');
  });

  it('rejects stale operators, wrong pairings and wrong stations rather than toggling a new match', () => {
    const before = active();
    const command = swap(before);
    const after = apply(before, command);
    expect(() => decide(after, envelope(command))).toThrow(/Broadcast sides changed/);
    expect(() => decide(before, envelope({ ...command, matchId: before.matches[6]!.id }))).toThrow(
      /pairing changed/,
    );
    expect(() =>
      decide(before, envelope({ ...command, stationId: stableId('other-stage') })),
    ).toThrow(/pairing changed/);
    expect(() => decide(before, envelope({ ...command, player1Id: command.player2Id }))).toThrow(
      /pairing changed/,
    );
    expect(() => decide(before, envelope({ ...command, expectedMatchRevision: 1 }))).toThrow(
      /pairing changed/,
    );
    expect(() => decide(before, envelope(command, { operator: false }))).toThrow(/organiser/);
    const paused = { ...before, lifecycle: 'unlocked' as const };
    expect(() => decide(paused, envelope(command))).toThrow(/Relock/);
  });

  it('retries a desired orientation once and rejects request-ID reuse with another intent', () => {
    const before = active();
    const request = envelope(swap(before));
    const first = decide(before, request)!;
    const after = reduceDecision(before, first);
    expect(decide(after, request)).toBeUndefined();
    expect(() =>
      decide(after, { ...request, command: { ...swap(before), swapped: false } }),
    ).toThrow(/identifier/);
    expect(apply(after, swap(after, false)).broadcastSides?.[stage]).toMatchObject({
      swapped: false,
      revision: 2,
    });
  });

  it('retains sides through begin-play and live scoring, resets the next pairing, and folds without re-deciding', () => {
    let state = active();
    const baseline = state;
    const facts = [];
    for (const command of [
      swap(state),
      {
        kind: 'beginPlay' as const,
        matchId: state.matches[0]!.id,
        expectedRevision: 0,
        expectedResourceRevision: state.settings.resourceRevision,
      },
      {
        kind: 'progress' as const,
        matchId: state.matches[0]!.id,
        expectedRevision: 0,
        expectedProgressRevision: 0,
        score1: 1,
        score2: 2,
      },
    ]) {
      const fact = decide(state, envelope(command))!;
      facts.push(fact);
      state = reduceDecision(state, fact);
    }
    expect(state.matches[0]).toMatchObject({
      player1Id: baseline.matches[0]!.player1Id,
      player2Id: baseline.matches[0]!.player2Id,
      liveScore1: 1,
      liveScore2: 2,
      revision: 0,
    });
    expect(broadcastOrientation(state.matches[0]!, state.broadcastSides).swapped).toBe(true);
    expect(
      facts.reduce((current, fact) => reduceDecision(current, Decision.parse(fact)), baseline),
    ).toEqual(state);
    state = apply(state, {
      kind: 'score',
      matchId: state.matches[0]!.id,
      expectedRevision: 0,
      score1: 2,
      score2: 1,
      outcome: 'played',
    });
    expect(broadcastOrientation(state.matches[0]!, state.broadcastSides).swapped).toBe(false);
    const next = state.matches.find((match) => match.status === 'ready')!;
    state = apply(state, {
      kind: 'dispatch',
      matchId: next.id,
      stationId: stage,
      expectedRevision: next.revision,
      expectedResourceRevision: state.settings.resourceRevision,
      callOnly: false,
    });
    expect(
      broadcastOrientation(
        state.matches.find((match) => match.id === next.id)!,
        state.broadcastSides,
      ),
    ).toEqual({ swapped: false, revision: 1 });
    state = apply(state, swap(state));
    expect(
      broadcastOrientation(
        state.matches.find((match) => match.id === next.id)!,
        state.broadcastSides,
      ),
    ).toEqual({ swapped: true, revision: 2 });
  });
});
