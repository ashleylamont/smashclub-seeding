import { describe, expect, it } from 'vitest';
import { playerConsequences, playerJourney } from '../src/lib/playerJourney';
import type { PoolFlowMatch } from '../src/lib/poolFlow';
import type { NativeBracketView } from '../src/components/EventNightBoard';

const match = (id: string, changes: Partial<PoolFlowMatch> = {}): PoolFlowMatch => ({
  id,
  label: id,
  revision: 0,
  division: 'upper',
  stage: 'main',
  poolIndex: null,
  nativeBracketId: 'main',
  player1Id: 'a',
  player2Id: 'b',
  player1Name: 'Alex',
  player2Name: 'Bea',
  score1: null,
  score2: null,
  winnerId: null,
  status: 'ready',
  stationId: null,
  ...changes,
});
const bracket = (changes: Partial<NativeBracketView> = {}): NativeBracketView => ({
  id: 'main',
  division: 'upper',
  stage: 'main',
  entrantIds: ['a', 'b'],
  complete: false,
  winnerId: null,
  standings: [],
  ...changes,
});
const data = (matches: PoolFlowMatch[], brackets: NativeBracketView[] = [bracket()]) => ({
  plan: { id: 'night', status: 'underway', bracketMode: 'native', structure: 'pools_finals' },
  matches,
  nativeBrackets: brackets,
  stations: [],
  poolSchedules: [],
  withdrawals: [] as { playerId: string }[],
});
const loss = (id = 'semi', changes: Partial<PoolFlowMatch> = {}) =>
  match(id, {
    status: 'complete',
    outcome: 'played',
    score1: 0,
    score2: 2,
    winnerId: 'b',
    ...changes,
  });

describe('personal journey from published facts', () => {
  it('finishes an eliminated single-elimination run while the event and final continue', () => {
    const snapshot = data([
      loss(),
      match('final', { player1Id: 'b', player2Id: 'c', status: 'playing', parent1MatchId: 'semi' }),
    ]);
    expect(playerJourney(snapshot, 'a')).toMatchObject({ state: 'bracket_finished' });
    expect(playerJourney(snapshot, 'a').summary).toContain('while the event continues');
    expect(playerJourney(snapshot, 'b').state).toBe('active');
  });
  it('follows a double-elimination loser feed and an automatic bye without declaring an early exit', () => {
    const lower = match('Losers round 1', {
      player1Id: null,
      player2Id: null,
      status: 'blocked',
      parent1MatchId: 'semi',
      parent1Outcome: 'loser',
    });
    const snapshot = data([loss(), lower]);
    snapshot.plan.structure = 'double_elimination';
    expect(playerJourney(snapshot, 'a')).toMatchObject({ state: 'awaiting_opponent' });
    expect(playerJourney(snapshot, 'a').summary).toContain('Losers round 1');
    const lowerWin = match('lower-win', {
      status: 'complete',
      outcome: 'played',
      winnerId: 'a',
      score1: 2,
      score2: 0,
      parent1MatchId: 'semi',
      parent1Outcome: 'loser',
    });
    const secondLoss = loss('lower-final', { parent1MatchId: 'lower-win' });
    expect(playerJourney(data([loss(), lowerWin, secondLoss]), 'a').state).toBe('bracket_finished');
    const bye = match('bye', {
      status: 'complete',
      outcome: 'bye',
      winnerId: 'a',
      player2Id: null,
    });
    expect(
      playerJourney(data([bye, { ...lower, parent1MatchId: 'bye', parent1Outcome: 'winner' }]), 'a')
        .state,
    ).toBe('awaiting_opponent');
  });
  it('does not treat an earlier loss followed by an unconfirmed win as elimination or a championship', () => {
    const snapshot = data([
      loss(),
      match('later-win', {
        status: 'complete',
        outcome: 'played',
        winnerId: 'a',
        score1: 2,
        score2: 0,
      }),
    ]);
    expect(playerJourney(snapshot, 'a').state).toBe('awaiting_stage');
    expect(
      playerJourney(
        data([match('no-contest', { status: 'complete', winnerId: null, outcome: 'no_contest' })]),
        'a',
      ).state,
    ).toBe('awaiting_stage');
  });
  it('only names a bracket winner once the public bracket confirms it', () => {
    const final = match('final', {
      status: 'complete',
      outcome: 'played',
      winnerId: 'a',
      score1: 2,
      score2: 0,
    });
    expect(playerJourney(data([final]), 'a').state).toBe('awaiting_stage');
    expect(
      playerJourney(data([final], [bracket({ complete: true, winnerId: 'a' })]), 'a'),
    ).toMatchObject({ state: 'winner' });
  });
  it('keeps completed pools awaiting qualification rather than declaring elimination or a finished event', () => {
    const pool = loss('pool', { stage: 'group', poolIndex: 0, nativeBracketId: null });
    const pending = {
      poolId: 'pool-a',
      poolIndex: 0,
      division: 'upper',
      place: 1,
      status: 'pending' as const,
      entrantId: null,
      eligibleEntrantIds: ['a', 'b'],
    };
    expect(playerJourney(data([pool], []), 'a').state).toBe('awaiting_stage');
    const snapshot = data([pool], [bracket({ entrantIds: [], qualifierSlots: [pending] })]);
    expect(playerJourney(snapshot, 'a').state).toBe('qualification');
    snapshot.nativeBrackets[0]!.qualifierSlots![0]!.status = 'review_pending';
    expect(playerJourney(snapshot, 'a').summary).toContain('under review');
  });
  it('distinguishes a completed round-robin schedule and an entrant outside the frozen finals field', () => {
    const pool = loss('pool', { stage: 'group', poolIndex: 0, nativeBracketId: null });
    const groups = data([pool], []);
    groups.plan.structure = 'round_robin';
    expect(playerJourney(groups, 'a').state).toBe('pool_finished');
    const frozen = {
      poolId: 'pool-a',
      poolIndex: 0,
      division: 'upper',
      place: 1,
      status: 'resolved' as const,
      entrantId: 'b',
      eligibleEntrantIds: ['a', 'b'],
    };
    const excluded = data([pool], [bracket({ entrantIds: ['b'], qualifierSlots: [frozen] })]);
    expect(playerJourney(excluded, 'a').summary).toContain('outside the published finals field');
    excluded.nativeBrackets[0]!.qualifierSlots![0]!.eligibleEntrantIds = ['b'];
    excluded.nativeBrackets[0]!.qualifierSlots![0]!.status = 'pending';
    expect(playerJourney(excluded, 'a').summary).toContain('outside the published finals field');
  });
  it('keeps a restored eliminated entrant finished and a withdrawn entrant clearly withdrawn', () => {
    const snapshot = data([
      loss('recorded-forfeit', { outcome: 'forfeit', score1: null, score2: null }),
    ]);
    snapshot.withdrawals = [{ playerId: 'a' }];
    expect(playerJourney(snapshot, 'a').state).toBe('withdrawn');
    snapshot.withdrawals = [];
    expect(playerJourney(snapshot, 'a').state).toBe('bracket_finished');
  });
  it('retains concrete calls/location and resolves doubles members without publishing queue promises', () => {
    const current = match('called', {
      status: 'playing',
      called: true,
      callLocation: 'Window setup',
      player1Id: 'team',
      player1MemberIds: ['member', 'partner'],
    });
    const snapshot = {
      ...data([current], [bracket({ entrantIds: ['team', 'b'] })]),
      sharedDispatch: { capacity: 2, active: 1, overCapacity: 0 },
      entrants: [{ id: 'team', name: 'Team', memberPlayerIds: ['member', 'partner'] }],
    };
    expect(playerJourney(snapshot, 'member').summary).toBe('Called · called · Window setup');
  });
  it('explains only actual winner/loser edges and marks a reset as conditional', () => {
    const current = match('semi');
    const final = match('Championship final', {
      player1Id: null,
      player2Id: null,
      status: 'blocked',
      parent1MatchId: 'semi',
    });
    const lower = match('Losers round 1', {
      player1Id: null,
      player2Id: null,
      status: 'blocked',
      parent2MatchId: 'semi',
      parent2Outcome: 'loser',
    });
    expect(playerConsequences([current, final, lower], current)).toEqual([
      { outcome: 'Win', label: 'Championship final' },
      { outcome: 'Loss', label: 'Losers round 1' },
    ]);
    expect(
      playerConsequences(
        [current, { ...final, label: 'Reset final (if needed)', bracketLane: 'reset' }],
        current,
      ),
    ).toEqual([{ outcome: 'Conditional', label: 'Reset final (if needed)' }]);
    expect(playerConsequences([current], { ...current, stage: 'group' })).toEqual([]);
  });
  it('keeps a disputed finished result uncertain and a closed event closed despite leftover matches', () => {
    const review = { ...loss(), pendingDisputeCount: 1 };
    expect(playerJourney(data([review]), 'a').state).toBe('review');
    const closed = data([match('leftover')]);
    closed.plan.status = 'cancelled';
    expect(playerJourney(closed, 'a').state).toBe('closed');
  });
});
