import { z } from 'zod';

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
});

export type GlickoSettings = z.infer<typeof glickoSettingsSchema>;

export const defaultGlickoSettings: GlickoSettings = glickoSettingsSchema.parse({});
