/**
 * Who still counts as playing.
 *
 * The board carries a long tail of people who turned up twice in 2024 and never
 * came back. They are not wrong — the rating they earned is the rating they
 * earned — but they answer a different question to the one the rankings screen
 * is asked, which is "where do I sit among the people I will actually draw
 * against". So the board hides anyone who has not played in a year, by default.
 *
 * Hiding rows is only half of it. A rank is a position *within a field*, so
 * dropping players out of the field and leaving the old numbers on the rest
 * would print ranks with holes in them (1, 2, 5, 9…) and, worse, movement that
 * nobody earned: if the player above you simply aged out, you did not climb.
 * Both the rank and the rank it is compared against are therefore re-derived
 * over exactly the rows on screen, so ▲2 always means "passed two people who
 * are still here".
 */

/** Only the fields the filter reads; leaderboard rows carry far more. */
export interface RankableRow {
  playerId: string;
  rank: number;
  /** Rank before the club's most recent night; null if unrated then. */
  previousRank: number | null;
  rankDelta: number | null;
  /** ISO date of the player's most recent event. */
  lastPlayedDate: string;
}

export interface ActivityFilterResult<T> {
  /**
   * The rows to show, rank-ascending. Re-ranked when the filter dropped
   * anyone; the input rows untouched when it did not.
   */
  rows: T[];
  /** How many rows are inactive, whether or not they are currently hidden. */
  inactiveCount: number;
}

/**
 * The instant that divides active from inactive: the same calendar date, a year
 * back. Counting 365 days instead drifts by a day across a leap year, and "a
 * year ago" is what a member reads the setting to mean.
 */
export function inactiveBefore(now: number): number {
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  return cutoff.getTime();
}

/**
 * Has this player played inside the last year? "One year or more" ago counts as
 * inactive, so the boundary itself is out.
 *
 * An unparseable date is treated as active: the filter's job is to tidy the
 * board, and silently disappearing a player over a bad string is a worse
 * failure than showing one row too many.
 */
export function isActive(lastPlayedDate: string, now: number): boolean {
  const played = Date.parse(lastPlayedDate);
  if (Number.isNaN(played)) return true;
  return played > inactiveBefore(now);
}

/**
 * Renumber a field so ranks run 1..n with no gaps, and restate each player's
 * previous rank as a position within the same field.
 *
 * Previous ranks are re-derived rather than shifted by a fixed offset because
 * the players who aged out were not all above you: only the ones that were
 * count against your movement.
 */
function reRank<T extends RankableRow>(rows: readonly T[]): T[] {
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);

  const previously = new Map<string, number>();
  byRank
    .filter((row) => row.previousRank !== null)
    .sort((a, b) => a.previousRank! - b.previousRank!)
    .forEach((row, index) => previously.set(row.playerId, index + 1));

  return byRank.map((row, index) => {
    const rank = index + 1;
    // Null previousRank means "had no rating before the last night", which is
    // still true of the smaller field — they get no arrow, not a ▲.
    const previousRank = previously.get(row.playerId) ?? null;
    return {
      ...row,
      rank,
      previousRank,
      rankDelta: previousRank === null ? null : previousRank - rank,
    };
  });
}

/**
 * Apply the inactivity filter to a leaderboard.
 *
 * With the filter off the rows come back exactly as the server ranked them —
 * `inactiveCount` is still reported, so the control can say what turning it on
 * would cost.
 */
export function filterInactive<T extends RankableRow>(
  rows: readonly T[],
  now: number,
  hideInactive: boolean,
): ActivityFilterResult<T> {
  const active = rows.filter((row) => isActive(row.lastPlayedDate, now));
  const inactiveCount = rows.length - active.length;
  if (!hideInactive) return { rows: [...rows], inactiveCount };
  // Nobody dropped out, so nothing needs renumbering — and the server's ranks
  // are already the answer.
  if (inactiveCount === 0) return { rows: [...rows], inactiveCount };
  return { rows: reRank(active), inactiveCount };
}
