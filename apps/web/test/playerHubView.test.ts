import { describe, expect, it } from 'vitest';
import {
  playerBracketPath,
  playerMatchProgress,
  resolveHubPlayer,
  playerHubView,
  recentPlayerMatches,
} from '../src/lib/playerHubView';
import type { PoolFlowMatch } from '../src/lib/poolFlow';

const match = (id: string, changes: Partial<PoolFlowMatch> = {}): PoolFlowMatch => ({
  id,
  revision: 0,
  label: id,
  division: 'upper',
  stage: 'group',
  poolIndex: 0,
  player1Id: 'a',
  player2Id: 'b',
  player1Name: 'A',
  player2Name: 'B',
  score1: null,
  score2: null,
  winnerId: null,
  stationId: null,
  status: 'ready',
  ...changes,
});
const bracket = (id: string, entrantIds = ['a', 'b']) => ({
  id,
  entrantIds,
  division: 'upper',
  stage: 'main',
  complete: false,
  winnerId: null,
  standings: [],
});
const event = (matches: PoolFlowMatch[]) => ({
  plan: { id: 'night', status: 'underway', bracketMode: 'native', structure: 'dual_division' },
  matches,
  stations: [],
  poolSchedules: [],
  nativeBrackets: [bracket('upper'), bracket('lower', ['c', 'd'])],
  brackets: [{ division: 'upper', stage: 'main', slug: 'stale-external-draw' }],
});

describe('focused player board and stage order', () => {
  it('keeps their entire pool standings and relevant draw, with Everyone restoring all data', () => {
    const data = event([
      match('own'),
      match('pool-peer', { player1Id: 'x', player2Id: 'y' }),
      match('other-pool', { poolIndex: 1, player1Id: 'c', player2Id: 'd' }),
      match('own-final', { stage: 'main', poolIndex: null, nativeBracketId: 'upper' }),
    ]);
    const focused = playerHubView(data, 'a');
    expect(focused.pools.map((item) => item.id)).toEqual(['own', 'pool-peer']);
    expect(focused.nativeBrackets.map((item) => item.id)).toEqual(['upper']);
    expect(focused.linked).toEqual([]);
    const everyone = playerHubView(data);
    expect(everyone.pools).toHaveLength(3);
    expect(everyone.nativeBrackets).toHaveLength(2);
  });

  it('promotes their resolved pool to a published bracket while other divisions remain active', () => {
    const data = event([
      match('own-pool', { status: 'complete' }),
      match('lower-pool', { division: 'lower', player1Id: 'c', player2Id: 'd' }),
      match('final', {
        stage: 'main',
        poolIndex: null,
        nativeBracketId: 'upper',
        status: 'blocked',
      }),
    ]);
    const focused = playerHubView(data, 'a');
    expect(focused.sections[0]).toBe('brackets');
    expect(focused.resolvedPools).toBe(true);
    expect(focused.activePools).toBe(true);
    expect(playerHubView(data).resolvedPools).toBe(false);
    expect(playerHubView(data).sections[0]).toBe('pools');
  });

  it('does not treat a player finishing their own pairings as their whole pool finishing', () => {
    const data = event([
      match('own', { status: 'complete' }),
      match('peer', { player1Id: 'x', player2Id: 'y' }),
    ]);
    expect(playerHubView(data, 'a').resolvedPools).toBe(false);
    expect(playerHubView(data, 'a').sections[0]).toBe('pools');
  });

  it('shows a mixed-stage event with active finals first while retaining active pools', () => {
    const data = event([
      match('pool'),
      match('final', {
        stage: 'main',
        poolIndex: null,
        nativeBracketId: 'upper',
        status: 'playing',
      }),
    ]);
    const view = playerHubView(data);
    expect(view.sections).toEqual(['brackets', 'pools', 'results']);
    expect(view.activePools && view.activeBrackets).toBe(true);
  });

  for (const status of ['complete', 'cancelled'])
    it(`${status} keeps brackets and history ahead of pools without treating leftover pairings as active`, () => {
      const data = event([match('remaining')]);
      data.plan.status = status;
      const view = playerHubView(data, 'a');
      expect(view.sections).toEqual(['brackets', 'results', 'pools']);
      expect(view.activePools || view.activeBrackets).toBe(false);
    });

  it('supports group-only results and knockout draws without inferring an unpublished bracket', () => {
    const groups = event([match('pool', { status: 'complete' })]);
    groups.plan.structure = 'round_robin';
    groups.nativeBrackets = [];
    expect(playerHubView(groups, 'a').sections[0]).toBe('results');
    const pending = playerHubView(
      { ...groups, plan: { ...groups.plan, structure: 'pools_finals' } },
      'a',
    );
    expect(pending.nativeBrackets).toEqual([]);
    expect(pending.linked).toEqual([]);
    expect(pending.sections).toEqual(['results', 'brackets', 'pools']);
    const knockout = event([
      match('final', { stage: 'main', poolIndex: null, nativeBracketId: 'upper' }),
    ]);
    knockout.plan.structure = 'single_elimination';
    expect(playerHubView(knockout, 'a').sections[0]).toBe('brackets');
    expect(playerHubView(knockout, 'a').pools).toEqual([]);
  });

  it('resolves doubles members to their team pool, bracket and standings identity', () => {
    const data = event([
      match('team-pool', { player1Id: 'team', player1MemberIds: ['member', 'partner'] }),
      match('team-final', {
        player1Id: 'team',
        player1MemberIds: ['member', 'partner'],
        stage: 'main',
        poolIndex: null,
        nativeBracketId: 'teams',
        status: 'complete',
      }),
    ]);
    data.nativeBrackets = [bracket('teams', ['team', 'opponents'])];
    const view = playerHubView(data, 'member', 'upper:0');
    expect(view.identities.has('team')).toBe(true);
    expect(view.pools).toHaveLength(1);
    expect(view.nativeBrackets).toHaveLength(1);
    expect(view.results.map((item) => item.id)).toEqual(['team-final']);
  });
});

describe('compact authoritative path and match history', () => {
  it('follows conditional winner and loser feeds without including unrelated pairings', () => {
    const games = [
      match('semi', { stage: 'main' }),
      match('other-semi', { stage: 'main', player1Id: 'c', player2Id: 'd' }),
      match('final', {
        stage: 'main',
        status: 'blocked',
        player1Id: null,
        player2Id: null,
        parent1MatchId: 'semi',
        parent2MatchId: 'other-semi',
      }),
      match('consolation', {
        stage: 'consolation',
        status: 'blocked',
        player1Id: null,
        player2Id: null,
        parent1MatchId: 'semi',
        parent1Outcome: 'loser',
      }),
    ];
    expect(playerBracketPath(games, 'a').map((item) => item.id)).toEqual([
      'semi',
      'final',
      'consolation',
    ]);
    games[0] = { ...games[0]!, status: 'complete', winnerId: 'b' };
    expect(playerBracketPath(games, 'a').map((item) => item.id)).toEqual(['semi', 'consolation']);
    expect(playerBracketPath(games, 'c').map((item) => item.id)).toEqual(['other-semi', 'final']);
  });

  it('does not advance a withdrawn or no-contest entrant through a completed feeder', () => {
    const games = [
      match('no-contest', { status: 'complete', winnerId: null, outcome: 'no_contest' }),
      match('later', {
        status: 'blocked',
        player1Id: null,
        player2Id: null,
        parent1MatchId: 'no-contest',
      }),
    ];
    expect(playerBracketPath(games, 'a').map((item) => item.id)).toEqual(['no-contest']);
  });

  it('keeps upcoming matches, recent results and every own report while exposing older history separately', () => {
    const matches = [
      match('live', { status: 'playing' }),
      ...Array.from({ length: 6 }, (_, i) => match(`result-${i}`, { status: 'complete' })),
    ];
    expect(
      recentPlayerMatches(matches, 3, new Set(['result-0', 'result-1'])).map((item) => item.id),
    ).toEqual(['live', 'result-0', 'result-1', 'result-3', 'result-4', 'result-5']);
  });
  it('uses confirmed result timestamps when publication order differs from recency', () => {
    const matches = [
      { ...match('newest', { status: 'complete' }), resultUpdatedAt: '2026-10-04T03:00:00Z' },
      { ...match('oldest', { status: 'complete' }), resultUpdatedAt: '2026-10-04T01:00:00Z' },
      { ...match('middle', { status: 'complete' }), resultUpdatedAt: '2026-10-04T02:00:00Z' },
    ];
    expect(recentPlayerMatches(matches, 1).map((item) => item.id)).toEqual(['newest']);
  });

  it('restores a stored doubles member through their public team without treating missing players as selected', () => {
    expect(
      resolveHubPlayer([{ id: 'team' }], 'member', [{ id: 'team', memberPlayerIds: ['member'] }]),
    ).toBe('team');
    expect(resolveHubPlayer([{ id: 'team' }], 'missing')).toBe('');
    expect(resolveHubPlayer([{ id: 'team' }], '')).toBe('');
  });

  it('distinguishes waiting pairings from actionable calls and removes next actions for closed events', () => {
    const matches = [match('waiting', { status: 'blocked' }), match('call', { status: 'playing' })];
    expect(playerMatchProgress(matches, false).nextMatch?.id).toBe('call');
    expect(playerMatchProgress(matches.slice(0, 1), false).waitingMatch?.id).toBe('waiting');
    expect(playerMatchProgress(matches, true)).toEqual({
      completed: 0,
      nextMatch: undefined,
      waitingMatch: undefined,
    });
  });
});
