import { describe, expect, it } from 'vitest';
import { isBracketAbandoned, isBracketFinalised, isBracketOver } from '../src/brackets';

/**
 * Challonge's `underway` is sticky, so "is this bracket still running" cannot
 * be answered from upstream state alone. How long ago the night was is the
 * missing evidence — and the only one that ever arrives for a bracket nobody
 * closed.
 */

const NOW = Date.parse('2026-08-02T00:00:00.000Z');
const daysAgo = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

describe('isBracketAbandoned', () => {
  it('is false for a bracket still being played tonight', () => {
    expect(isBracketAbandoned({ challongeState: 'underway', eventDate: daysAgo(0) }, NOW)).toBe(false);
  });

  it('is false the morning after — results are often reported late', () => {
    expect(isBracketAbandoned({ challongeState: 'underway', eventDate: daysAgo(1) }, NOW)).toBe(false);
  });

  it('is true for a bracket left unfinished for years', () => {
    expect(isBracketAbandoned({ challongeState: 'underway', eventDate: daysAgo(600) }, NOW)).toBe(true);
  });

  it('is never true of a bracket that actually finished', () => {
    expect(isBracketAbandoned({ challongeState: 'complete', eventDate: daysAgo(600) }, NOW)).toBe(false);
  });

  it('needs a date to measure against', () => {
    expect(isBracketAbandoned({ challongeState: 'underway', eventDate: null }, NOW)).toBe(false);
    expect(isBracketAbandoned({ challongeState: 'pending', eventDate: 'not a date' }, NOW)).toBe(false);
  });

  it('does not call an upcoming bracket abandoned', () => {
    const future = new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(isBracketAbandoned({ challongeState: 'pending', eventDate: future }, NOW)).toBe(false);
  });
});

describe('isBracketOver', () => {
  it('covers both ways a bracket ends', () => {
    expect(isBracketOver({ challongeState: 'complete', eventDate: daysAgo(600) }, NOW)).toBe(true);
    expect(isBracketOver({ challongeState: 'underway', eventDate: daysAgo(600) }, NOW)).toBe(true);
    expect(isBracketOver({ challongeState: 'underway', eventDate: daysAgo(0) }, NOW)).toBe(false);
  });

  it('is not the same question as "did it finish"', () => {
    const abandoned = { challongeState: 'underway', eventDate: daysAgo(600) };
    expect(isBracketOver(abandoned, NOW)).toBe(true);
    expect(isBracketFinalised(abandoned)).toBe(false);
  });
});
