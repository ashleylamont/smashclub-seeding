CREATE TABLE "event_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_match_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"source_set_id" uuid,
	"division" text NOT NULL,
	"stage" text NOT NULL,
	"pool_index" integer,
	"label" text NOT NULL,
	"player1_id" uuid,
	"player2_id" uuid,
	"score1" integer,
	"score2" integer,
	"winner_id" uuid,
	"outcome" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"station_id" uuid,
	"blocked_reason" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"sync_state" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_operation_settings" (
	"event_plan_id" uuid PRIMARY KEY NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"player_reports" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_prizes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"player_id" uuid
);
--> statement-breakpoint
CREATE TABLE "event_score_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"expected_revision" integer NOT NULL,
	"score1" integer NOT NULL,
	"score2" integer NOT NULL,
	"winner_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_announcements" ADD CONSTRAINT "event_announcements_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_match_audit" ADD CONSTRAINT "event_match_audit_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_match_audit" ADD CONSTRAINT "event_match_audit_match_id_event_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."event_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_match_audit" ADD CONSTRAINT "event_match_audit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_source_set_id_sets_id_fk" FOREIGN KEY ("source_set_id") REFERENCES "public"."sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_player1_id_players_id_fk" FOREIGN KEY ("player1_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_player2_id_players_id_fk" FOREIGN KEY ("player2_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_winner_id_players_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_matches" ADD CONSTRAINT "event_matches_station_id_event_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."event_stations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_operation_settings" ADD CONSTRAINT "event_operation_settings_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_operators" ADD CONSTRAINT "event_operators_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_operators" ADD CONSTRAINT "event_operators_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_prizes" ADD CONSTRAINT "event_prizes_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_prizes" ADD CONSTRAINT "event_prizes_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_score_reports" ADD CONSTRAINT "event_score_reports_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_score_reports" ADD CONSTRAINT "event_score_reports_match_id_event_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."event_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_score_reports" ADD CONSTRAINT "event_score_reports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_score_reports" ADD CONSTRAINT "event_score_reports_winner_id_players_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_stations" ADD CONSTRAINT "event_stations_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_matches_source_idx" ON "event_matches" USING btree ("event_plan_id","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "event_operators_user_idx" ON "event_operators" USING btree ("event_plan_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_score_reports_request_idx" ON "event_score_reports" USING btree ("user_id","request_id");