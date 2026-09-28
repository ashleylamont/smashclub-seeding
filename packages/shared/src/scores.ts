/**
 * What a `scores_csv` can and cannot mean.
 *
 * Lives in shared because three layers need the same answer and had been giving
 * three different ones: the sync decides whether a set counts towards ratings,
 * the recap decides whether it has a story worth telling, and the web decides
 * whether to print it.
 */

/**
 * A game count no real set can reach. Club sets are best-of-three, occasionally
 * best-of-five; five is the ceiling with room to spare.
 */
const MAX_PLAUSIBLE_GAMES = 5;

const GAME_PATTERN = /^(-?\d+)-(-?\d+)$/;

function eachGame(scoresCsv: string, predicate: (a: number, b: number) => boolean): boolean {
  return scoresCsv.split(',').some((game) => {
    const match = game.trim().match(GAME_PATTERN);
    if (!match) return false;
    return predicate(Number(match[1]), Number(match[2]));
  });
}

/**
 * Challonge marks forfeits and DQs with a negative game score (e.g. "-1-0").
 */
export function scoresIndicateForfeit(scoresCsv: string | null | undefined): boolean {
  if (!scoresCsv) return false;
  return eachGame(scoresCsv, (a, b) => a < 0 || b < 0);
}

/**
 * True for the club's bye convention: `99-0`.
 *
 * Challonge insists on *some* score to close a match, so a slot nobody played —
 * a bye, or an opponent who never showed — gets recorded as 99 games to nil.
 * That is not a result. Left alone it counted as a set won for ratings, showed
 * up in recaps as a scoreline, and told a player they had beaten someone who
 * was never there.
 *
 * The test is the impossible game count rather than the literal string, so any
 * other placeholder number the room reaches for lands the same way.
 */
export function scoresIndicateBye(scoresCsv: string | null | undefined): boolean {
  if (!scoresCsv) return false;
  return eachGame(scoresCsv, (a, b) => a > MAX_PLAUSIBLE_GAMES || b > MAX_PLAUSIBLE_GAMES);
}

/** A "result" that was never played: a walkover, a DQ, or a bye. */
export function scoresIndicateUnplayed(scoresCsv: string | null | undefined): boolean {
  return scoresIndicateForfeit(scoresCsv) || scoresIndicateBye(scoresCsv);
}
