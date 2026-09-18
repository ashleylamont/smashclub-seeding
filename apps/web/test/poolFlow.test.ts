import { describe, expect, it } from 'vitest';
import { matchesPool, queueScoringIds, stationPreview, type PoolFlowMatch, type StationQueue } from '../src/lib/poolFlow';
const match = (id: string, status = 'ready'): PoolFlowMatch => ({ id, status, revision: 0, division: 'upper', stage: 'group', poolIndex: 0, label: id, player1Id: `${id}a`, player2Id: `${id}b`, player1Name: 'A', player2Name: 'B', stationId: null, score1: null, score2: null, winnerId: null });
describe('pool display queue semantics', () => {
  it('keeps provisional upcoming visible on occupied stations without claiming it is startable', () => {
    const queue: StationQueue = { stationId: 'one', poolKey: 'upper:0', currentMatchId: 'current', nextMatchId: null, upcoming: [{ matchId: 'later', round: 2 }], waitingReason: null };
    const matches = [match('current', 'playing'), match('later')];
    expect(stationPreview(queue, matches).map(item => item.id)).toEqual(['later']);
    expect([...queueScoringIds({ matches, stationQueues: [queue] })]).toEqual(['current']);
  });
  it('deduplicates next/upcoming and filters stale complete entries', () => {
    const queue: StationQueue = { stationId: 'one', poolKey: 'upper:0', currentMatchId: null, nextMatchId: 'next', upcoming: [{ matchId: 'next', round: 1 }, { matchId: 'done', round: 1 }], waitingReason: null };
    expect(stationPreview(queue, [match('next'), match('done', 'complete')]).map(item => item.id)).toEqual(['next']);
    expect(matchesPool(match('next'), 'lower:0')).toBe(false);
    expect(matchesPool(match('next'), 'upper:0')).toBe(true);
  });
});
