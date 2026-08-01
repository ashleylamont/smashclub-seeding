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

/** A player's attendance record against the club's full run of events. */
export interface Attendance {
  /**
   * Consecutive events missed between the player's last appearance and the
   * club's most recent event. Zero for anyone who played the latest one.
   */
  missedEvents: number;
  /**
   * Events attended in an unbroken run up to the club's most recent event, or
   * zero once the run is broken. This is the streak in the sense a member means
   * it: "how many in a row am I on", which stops being true the night you miss.
   */
  attendanceStreak: number;
}

/**
 * Attendance derived from the club's event list rather than from either rating
 * model's internals, so the activity policy means the same thing whichever model
 * is authoritative. Both `replayRatings` and `runWhrModel` go through this.
 *
 * `orderedEventKeys` must be the club's distinct event keys, oldest first.
 */
export function attendanceOf(
  orderedEventKeys: readonly string[],
  attended: ReadonlySet<string>,
): Attendance {
  if (orderedEventKeys.length === 0) return { missedEvents: 0, attendanceStreak: 0 };

  let lastAttendedIndex = -1;
  for (let i = orderedEventKeys.length - 1; i >= 0; i--) {
    if (attended.has(orderedEventKeys[i]!)) {
      lastAttendedIndex = i;
      break;
    }
  }
  // Never seen at all: no run to break and nothing to have missed.
  if (lastAttendedIndex === -1) return { missedEvents: 0, attendanceStreak: 0 };

  const missedEvents = orderedEventKeys.length - 1 - lastAttendedIndex;
  if (missedEvents > 0) return { missedEvents, attendanceStreak: 0 };

  let attendanceStreak = 0;
  for (let i = lastAttendedIndex; i >= 0 && attended.has(orderedEventKeys[i]!); i--) {
    attendanceStreak += 1;
  }
  return { missedEvents, attendanceStreak };
}
