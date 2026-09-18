import { describe, expect, it } from 'vitest';
import { newResultNotices, recentResults, resultHeadline, type ResultMatch } from '../src/lib/broadcastResults';
const game = (id: string, patch: Partial<ResultMatch> = {}): ResultMatch => ({id,division:'upper',stage:'group',poolIndex:0,label:'Pool A',player1Id:'a',player2Id:'b',player1Name:'Alpha',player2Name:'Beta',score1:null,score2:null,winnerId:null,status:'playing',stationId:null,outcome:null,...patch});
const complete = (id: string, patch: Partial<ResultMatch> = {}) => game(id,{status:'complete',score1:2,score2:1,winnerId:'a',outcome:'played',...patch});
describe('broadcast result feed', () => {
  it('does not celebrate old results on mount or repeat unchanged polling', () => {
    const result=complete('one');
    expect(newResultNotices(null,[result])).toEqual([]);
    expect(newResultNotices([result],[{...result,resultUpdatedAt:'2026-09-18T10:00:00Z'}])).toEqual([]);
  });
  it('announces completion and distinguishes corrections without replaying pending matches', () => {
    expect(newResultNotices([game('one')],[complete('one')])).toMatchObject([{matchId:'one',kind:'result'}]);
    expect(newResultNotices([complete('one')],[complete('one',{score1:1,score2:2,winnerId:'b'})])).toMatchObject([{kind:'correction'}]);
    expect(newResultNotices([game('one')],[game('one')])).toEqual([]);
    expect(newResultNotices([complete('one')],[game('one')])).toEqual([]);
  });
  it('orders by actual result time rather than the match label or source order', () => {
    const matches=[complete('first',{resultUpdatedAt:'2026-09-18T10:00:00Z'}),complete('last',{resultUpdatedAt:'2026-09-18T11:00:00Z'}),game('pending')];
    expect(recentResults(matches).map(match=>match.id)).toEqual(['last','first']);
    expect(newResultNotices([],matches).map(notice=>notice.matchId)).toEqual(['first','last']);
  });
  it('uses winner-oriented scores and never celebrates a sentinel forfeit score', () => {
    expect(resultHeadline(complete('one',{score1:1,score2:2,winnerId:'b'}))).toBe('Beta 2–1 Alpha');
    expect(resultHeadline(complete('one',{outcome:'forfeit',score1:99}))).toBe('Alpha advances · Beta forfeits');
    expect(resultHeadline(complete('one',{outcome:'bye',score1:99}))).toBe('Alpha advances · bye');
  });
});
