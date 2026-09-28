import { describe, expect, it } from 'vitest';
import { eventPlayers } from '../src/lib/playerSelection';

describe('device-only player options', () => {
  it('uses stable public IDs, deduplicates repeat matches and excludes unresolved slots', () => {
    expect(
      eventPlayers([
        { player1Id: 'b', player1Name: 'Alex', player2Id: 'a', player2Name: 'Alex' },
        { player1Id: 'b', player1Name: 'Alex', player2Id: null, player2Name: 'TBD' },
        { player1Id: 'c', player1Name: 'Zoe', player2Id: 'd', player2Name: null },
      ]),
    ).toEqual([
      { id: 'a', name: 'Alex', label: 'Alex (1)' },
      { id: 'b', name: 'Alex', label: 'Alex (2)' },
      { id: 'd', name: 'Player', label: 'Player' },
      { id: 'c', name: 'Zoe', label: 'Zoe' },
    ]);
  });
  it('uses pool context to distinguish players with the same display name', () => {
    expect(
      eventPlayers([
        {
          player1Id: 'a',
          player1Name: 'Tom L',
          player2Id: null,
          player2Name: null,
          division: 'lower',
          stage: 'group',
          poolIndex: 3,
        },
        {
          player1Id: 'b',
          player1Name: 'Tom L',
          player2Id: null,
          player2Name: null,
          division: 'upper',
          stage: 'group',
          poolIndex: 2,
        },
      ]).map((player) => player.label),
    ).toEqual(['Tom L · Lower Pool D', 'Tom L · Upper Pool C']);
  });
});
