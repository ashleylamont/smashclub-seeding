/**
 * When a bracket that upstream never closed should be read as over.
 *
 * Challonge's `underway` is sticky: a bracket the organiser never finalised
 * still reports it years later. The club's real brackets sometimes end that way
 * — the room runs out of time before the final, everyone goes home, and nobody
 * ever presses the button. Left alone, those pages say "in progress" forever
 * about a night in 2024.
 *
 * The correction is not to guess harder at Challonge's state but to notice how
 * long ago the night was. A club bracket is played and reported on the evening
 * it runs; one still unfinished a week later is not going to finish. That is
 * what {@link isBracketAbandoned} says, and it is a statement about
 * *presentation only* — see the note in `scheduler.ts` on why liveness is never
 * inferred from Challonge state.
 */
const ABANDONED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface BracketStatusInput {
  /** Challonge's own state; null before the bracket has ever been synced. */
  challongeState: string | null;
  /** ISO 8601, or null for a bracket with no date yet. */
  eventDate: string | null;
}

/** True when Challonge itself says the bracket is finalised. */
export function isBracketFinalised(bracket: BracketStatusInput): boolean {
  return bracket.challongeState === 'complete';
}

/**
 * True for a bracket upstream never finalised, whose night is long enough past
 * that it never will be. An undated bracket is never abandoned: without a date
 * there is nothing to measure staleness against.
 */
export function isBracketAbandoned(bracket: BracketStatusInput, now: number): boolean {
  if (isBracketFinalised(bracket)) return false;
  if (!bracket.eventDate) return false;
  const eventTime = Date.parse(bracket.eventDate);
  if (Number.isNaN(eventTime)) return false;
  return now - eventTime > ABANDONED_AFTER_MS;
}

/**
 * True when nothing more is coming from this bracket — either it finished
 * properly or it was abandoned long enough ago to be treated as finished.
 */
export function isBracketOver(bracket: BracketStatusInput, now: number): boolean {
  return isBracketFinalised(bracket) || isBracketAbandoned(bracket, now);
}
