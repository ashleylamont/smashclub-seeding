import { describe, expect, it } from 'vitest';
import { bucketFor } from '../src/lib/tournamentBuckets';

const NOW = Date.parse('2026-08-01T00:00:00.000Z');

/** Only the fields bucketFor reads; the real list item carries more. */
type Item = Parameters<typeof bucketFor>[0];
const item = (over: Partial<Item>): Item =>
  ({
    id: 'x',
    slug: 'x',
    name: 'x',
    eventDate: null,
    isRookie: false,
    challongeState: null,
    syncState: 'registered',
    lastSyncedAt: null,
    liveUntil: null,
    ...over,
  }) as Item;

describe('bucketFor', () => {
  it('treats an open live window as live', () => {
    expect(bucketFor(item({ liveUntil: '2026-08-01T06:00:00.000Z' }), NOW)).toBe('live');
  });

  it('stops treating it as live once the window has passed', () => {
    expect(bucketFor(item({ liveUntil: '2026-07-31T23:00:00.000Z' }), NOW)).toBe('upcoming');
  });

  /**
   * The regression this was written for: Challonge's `underway` and
   * `awaiting_review` are sticky, so brackets nobody closed still report them
   * years later and were being listed under "Live".
   */
  it('does NOT treat a stale underway bracket as live', () => {
    const stale = item({ challongeState: 'underway', eventDate: '2024-11-27T00:00:00.000Z' });
    expect(bucketFor(stale, NOW)).toBe('completed');
  });

  it('does NOT treat a stale awaiting_review bracket as live', () => {
    const stale = item({ challongeState: 'awaiting_review', eventDate: '2024-06-28T00:00:00.000Z' });
    expect(bucketFor(stale, NOW)).toBe('completed');
  });

  it('keeps a genuinely upcoming tournament upcoming', () => {
    expect(bucketFor(item({ eventDate: '2026-09-01T00:00:00.000Z' }), NOW)).toBe('upcoming');
  });

  it('treats an undated, unfinished tournament as upcoming', () => {
    expect(bucketFor(item({ challongeState: 'pending' }), NOW)).toBe('upcoming');
  });

  it('treats a completed bracket as completed regardless of date', () => {
    const done = item({ challongeState: 'complete', eventDate: '2026-09-01T00:00:00.000Z' });
    expect(bucketFor(done, NOW)).toBe('completed');
  });

  it('prefers an open live window over a completed state', () => {
    const live = item({ challongeState: 'complete', liveUntil: '2026-08-01T06:00:00.000Z' });
    expect(bucketFor(live, NOW)).toBe('live');
  });
});
