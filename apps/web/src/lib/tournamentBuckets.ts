import type { TournamentListItem } from './apiTypes';

export type Bucket = 'live' | 'upcoming' | 'completed';

/**
 * "Live" is an explicit, expiring admin decision (`liveUntil`) — NEVER inferred
 * from Challonge's state.
 *
 * Challonge's `underway` and `awaiting_review` are sticky: a bracket nobody
 * closed properly still reports them years later. Inferring liveness from them
 * listed 2024 tournaments under "Live" (and previously drove a 15s poll loop
 * against a rate-limited API). A past-dated bracket that upstream never closed
 * is shown as completed — which is what it actually is — and the row still
 * displays its real sync state.
 *
 * `now` is a parameter rather than a `Date.now()` read: this is called from
 * render, where reading the clock is neither pure nor correct (see
 * `lib/useNow.ts`), and it is what makes the rule unit-testable.
 */
export function bucketFor(t: TournamentListItem, now: number): Bucket {
  if (t.liveUntil && new Date(t.liveUntil).getTime() > now) return 'live';
  if (t.challongeState === 'complete') return 'completed';
  const eventTime = t.eventDate ? new Date(t.eventDate).getTime() : null;
  if (eventTime !== null && eventTime < now) return 'completed';
  return 'upcoming';
}
