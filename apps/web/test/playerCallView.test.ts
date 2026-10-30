import { describe, expect, it } from 'vitest';
import { matchStation, matchStatus } from '../src/lib/playerMatchView';
import type { PoolFlowData, PoolFlowMatch } from '../src/lib/poolFlow';

const match: PoolFlowMatch = {
  id: 'set',
  revision: 0,
  division: 'upper',
  stage: 'group',
  poolIndex: 0,
  label: 'A1',
  player1Id: 'a',
  player2Id: 'b',
  player1Name: 'A',
  player2Name: 'B',
  score1: null,
  score2: null,
  winnerId: null,
  stationId: null,
  status: 'playing',
  called: true,
  callLocation: 'Window setup',
};
const data: PoolFlowData = {
  plan: { id: 'night', status: 'underway', bracketMode: 'native' },
  matches: [match],
  stations: [{ id: 'main', name: 'Main stage' }],
  poolSchedules: [],
  stationQueues: [],
  sharedDispatch: { capacity: 1, active: 1, overCapacity: 0 },
};

describe('personal shared match call presentation', () => {
  it('distinguishes an ordinary call/location from actual play at a named station', () => {
    expect(matchStatus(data, match)).toBe('Called');
    expect(matchStation(data, match)).toEqual({ name: 'Window setup', call: 'Called' });
    const playing = { ...match, called: false, stationId: 'main' };
    expect(matchStatus(data, playing)).toBe('Playing now');
    expect(matchStation(data, playing)).toEqual({ name: 'Main stage', call: 'Playing now' });
    expect(matchStation(data, { ...match, callLocation: null }).name).toBe(
      'Any available ordinary setup',
    );
  });
  it('describes uncalled shared pairings without inventing a station or exposing a stale location', () => {
    const ready = { ...match, status: 'ready', called: false };
    expect(matchStatus(data, ready)).toBe('Awaiting TO call');
    expect(matchStation(data, ready)).toEqual({ name: null, call: null });
    expect(matchStatus({ ...data, sharedDispatch: null }, ready)).toBe('Waiting for station');
  });
});
