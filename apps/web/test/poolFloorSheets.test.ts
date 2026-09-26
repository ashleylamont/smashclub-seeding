import { describe, expect, it } from 'vitest';
import { poolFloorSheets, type FloorSheetData } from '../src/lib/poolFloorSheets';
const fixture = (): FloorSheetData => ({
  plan: { id: 'event', name: 'Tonight', status: 'groups', bracketMode: 'native' }, settings: { published: true }, withdrawals: [{ playerId: 'b' }],
  stations: [{ id: '10', name: 'Station 10' }, { id: '2', name: 'Station 2' }],
  poolSchedules: [{ division: 'upper', poolIndex: 0, active: false, stationIds: ['10', '2'], selfRun: true, autoAcceptScores: true }],
  poolRounds: [{ poolKey: 'upper:0', rounds: [{ round: 1, matchIds: ['m'], restingPlayerIds: ['b'] }] }],
  matches: [{ id: 'm', revision: 0, division: 'upper', stage: 'group', poolIndex: 0, label: 'A1', player1Id: 'a', player1Name: 'Alice', player2Id: 'b', player2Name: 'Bob', status: 'ready', score1: null, score2: null, winnerId: null, stationId: null }],
});
describe('printable pool snapshots', () => {
  it('uses published stable board links, preserves held banks and withdrawn rests, and stays read-only', () => {
    const data = fixture(), before = structuredClone(data);
    const [sheet] = poolFloorSheets(data, 'https://nemesis.example');
    expect(sheet.boardUrl).toBe('https://nemesis.example/live/event?pool=upper%3A0');
    expect(sheet.stations).toEqual(['Station 2', 'Station 10']);
    expect(sheet.status).toContain('Later wave');
    expect(sheet.rounds[0].resting).toEqual(['Bob (withdrawn)']);
    expect(sheet.rounds[0].matches[0].result).toBe('_____ – _____');
    expect(data).toEqual(before);
    data.settings.published = false;
    expect(poolFloorSheets(data, 'https://nemesis.example')[0].boardUrl).toBeNull();
    data.plan.bracketMode = 'challonge';
    expect(poolFloorSheets(data, 'https://nemesis.example')).toEqual([]);
  });
  it('does not print no-contests, byes or forfeits as played scores', () => {
    const data = fixture();
    for (const [outcome, result] of [['forfeit', 'Forfeit · Alice'], ['bye', 'Bye · Alice'], ['played', '2 – 1']]) {
      Object.assign(data.matches[0], { status: 'complete', outcome, winnerId: 'a', score1: 2, score2: 1 });
      const [sheet] = poolFloorSheets(data, 'https://example.com');
      expect(sheet.rounds[0].matches[0].result).toBe(result);
      expect(sheet.status).toBe('Finished');
    }
    Object.assign(data.matches[0], { status: 'blocked', outcome: null, score1: null, score2: null, blockedReason: 'Both players withdrawn: no contest; no winner or score recorded' });
    const [sheet] = poolFloorSheets(data, 'https://example.com');
    expect(sheet.rounds[0].matches[0].result).toBe('No contest');
    expect(sheet.status).toBe('Finished');
  });
});
