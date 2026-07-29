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

  // Inactivity decay, counted in missed tournaments
  missedTournamentRdScale: z.number().default(20),
  missedTournamentEscalation: z.number().default(0.2),

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
   * Absolute league thresholds on the skill rating, highest first.
   *
   * These replace live quartiles of the current field, under which a player's
   * league changed when *other* people played and a label meant nothing across
   * time. Calibrate once from the field (admin action), then leave fixed so
   * promotion and relegation are real events.
   */
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
