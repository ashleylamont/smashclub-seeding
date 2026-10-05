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
 * WHR is the sole rating model. Attendance, leagues and seeding are club policy.
 */
export const ratingSettingsSchema = z
  .object({
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

    // Whole-History Rating parameters.
    whrDriftVariancePerDay: z.number().nonnegative().default(0.0002),
    whrPriorSd: z.number().positive().default(1.2),
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
    whrGamesWeight: z.number().nonnegative().default(0.5),

    /**
     * Prior mean (display scale) for players whose first-ever bracket is a rookie
     * bracket. The global 1500 prior overstates the typical rookie-night
     * newcomer — the board shows them settling in the 1300s–1400s — and because a
     * rookie island is pinned to the scale almost entirely through its players'
     * priors, that error inflates everyone who farms the island. 1500 disables
     * the correction (identical to the single global prior).
     */
    whrRookieDebutPrior: z.number().default(1500),

    /**
     * Shrink a player's *displayed* WHR rating toward their own prior mean by how
     * little of their record is exposed to the established field. The fit itself
     * is untouched — this corrects the point estimate the board publishes, where
     * an islander's rating is identified mostly by other islanders. Off by
     * default: flip on together with a recompute once the parameters are
     * settled.
     */
    whrIsolationAnchor: z.boolean().default(false),

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

    leagueBands: z.array(z.object({ name: z.string(), minRating: z.number() })).default([
      { name: '🏆 Champions', minRating: 1650 },
      { name: '💼 Smashclub Full-Timers', minRating: 1525 },
      { name: '🎓 Smashclub Grads', minRating: 1425 },
      { name: '👶 Smashclub Interns', minRating: LEAGUE_CATCH_ALL },
    ]),
  })
  .strict();

export type RatingSettings = z.output<typeof ratingSettingsSchema>;
export type RatingSettingsInput = z.input<typeof ratingSettingsSchema>;

export const defaultRatingSettings: RatingSettings = ratingSettingsSchema.parse({});
