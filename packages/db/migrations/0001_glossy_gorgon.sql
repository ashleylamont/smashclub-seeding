ALTER TABLE "player_ratings" ADD COLUMN "skill_rating" double precision DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ratings" ADD COLUMN "skill_sd" double precision DEFAULT 350 NOT NULL;--> statement-breakpoint
ALTER TABLE "recomputes" ADD COLUMN "model" text DEFAULT 'glicko2' NOT NULL;