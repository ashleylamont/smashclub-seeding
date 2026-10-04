ALTER TABLE "settings" RENAME COLUMN "glicko" TO "rating";--> statement-breakpoint
ALTER TABLE "recomputes" ALTER COLUMN "model" SET DEFAULT 'whr';
--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "rating" SET DEFAULT '{}'::jsonb;
--> statement-breakpoint
-- Retain supported WHR settings and club policy; never rewrite historical runs.
UPDATE "settings"
SET "rating" = (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                FROM jsonb_each("rating")
                WHERE key = ANY (ARRAY['activityGraceEvents','activityPenaltyPerEvent','activityPenaltyCap','provisionalEventCount','provisionalMatchCount','whrDriftVariancePerDay','whrPriorSd','whrGamesWeight','whrRookieDebutPrior','whrIsolationAnchor','leagueBandsCalibrated','leagueBandBasis','leagueBands'])),
    "version" = "version" + 1,
    "updated_at" = now();
