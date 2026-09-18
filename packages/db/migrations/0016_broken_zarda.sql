CREATE TABLE "event_native_brackets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"division" text NOT NULL,
	"stage" text NOT NULL,
	"entrant_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_pool_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"division" text NOT NULL,
	"pool_index" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"station_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_plans" ADD COLUMN "bracket_mode" text DEFAULT 'challonge' NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "provider" text DEFAULT 'challonge' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_announcements" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_matches" ADD COLUMN "native_bracket_id" uuid;--> statement-breakpoint
ALTER TABLE "event_matches" ADD COLUMN "native_round" integer;--> statement-breakpoint
ALTER TABLE "event_matches" ADD COLUMN "native_slot" integer;--> statement-breakpoint
ALTER TABLE "event_matches" ADD COLUMN "parent1_match_id" uuid;--> statement-breakpoint
ALTER TABLE "event_matches" ADD COLUMN "parent2_match_id" uuid;--> statement-breakpoint
ALTER TABLE "event_matches" ADD COLUMN "live_score1" integer;--> statement-breakpoint
ALTER TABLE "event_matches" ADD COLUMN "live_score2" integer;--> statement-breakpoint
ALTER TABLE "event_native_brackets" ADD CONSTRAINT "event_native_brackets_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_pool_schedules" ADD CONSTRAINT "event_pool_schedules_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_native_brackets_slot_idx" ON "event_native_brackets" USING btree ("event_plan_id","division","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "event_pool_schedules_pool_idx" ON "event_pool_schedules" USING btree ("event_plan_id","division","pool_index");--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_native_bracket_id_event_native_brackets_id_fk" FOREIGN KEY ("native_bracket_id") REFERENCES "public"."event_native_brackets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_parent1_match_id_event_matches_id_fk" FOREIGN KEY ("parent1_match_id") REFERENCES "public"."event_matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_parent2_match_id_event_matches_id_fk" FOREIGN KEY ("parent2_match_id") REFERENCES "public"."event_matches"("id") ON DELETE no action ON UPDATE no action;