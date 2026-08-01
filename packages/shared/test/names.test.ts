import { describe, expect, it } from 'vitest';
import { defaultPublicAlias, publicPlayerName } from '../src/names';

describe('defaultPublicAlias', () => {
  it('keeps the first name and initials the rest', () => {
    expect(defaultPublicAlias('Sample Player')).toBe('Sample P');
    expect(defaultPublicAlias('Mary Jane Watson')).toBe('Mary J W');
  });

  it('leaves a single-word name alone — nothing follows to shorten', () => {
    expect(defaultPublicAlias('Vincent')).toBe('Vincent');
  });

  it('is idempotent: an already-shortened name survives a second pass', () => {
    expect(defaultPublicAlias('Sample P')).toBe('Sample P');
  });

  it('preserves case rather than upper-casing particles', () => {
    expect(defaultPublicAlias('Ludwig van Beethoven')).toBe('Ludwig v B');
  });

  it('tolerates ragged whitespace', () => {
    expect(defaultPublicAlias('  Sample   Player  ')).toBe('Sample P');
    expect(defaultPublicAlias('')).toBe('');
    expect(defaultPublicAlias('   ')).toBe('');
  });

  it('takes a whole codepoint as the initial, not half a surrogate pair', () => {
    expect(defaultPublicAlias('Sample 𝔓layer')).toBe('Sample 𝔓');
  });

  it('keeps hyphenated first names intact', () => {
    expect(defaultPublicAlias('Anne-Marie Smith')).toBe('Anne-Marie S');
  });
});

describe('publicPlayerName', () => {
  it('prefers a chosen alias over the derived one', () => {
    expect(publicPlayerName({ displayName: 'Zero', canonicalName: 'Sample Player' })).toBe('Zero');
  });

  it('falls back to the shortened canonical name when no alias is set', () => {
    expect(publicPlayerName({ displayName: null, canonicalName: 'Sample Player' })).toBe('Sample P');
  });
});
