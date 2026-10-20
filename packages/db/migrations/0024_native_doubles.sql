ALTER TABLE "event_plan_entries" ADD COLUMN "partner_player_id" uuid;--> statement-breakpoint
ALTER TABLE "event_plan_entries" ADD COLUMN "team_name" text;--> statement-breakpoint
ALTER TABLE "event_plan_entries" ADD COLUMN "snapshot_mean" double precision;--> statement-breakpoint
ALTER TABLE "event_plan_entries" ADD COLUMN "snapshot_sd" double precision;--> statement-breakpoint
ALTER TABLE "event_plans" ADD COLUMN "competition_format" text DEFAULT 'singles' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_plans" ADD COLUMN "structure" text DEFAULT 'dual_division' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_plans" ADD COLUMN "use_pair_ratings" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tournament_participants" ADD COLUMN "member_player_ids" jsonb;--> statement-breakpoint
ALTER TABLE "tournament_participants" ADD COLUMN "team_name" text;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "competition_format" text DEFAULT 'singles' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_plan_entries" ADD CONSTRAINT "event_plan_entries_partner_player_id_players_id_fk" FOREIGN KEY ("partner_player_id") REFERENCES "public"."players"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_plans" ADD COLUMN "native_seed_context" jsonb;
