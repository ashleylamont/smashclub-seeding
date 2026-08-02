import { z } from 'zod';

/**
 * Lower bound for the bottom league band, meaning "everyone else".
 *
 * Deliberately a finite number rather than -Infinity: settings are stored as
 * JSON, which has no Infinity, so -Infinity would serialise to null and then
 * fail validation on the way back in.
 */
export const LEAGUE_CATCH_ALL = -1_000_000;

/**
 * Tunable parameters of the rating system. Stored as a single settings row in
 * the DB; any change triggers a full recompute (recomputes snapshot the
 * settings they ran with).
 *
 * Defaults mirror the constants the legacy Python CLI hardcoded in
 * glicko_calculator.py so a fresh install reproduces the club's tuned system.
 */
export const glickoSettingsSchema = z.object({
  // Core Glicko-2
  initialRating: z.number().default(1500),
  initialRd: z.number().default(350),
  initialVol: z.number().default(0.06),
  tau: z.number().default(0.5),
  rdCap: z.number().default(350),

  // Per-tournament match weighting: w = (matchNum / totalInTournament) ** exponent
  inverseDiminishingExponent: z.number().default(0.3),

  // Rookie-bracket scaling
  rookieBracketBaseScale: z.number().default(0.5),
  rookiePartialPenaltyThreshold: z.number().default(1400),
  rookieFullPenaltyThreshold: z.number().default(1550),
  rookieOverPenaltyThreshold: z.number().default(1650),

  /**
   * How much uncertainty one missed *event* adds, in rating points, combined in
   * quadrature: rd' = min(decayRdCap, √(rd² + growth²)).
   *
   * This is an honest statement about skill drifting while unobserved, and
   * nothing more. It used to be a policy lever as well — the old formula grew RD
   * by ~20 idle Glicko periods per missed event and escalated per consecutive
   * miss, purely so that ranking on `skill − 2·RD` would make absence hurt.
   * Attendance policy now lives in the activity penalty below, so this can go
   * back to being a modest, uniform statement of doubt.
   *
   * Deliberately *not* scaled by the player's volatility, as the old formula was.
   * Volatility measures how erratic someone's results are, so charging it here
   * meant two players absent for the same three months accrued different amounts
   * of doubt — a difference nobody chose and nobody could explain.
   */
  missedEventRdGrowth: z.number().default(35),

  /**
   * Ceiling on RD reached by missing events, as opposed to `rdCap` (which also
   * bounds a newcomer's opening RD).
   *
   * Set below `rdCap` on purpose: a lapsed regular is not a stranger. Letting
   * their RD climb all the way to the cold-start value throws away everything
   * the club learned about them, and makes their first night back a coin flip
   * for seeding. This floors how much we can forget.
   */
  decayRdCap: z.number().default(250),

  /**
   * Activity policy: what missing club nights costs on the public board.
   *
   * Kept as an explicit subtraction from the skill estimate rather than routed
   * through RD, so that every knob answers a question a member would actually
   * ask. "How long am I safe for?" — `activityGraceEvents` events. "What does
   * lapsing cost?" — `activityPenaltyPerEvent` a time, never more than
   * `activityPenaltyCap`. Playing resets it in full.
   *
   * The defaults suit a club that runs an event every few months: one missed
   * event is free, so the every-other-event regular — the normal case in a
   * casual club — is never penalised at all, while someone who has drifted off
   * for a year slides about a league and can win it all back in one night.
   */
  activityGraceEvents: z.number().default(1),
  activityPenaltyPerEvent: z.number().default(40),
  activityPenaltyCap: z.number().default(120),

  /**
   * Below either threshold a player is badged *provisional* rather than sunk in
   * the order. Shrinkage already pulls a thin record toward the middle, which is
   * the statistically honest treatment of someone we have barely seen; the badge
   * says the same thing to a reader without pretending they are the worst player
   * in the club.
   */
  provisionalEventCount: z.number().default(2),
  provisionalMatchCount: z.number().default(8),

  // Sample-confidence blend for the conservative seeding score
  confidenceTournamentWeight: z.number().default(0.45),
  confidenceOpponentWeight: z.number().default(0.35),
  confidenceMatchWeight: z.number().default(0.2),
  confidenceFloor: z.number().default(0.35),
  anchorFloor: z.number().default(0.2),

  /**
   * Which model produces the authoritative ratings. Both run in parallel so
   * they can be compared before anything is switched over.
   */
  activeModel: z.enum(['glicko2', 'whr']).default('glicko2'),

  /** Whole-History Rating parameters (used when activeModel is 'whr'). */
  whrDriftVariancePerDay: z.number().default(0.0002),
  whrPriorSd: z.number().default(1.2),
  /**
   * How much extra evidence a decisive set carries, per game of winning margin
   * beyond the first: a set counts as `1 + weight · (margin − 1)` independent
   * results, capped at 2. At the default 0.5 a 3-0 counts as two results, a
   * 3-1 as one and a half, and a 3-2 — or a set with no recorded game scores —
   * as exactly one. Games within a set are far from independent (momentum,
   * character counterpicks, tilt), which is why the weight discounts the
   * margin rather than counting games outright. Zero disables score
   * sensitivity entirely.
   */
  whrGamesWeight: z.number().default(0.5),

  /**
   * Absolute league thresholds on the skill rating, highest first.
   *
   * These replace live quartiles of the current field, under which a player's
   * league changed when *other* people played and a label meant nothing across
   * time. Calibrate once from the field (admin action), then leave fixed so
   * promotion and relegation are real events.
   */
  /**
   * False until the bands have been fitted to the club's actual rating
   * distribution. The shipped defaults are arbitrary guesses — on real data they
   * put over half the field into a single league — so the first recompute
   * calibrates them from the field and sets this, after which they stay put.
   */
  leagueBandsCalibrated: z.boolean().default(false),

  /**
   * Which number the stored bands were fitted to. Bands cut from one scale mean
   * nothing against another — skill and the conservative rating differ by
   * roughly 2·RD — so when this does not match what the board ranks on, the next
   * recompute refits and stamps the new basis. Defaults to `skill`, which is
   * what every set of bands stored before the board moved off it was fitted to.
   */
  leagueBandBasis: z.enum(['skill', 'conservative', 'club']).default('skill'),

  leagueBands: z
    .array(z.object({ name: z.string(), minRating: z.number() }))
    .default([
      { name: '🏆 Champions', minRating: 1650 },
      { name: '💼 Smashclub Full-Timers', minRating: 1525 },
      { name: '🎓 Smashclub Grads', minRating: 1425 },
      { name: '👶 Smashclub Interns', minRating: LEAGUE_CATCH_ALL },
    ]),
});

export type GlickoSettings = z.output<typeof glickoSettingsSchema>;
export type GlickoSettingsInput = z.input<typeof glickoSettingsSchema>;

export const defaultGlickoSettings: GlickoSettings = glickoSettingsSchema.parse({});
