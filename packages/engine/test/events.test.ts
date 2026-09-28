import { describe, expect, it } from 'vitest';
import { eventKeyOf } from '../src/events';

/**
 * One definition of "same occasion", used by both the Glicko replay (for decay
 * periods) and the WHR run (for rating periods). They previously derived it
 * separately, so this is the guard against them drifting apart again.
 */
describe('eventKeyOf', () => {
  it('groups brackets that ran on the same evening at different times', () => {
    // A main bracket at 18:00 and its rookie bracket at 20:30 are one occasion.
    expect(eventKeyOf('2025-03-01T07:00:00.000Z')).toBe(eventKeyOf('2025-03-01T09:30:00.000Z'));
  });

  it('separates different evenings', () => {
    expect(eventKeyOf('2025-03-01T07:00:00.000Z')).not.toBe(eventKeyOf('2025-04-01T07:00:00.000Z'));
  });

  it('accepts a bare date as well as a timestamp', () => {
    expect(eventKeyOf('2025-03-01')).toBe(eventKeyOf('2025-03-01T20:30:00.000Z'));
  });

  it('separates adjacent days rather than bucketing by elapsed time', () => {
    // Decay counts occasions, so consecutive club nights are two periods even
    // though only one day separates them — and a three-month gap is still one.
    expect(eventKeyOf('2025-03-01T23:59:59.000Z')).not.toBe(eventKeyOf('2025-03-02T00:00:01.000Z'));
  });
});
