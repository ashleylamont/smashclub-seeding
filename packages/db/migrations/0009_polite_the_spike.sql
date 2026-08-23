CREATE TYPE "public"."event_plan_bracket_state" AS ENUM('draft', 'attached', 'verified', 'error');--> statement-breakpoint
CREATE TYPE "public"."event_plan_division" AS ENUM('upper', 'lower');--> statement-breakpoint
CREATE TYPE "public"."event_plan_division_preference" AS ENUM('auto', 'upper', 'lower');--> statement-breakpoint
CREATE TYPE "public"."event_plan_placement_source" AS ENUM('manual', 'challonge');--> statement-breakpoint
CREATE TYPE "public"."event_plan_resolution" AS ENUM('alias', 'decision', 'structured', 'manual', 'new', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."event_plan_stage" AS ENUM('main', 'consolation');--> statement-breakpoint
CREATE TYPE "public"."event_plan_status" AS ENUM('draft', 'roster_frozen', 'pools_ready', 'underway', 'complete', 'cancelled');--> statement-breakpoint
CREATE TABLE "event_plan_brackets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"division" "event_plan_division" NOT NULL,
	"stage" "event_plan_stage" NOT NULL,
	"tournament_id" uuid,
	"challonge_slug" text,
	"external_state" "event_plan_bracket_state" DEFAULT 'draft' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_plan_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"source_line_number" integer NOT NULL,
	"raw_input" text NOT NULL,
	"cleaned_name" text NOT NULL,
	"company_id" uuid,
	"player_id" uuid,
	"resolution_method" "event_plan_resolution" DEFAULT 'unresolved' NOT NULL,
	"division_preference" "event_plan_division_preference" DEFAULT 'auto' NOT NULL,
	"assigned_division" "event_plan_division",
	"snapshot_rank" integer,
	"snapshot_score" double precision,
	"division_seed" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_plan_pool_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"division" "event_plan_division" NOT NULL,
	"pool_index" integer NOT NULL,
	"player_id" uuid NOT NULL,
	"place" integer NOT NULL,
	"source" "event_plan_placement_source" DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"event_date" timestamp with time zone NOT NULL,
	"slug_prefix" text,
	"status" "event_plan_status" DEFAULT 'draft' NOT NULL,
	"upper_target_size" integer,
	"pool_size" integer DEFAULT 4 NOT NULL,
	"ranking_snapshot_at" timestamp with time zone,
	"ranking_recompute_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_plan_brackets" ADD CONSTRAINT "event_plan_brackets_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plan_brackets" ADD CONSTRAINT "event_plan_brackets_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plan_entries" ADD CONSTRAINT "event_plan_entries_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plan_entries" ADD CONSTRAINT "event_plan_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plan_entries" ADD CONSTRAINT "event_plan_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plan_pool_placements" ADD CONSTRAINT "event_plan_pool_placements_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plan_pool_placements" ADD CONSTRAINT "event_plan_pool_placements_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plans" ADD CONSTRAINT "event_plans_ranking_recompute_id_recomputes_id_fk" FOREIGN KEY ("ranking_recompute_id") REFERENCES "public"."recomputes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_plans" ADD CONSTRAINT "event_plans_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_plan_brackets_slot_idx" ON "event_plan_brackets" USING btree ("event_plan_id","division","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "event_plan_entries_player_idx" ON "event_plan_entries" USING btree ("event_plan_id","player_id") WHERE "event_plan_entries"."player_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "event_plan_entries_seed_idx" ON "event_plan_entries" USING btree ("event_plan_id","assigned_division","division_seed") WHERE "event_plan_entries"."assigned_division" is not null and "event_plan_entries"."division_seed" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "event_plan_placements_player_idx" ON "event_plan_pool_placements" USING btree ("event_plan_id","division","pool_index","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_plan_placements_place_idx" ON "event_plan_pool_placements" USING btree ("event_plan_id","division","pool_index","place");