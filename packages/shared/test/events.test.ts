import { describe, expect, it } from 'vitest';
import { eventCanonicalSlug, eventNameOf, inferEventBracketRole } from '../src/events';

describe('event names and roles', () => {
  it('combines the four explicit division titles', () => {
    const names = ['Upper Division', 'Lower Division', 'Upper Losers', 'Lower Losers'].map(s => `Tech In Place 11 (${s})`);
    expect(eventNameOf(names)).toBe('Tech In Place 11');
    expect(inferEventBracketRole(names[2]!)).toEqual({ division: 'upper', stage: 'consolation' });
  });
  it('does not guess roles or a common title for unrelated brackets', () => {
    expect(inferEventBracketRole('Uppercut Monthly')).toBeNull();
    expect(eventNameOf(['Alpha', 'Beta'])).toBe('Club night');
  });
  it('chooses the same canonical slug regardless of input order', () => {
    const rows = [{name:'Night (Lower Division)',slug:'b'}, {name:'Night (Upper Division)',slug:'a'}, {name:'Night (Upper Losers)',slug:'c'}];
    expect(eventCanonicalSlug(rows, 'fallback')).toBe('a');
    expect(eventCanonicalSlug([...rows].reverse(), 'fallback')).toBe('a');
  });
});
