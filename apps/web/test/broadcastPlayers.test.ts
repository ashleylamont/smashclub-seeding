import { describe, expect, it } from 'vitest';
import { broadcastOrientation, type BroadcastSidePreferences } from '@smashclub/shared';
import { broadcastPlayers } from '../src/lib/broadcastPlayers';
import type { PoolFlowMatch } from '../src/lib/poolFlow';

const match: PoolFlowMatch = {
  id: 'set',
  stationId: 'stage',
  status: 'playing',
  revision: 2,
  division: 'upper',
  stage: 'group',
  poolIndex: 0,
  label: 'A1',
  player1Id: 'a',
  player2Id: 'b',
  player1Name: 'Alpha',
  player2Name: 'Beta',
  player1Characters: ['mario'],
  player2Characters: ['link'],
  score1: 1,
  score2: 2,
  winnerId: null,
};
const preferences: BroadcastSidePreferences = {
  stage: {
    matchId: 'set',
    player1Id: 'a',
    player2Id: 'b',
    matchRevision: 2,
    swapped: true,
    revision: 3,
  },
};
describe('broadcast display tuple', () => {
  it('moves identities, names, characters and scores together without mutating canonical match facts', () => {
    const before = structuredClone(match);
    const display = broadcastPlayers({ matches: [match], broadcastSides: preferences }, match)!;
    expect(display.left).toEqual({ id: 'b', name: 'Beta', score: 2, characters: ['link'] });
    expect(display.right).toEqual({ id: 'a', name: 'Alpha', score: 1, characters: ['mario'] });
    expect(match).toEqual(before);
    expect(broadcastPlayers({ matches: [match] }, match)!.left.id).toBe('a');
  });
  it('defaults a next, changed, revised or moved pairing to normal while retaining the optimistic metadata revision', () => {
    for (const changed of [
      { ...match, id: 'next-set' },
      { ...match, player1Id: 'c' },
      { ...match, revision: 3 },
      { ...match, status: 'ready' },
    ])
      expect(broadcastOrientation(changed, preferences)).toEqual({ swapped: false, revision: 3 });
    expect(broadcastOrientation({ ...match, stationId: 'other-stage' }, preferences)).toEqual({
      swapped: false,
      revision: 0,
    });
    expect(broadcastPlayers({ matches: [] }, undefined)).toBeUndefined();
  });
});
