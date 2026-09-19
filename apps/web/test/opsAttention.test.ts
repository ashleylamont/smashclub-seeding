import { describe, expect, it } from 'vitest';
import { opsAttention, type AttentionMatch } from '../src/lib/opsAttention';
const match = (id: string, overrides: Partial<AttentionMatch> = {}): AttentionMatch => ({ id, label: id, status: 'ready', revision: 1, player1Id: `${id}-a`, player2Id: `${id}-b`, player1Name: 'One', player2Name: 'Two', blockedReason: null, availability: { canStart: true, reasons: [] }, ...overrides });
const data = (matches: AttentionMatch[]) => ({ plan: { status: 'pools_generated' }, matches, reports: [], stations: [], stationQueues: [] });
describe('TO attention work list', () => {
  it('separates actionable holds from normal bracket dependencies, resolved withdrawals, and later waves', () => {
    const result = opsAttention(data([
      match('withdrawn', { status: 'blocked', blockedReason: 'Player withdrawn: awaiting organiser forfeit decision' }),
      match('changed', { status: 'blocked', blockedReason: 'Imported bracket participants changed. Review players.' }),
      match('held', { status: 'blocked', blockedReason: 'Organiser hold' }),
      match('next-round', { status: 'blocked', player1Id: null, blockedReason: 'Waiting for previous round winners' }),
      match('import', { status: 'blocked', blockedReason: 'Waiting for bracket participants' }),
      match('no-contest', { status: 'blocked', blockedReason: 'Both players withdrawn: no contest; no winner or score recorded' }),
      match('later', { status: 'ready', availability: { canStart: false, reasons: [{ code: 'pool_held', message: 'Later wave' }] } }),
      match('later-decision', { status: 'blocked', blockedReason: 'Player withdrawn: awaiting organiser forfeit decision', availability: { canStart: false, reasons: [{ code: 'pool_held', message: 'Later wave' }] } }),
      match('unknown', { status: 'blocked', player2Id: null }),
      match('busy', { availability: { canStart: false, reasons: [{ code: 'player_busy', message: 'Playing' }] } }),
    ]));
    expect(result.decisions.map(match => match.id)).toEqual(['withdrawn', 'changed', 'held', 'later-decision']);
  });
  it('keeps pending stale reports visible separately, including missing matches, and excludes reviewed reports', () => {
    const result = opsAttention({ ...data([match('current'), match('edited', { revision: 2 })]), reports: [
      { id: 'valid', matchId: 'current', expectedRevision: 1, status: 'pending', score1: 2, score2: 1 },
      { id: 'stale', matchId: 'edited', expectedRevision: 1, status: 'pending', score1: 2, score2: 1 },
      { id: 'missing', matchId: 'gone', expectedRevision: 1, status: 'pending', score1: 2, score2: 1 },
      { id: 'done', matchId: 'current', expectedRevision: 1, status: 'approved', score1: 2, score2: 1 },
    ] });
    expect(result.reports.map(report => [report.id, report.stale])).toEqual([['valid', false], ['stale', true], ['missing', true]]);
  });
  it('only offers known next pairings at genuinely free stations; does not invent work from future projections', () => {
    const result = opsAttention({ ...data([match('next'), match('busy', { availability: { canStart: false, reasons: [] } })]),
      stations: ['free', 'occupied', 'queued-current', 'unavailable', 'empty'].map(id => ({ id, name: id, currentMatchId: id === 'occupied' ? 'playing' : null })),
      stationQueues: [
        { stationId: 'free', currentMatchId: null, nextMatchId: 'next' },
        { stationId: 'occupied', currentMatchId: null, nextMatchId: 'next' },
        { stationId: 'queued-current', currentMatchId: 'playing', nextMatchId: 'next' },
        { stationId: 'unavailable', currentMatchId: null, nextMatchId: 'busy' },
        { stationId: 'empty', currentMatchId: null, nextMatchId: null },
      ],
    });
    expect(result.dispatch.map(item => item.station.id)).toEqual(['free']);
    expect(result.needsStations).toBe(false);
  });
  it('only flags station setup for a live queue and suppresses all action prompts on closed events', () => {
    expect(opsAttention(data([])).needsStations).toBe(false);
    expect(opsAttention(data([match('ready')])).needsStations).toBe(true);
    for (const status of ['complete', 'cancelled']) expect(opsAttention({ ...data([match('ready')]), plan: { status } })).toEqual({ reports: [], decisions: [], dispatch: [], needsStations: false });
  });
});
