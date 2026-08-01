ALTER TABLE "player_ratings" ADD COLUMN "missed_events" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ratings" ADD COLUMN "attendance_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ratings" ADD COLUMN "activity_penalty" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ratings" ADD COLUMN "next_miss_penalty" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ratings" ADD COLUMN "club_rating" double precision DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_ratings" ADD COLUMN "is_provisional" boolean DEFAULT false NOT NULL;