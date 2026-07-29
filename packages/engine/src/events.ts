/**
 * What counts as one *event*.
 *
 * The club runs a main bracket and a rookie bracket on the same evening as two
 * separate Challonge tournaments. They are one occasion — a member attends the
 * night, and can only be in one of the two brackets — so anything that reasons
 * about attendance has to group them.
 *
 * Two things depend on this and previously derived it separately (a string slice
 * in `replay.ts`, integer division on the epoch in `whrRun.ts`). They agreed, but
 * the definition belongs in one place so it cannot drift.
 *
 * Note what this is *not*: it is not elapsed time. Inactivity decay counts missed
 * events, so a three-month gap between club nights costs one step, not ninety.
 * The date only identifies the occasion.
 */

/**
 * Grouping key for an event. Brackets sharing it are one occasion.
 *
 * `eventDate` may be a date (`2025-03-01`) or a timestamp
 * (`2025-03-01T20:30:00.000Z`); same-evening brackets normally carry different
 * times, so only the date part identifies the occasion.
 *
 * The date part is UTC. That is correct for an Australian club — a local evening
 * falls in the morning of the same UTC day — but a club in a UTC-negative zone
 * could have one evening straddle UTC midnight and split into two events. If the
 * club ever moves, this wants a configured timezone rather than a slice.
 */
export function eventKeyOf(eventDate: string): string {
  return eventDate.slice(0, 10);
}
