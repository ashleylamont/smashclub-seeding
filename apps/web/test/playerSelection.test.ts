import { describe, expect, it } from 'vitest';
import { eventPlayers } from '../src/lib/playerSelection';

describe('device-only player options', () => {
  it('uses stable public IDs, deduplicates repeat matches and excludes unresolved slots', () => {
    expect(eventPlayers([
      { player1Id: 'b', player1Name: 'Alex', player2Id: 'a', player2Name: 'Alex' },
      { player1Id: 'b', player1Name: 'Alex', player2Id: null, player2Name: 'TBD' },
      { player1Id: 'c', player1Name: 'Zoe', player2Id: 'd', player2Name: null },
    ])).toEqual([{ id: 'a', name: 'Alex' }, { id: 'b', name: 'Alex' }, { id: 'd', name: 'Player' }, { id: 'c', name: 'Zoe' }]);
  });
});
