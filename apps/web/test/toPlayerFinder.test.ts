import { describe, expect, it } from 'vitest';
import { findEventPlayers, playerEventStatus, type FinderData, type FinderMatch } from '../src/lib/toPlayerFinder';
const match = (id: string, other: string, overrides: Partial<FinderMatch> = {}): FinderMatch => ({ id, label: id, player1Id: 'alex', player1Name: 'Alex', player2Id: other, player2Name: other, stage: 'group', division: 'upper', poolIndex: 0, status: 'ready', availability: { canStart: true, reasons: [], eligibleStationIds: ['one'] }, ...overrides } as FinderMatch);
const data = (matches: FinderMatch[]): FinderData => ({ plan: { status: 'underway' }, entrants: [{ id: 'alex', name: 'Alex' }, { id: 'new', name: 'New entrant' }], matches, stations: [{ id: 'one', name: 'Station 1' }], stationQueues: [{ stationId: 'one', poolKey: 'upper:0', currentMatchId: null, nextMatchId: matches[0]?.id ?? null, upcoming: [], waitingReason: null }], poolSchedules: [], withdrawals: [], reports: [] } as unknown as FinderData);
describe('TO player finder', () => {
  it('keeps duplicate display names separate and includes entrants before matches and historical match participants', () => {
    const view = data([match('a', 'other', { player2Name: 'Alex' })]);
    expect(findEventPlayers(view, ' alex ').map(player => player.id)).toEqual(['alex', 'other']);
    expect(findEventPlayers(view, 'new')).toEqual([{ id: 'new', name: 'New entrant' }]);
    expect(findEventPlayers({ ...view, entrants: [] }, 'Alex')).toHaveLength(2);
    expect(findEventPlayers(view, '')).toEqual([]);
    expect(playerEventStatus(view, 'other').matches).toHaveLength(1);
  });
  it('uses only the authoritative next call, never forecasts or label order', () => {
    const view = data([match('alphabetically-first', 'bea'), match('called', 'chris')]);
    view.stationQueues[0]!.nextMatchId = 'called';
    view.stationQueues[0]!.upcoming = [{ matchId: 'alphabetically-first', round: 2 }];
    expect(playerEventStatus(view, 'alex').next.map(call => call.match.id)).toEqual(['called']);
    view.stationQueues[0]!.nextMatchId = null;
    expect(playerEventStatus(view, 'alex').next).toEqual([]);
  });
  it('suppresses stale next calls while playing or withdrawn and explains held pool banks', () => {
    const view = data([match('next', 'bea'), match('current', 'chris', { status: 'playing', stationId: 'one' })]);
    view.poolSchedules = [{ division: 'upper', poolIndex: 0, active: false, stationIds: ['one'] }] as FinderData['poolSchedules'];
    const status = playerEventStatus(view, 'alex');
    expect(status.playing[0]?.id).toBe('current');
    expect(status.next).toEqual([]);
    expect(status.pools[0]).toMatchObject({ held: true, stationNames: ['Station 1'], remaining: 2 });
    view.matches.pop(); view.withdrawals = [{ playerId: 'alex' }];
    expect(playerEventStatus(view, 'alex')).toMatchObject({ withdrawn: true, next: [] });
  });
  it('does not call players in closed events even when stored projections still have a next match', () => {
    const view = data([match('next', 'bea')]);
    view.plan.status = 'cancelled';
    expect(playerEventStatus(view, 'alex')).toMatchObject({ closed: true, next: [] });
  });
  it('counts double withdrawals as resolved no-contests, without inventing completed matches or later rounds', () => {
    const view = data([match('no-contest', 'bea', { status: 'blocked', blockedReason: 'Both players withdrawn: no contest; no winner or score recorded' }), match('needs-decision', 'chris', { status: 'blocked' }), match('done', 'dean', { status: 'complete' })]);
    view.withdrawals = [{ playerId: 'alex' }, { playerId: 'bea' }];
    expect(playerEventStatus(view, 'alex')).toMatchObject({ completed: 1, noContests: 1, outstanding: [view.matches[1]] });
    view.matches[0]!.blockedReason = 'Imported participants changed';
    expect(playerEventStatus(view, 'alex').noContests).toBe(0);
    expect(playerEventStatus(view, 'alex').outstanding).toHaveLength(2);
    expect(playerEventStatus(view, 'new')).toMatchObject({ matches: [], outstanding: [], playing: [], next: [] });
  });
});
