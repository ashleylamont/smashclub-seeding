import { describe, expect, it } from 'vitest';
import { broadcastQueue, liveSections, overlayGeometry, type LiveMatch } from '../src/lib/eventDisplay';

describe('spectator event board', () => {
  it('keeps blocked matches out of the ready queue and counts only confirmed results', () => {
    const matches = ['ready', 'blocked', 'playing', 'complete'].map((status, index) => ({ id: String(index), status, division: 'upper', stage: 'group', poolIndex: 0, label: `Match ${index}`, player1Id: `a${index}`, player2Id: `b${index}`, player1Name: `A${index}`, player2Name: `B${index}`, score1: null, score2: null, winnerId: null, stationId: null }) satisfies LiveMatch);
    const sections = liveSections(matches);
    expect(sections.ready.map(m => m.id)).toEqual(['0']);
    expect(sections.playing.map(m => m.id)).toEqual(['2']);
    expect(sections.complete.map(m => m.id)).toEqual(['3']);
    expect(sections.total).toBe(4);
  });
  it('bounds malformed browser-source geometry while retaining a transparent centre', () => {
    expect(overlayGeometry('')).toEqual({ width: 78, height: 78 });
    expect(overlayGeometry('?captureWidth=75&captureHeight=70')).toEqual({ width: 75, height: 70 });
    expect(overlayGeometry('?captureWidth=Infinity&captureHeight=no')).toEqual({ width: 78, height: 78 });
    expect(overlayGeometry('?captureWidth=-1&captureHeight=999')).toEqual({ width: 35, height: 78 });
  });
});

it('does not put the same challenger into several broadcast on-deck slots', () => {
  const matches = [['a', 'b'], ['a', 'c'], ['c', 'd'], ['e', 'f']].map(([player1Id, player2Id], index) => ({ id: String(index), player1Id, player2Id }) as LiveMatch);
  expect(broadcastQueue(matches).map(match => match.id)).toEqual(['0', '2', '3']);
  expect(overlayGeometry('?captureWidth=100&captureHeight=100')).toEqual({ width: 78, height: 78 });
});

it('respects server scheduling holds even when both players are idle', () => {
  const match: LiveMatch = { id: 'held', status: 'ready', division: 'upper', stage: 'group', poolIndex: 0, label: 'A1', player1Id: 'a', player2Id: 'b', player1Name: 'A', player2Name: 'B', score1: null, score2: null, winnerId: null, stationId: null, availability: { canStart: false, reasons: [{ code: 'pool_held', message: 'Pool is on hold' }], eligibleStationIds: [] } };
  expect(liveSections([match]).ready).toEqual([]);
  expect(liveSections([{ ...match, availability: { ...match.availability!, canStart: true } }]).ready).toHaveLength(1);
});
