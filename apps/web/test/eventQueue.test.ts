import { describe, expect, it } from 'vitest';
import { availableMatches, poolStandings, type QueueMatch } from '../src/lib/eventQueue';
const match = (id: string, p1: string, p2: string, patch: Partial<QueueMatch> = {}): QueueMatch => ({ id, player1Id: p1, player2Id: p2, player1Name: p1, player2Name: p2, status: 'ready', division: 'upper', stage: 'group', poolIndex: 0, score1: null, score2: null, winnerId: null, ...patch });
describe('event queue', () => {
  it('does not call busy players, blocked matches or unresolved opponents', () => {
    const rows = [match('live','a','b',{status:'playing'}),match('busy','a','c'),match('free','c','d'),match('hold','e','f',{status:'blocked'}),match('unknown','g','h',{player2Id:null})];
    expect(availableMatches(rows).map(m => m.id)).toEqual(['free']);
  });
  it('prioritises players who have completed fewer sets without changing source order', () => {
    const rows = [match('old','a','b',{status:'complete',winnerId:'a'}), match('later','a','c'),match('first','d','e')];
    expect(availableMatches(rows).map(m => m.id)).toEqual(['first','later']);
    expect(rows[1]!.id).toBe('later');
  });
  it('separates pools and counts forfeits without fabricated game differential', () => {
    const rows = [match('one','a','b',{status:'complete',score1:2,score2:1,winnerId:'a',outcome:'played'}),match('two','a','c',{status:'complete',score1:99,score2:0,winnerId:'a',outcome:'forfeit'}),match('three','b','c'),match('four','d','e',{poolIndex:1})];
    const pools = poolStandings(rows);
    expect(pools[0]).toMatchObject({complete:2,total:3});
    expect(pools[0]!.players.find(p => p.id === 'a')).toMatchObject({wins:2,losses:0,differential:1,remaining:0});
    expect(pools[0]!.players.find(p => p.id === 'b')).toMatchObject({wins:0,losses:1,remaining:1});
    expect(pools[1]!.players).toHaveLength(2);
  });
});
