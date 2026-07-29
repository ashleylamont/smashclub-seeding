CREATE TYPE "public"."alias_source" AS ENUM('registry', 'challonge', 'structured', 'manual', 'merge_decision');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('pending', 'approved', 'rejected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."identity_decision_kind" AS ENUM('merge', 'keep_separate');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."player_status" AS ENUM('active', 'merged');--> statement-breakpoint
CREATE TYPE "public"."recompute_status" AS ENUM('running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."review_resolution" AS ENUM('linked_existing', 'created_new', 'kept_separate');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('pending', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."seeding_run_status" AS ENUM('draft', 'pushed', 'stale');--> statement-breakpoint
CREATE TYPE "public"."sync_state" AS ENUM('registered', 'syncing', 'live', 'synced', 'error');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "company_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"alias_norm" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "identity_decision_kind" NOT NULL,
	"alias_norm" text NOT NULL,
	"company_id" uuid,
	"player_id" uuid,
	"kept_separate_from_player_id" uuid,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" uuid NOT NULL,
	"alias_norm" text NOT NULL,
	"company_id" uuid,
	"source" "alias_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"player_id" uuid NOT NULL,
	"status" "claim_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recompute_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"league" text NOT NULL,
	"rating" double precision NOT NULL,
	"rd" double precision NOT NULL,
	"vol" double precision NOT NULL,
	"effective_rating" double precision NOT NULL,
	"effective_rd" double precision NOT NULL,
	"conservative_rating" double precision NOT NULL,
	"match_count" integer NOT NULL,
	"wins" integer NOT NULL,
	"losses" integer NOT NULL,
	"main_match_count" integer NOT NULL,
	"rookie_match_count" integer NOT NULL,
	"tournament_count" integer NOT NULL,
	"unique_opponent_count" integer NOT NULL,
	"bridge_opponent_count" integer NOT NULL,
	"rookie_ratio" double precision NOT NULL,
	"isolation_factor" double precision NOT NULL,
	"sample_confidence" double precision NOT NULL,
	"last_played_date" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"company_id" uuid,
	"display_name" text,
	"legacy_id" text,
	"status" "player_status" DEFAULT 'active' NOT NULL,
	"merged_into_player_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_legacy_id_unique" UNIQUE("legacy_id")
);
--> statement-breakpoint
CREATE TABLE "rating_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recompute_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"set_id" uuid,
	"tournament_id" uuid NOT NULL,
	"is_decay" boolean DEFAULT false NOT NULL,
	"won" boolean,
	"opponent_player_id" uuid,
	"pre_rating" double precision NOT NULL,
	"post_rating" double precision NOT NULL,
	"pre_rd" double precision NOT NULL,
	"post_rd" double precision NOT NULL,
	"pre_vol" double precision NOT NULL,
	"post_vol" double precision NOT NULL,
	"weight" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recomputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "recompute_status" DEFAULT 'running' NOT NULL,
	"engine_version" text NOT NULL,
	"settings_snapshot" jsonb NOT NULL,
	"stats" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_participant_id" uuid NOT NULL,
	"raw_name" text NOT NULL,
	"cleaned_name" text NOT NULL,
	"company_id" uuid,
	"candidates" jsonb NOT NULL,
	"status" "review_status" DEFAULT 'pending' NOT NULL,
	"resolution" "review_resolution",
	"resolved_player_id" uuid,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seeding_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"player_id" uuid,
	"auto_score" double precision,
	"auto_seed" integer NOT NULL,
	"override_seed" integer,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seeding_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"recompute_id" uuid,
	"created_by" text,
	"status" "seeding_run_status" DEFAULT 'draft' NOT NULL,
	"pushed_at" timestamp with time zone,
	"push_log" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"challonge_match_id" bigint NOT NULL,
	"round" integer,
	"suggested_play_order" integer,
	"identifier" text,
	"state" text NOT NULL,
	"p1_participant_id" uuid,
	"p2_participant_id" uuid,
	"p1_player_id" uuid,
	"p2_player_id" uuid,
	"winner" integer,
	"scores_csv" text,
	"excluded_from_ratings" boolean DEFAULT false NOT NULL,
	"exclusion_manual" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"glicko" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"tournament_id" uuid,
	"status" "job_status" DEFAULT 'running' NOT NULL,
	"error" text,
	"stats" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tournament_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"challonge_participant_id" bigint NOT NULL,
	"raw_name" text NOT NULL,
	"cleaned_name" text NOT NULL,
	"company_id" uuid,
	"player_id" uuid,
	"challonge_seed" integer,
	"final_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournaments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challonge_slug" text NOT NULL,
	"challonge_id" bigint,
	"name" text NOT NULL,
	"event_date" timestamp with time zone,
	"event_date_manual" boolean DEFAULT false NOT NULL,
	"challonge_state" text,
	"sync_state" "sync_state" DEFAULT 'registered' NOT NULL,
	"is_rookie" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"sync_error" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tournaments_challonge_slug_unique" UNIQUE("challonge_slug")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_aliases" ADD CONSTRAINT "company_aliases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_decisions" ADD CONSTRAINT "identity_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_decisions" ADD CONSTRAINT "identity_decisions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_decisions" ADD CONSTRAINT "identity_decisions_kept_separate_from_player_id_players_id_fk" FOREIGN KEY ("kept_separate_from_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_decisions" ADD CONSTRAINT "identity_decisions_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_aliases" ADD CONSTRAINT "player_aliases_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_aliases" ADD CONSTRAINT "player_aliases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_claims" ADD CONSTRAINT "player_claims_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_claims" ADD CONSTRAINT "player_claims_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_claims" ADD CONSTRAINT "player_claims_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_ratings" ADD CONSTRAINT "player_ratings_recompute_id_recomputes_id_fk" FOREIGN KEY ("recompute_id") REFERENCES "public"."recomputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_ratings" ADD CONSTRAINT "player_ratings_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_recompute_id_recomputes_id_fk" FOREIGN KEY ("recompute_id") REFERENCES "public"."recomputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_set_id_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_events" ADD CONSTRAINT "rating_events_opponent_player_id_players_id_fk" FOREIGN KEY ("opponent_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_tournament_participant_id_tournament_participants_id_fk" FOREIGN KEY ("tournament_participant_id") REFERENCES "public"."tournament_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_resolved_player_id_players_id_fk" FOREIGN KEY ("resolved_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seeding_entries" ADD CONSTRAINT "seeding_entries_run_id_seeding_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."seeding_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seeding_entries" ADD CONSTRAINT "seeding_entries_participant_id_tournament_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."tournament_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seeding_entries" ADD CONSTRAINT "seeding_entries_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seeding_runs" ADD CONSTRAINT "seeding_runs_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seeding_runs" ADD CONSTRAINT "seeding_runs_recompute_id_recomputes_id_fk" FOREIGN KEY ("recompute_id") REFERENCES "public"."recomputes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seeding_runs" ADD CONSTRAINT "seeding_runs_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_p1_participant_id_tournament_participants_id_fk" FOREIGN KEY ("p1_participant_id") REFERENCES "public"."tournament_participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_p2_participant_id_tournament_participants_id_fk" FOREIGN KEY ("p2_participant_id") REFERENCES "public"."tournament_participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_p1_player_id_players_id_fk" FOREIGN KEY ("p1_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_p2_player_id_players_id_fk" FOREIGN KEY ("p2_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_aliases_alias_norm_idx" ON "company_aliases" USING btree ("alias_norm");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_decisions_scope_idx" ON "identity_decisions" USING btree ("alias_norm",coalesce("company_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("kept_separate_from_player_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX "player_aliases_norm_company_idx" ON "player_aliases" USING btree ("alias_norm",coalesce("company_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX "player_claims_live_per_user_idx" ON "player_claims" USING btree ("user_id") WHERE "player_claims"."status" in ('pending', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "player_ratings_recompute_player_idx" ON "player_ratings" USING btree ("recompute_id","player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_items_pending_participant_idx" ON "review_items" USING btree ("tournament_participant_id") WHERE "review_items"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "seeding_entries_run_participant_idx" ON "seeding_entries" USING btree ("run_id","participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sets_challonge_match_idx" ON "sets" USING btree ("tournament_id","challonge_match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_participants_challonge_idx" ON "tournament_participants" USING btree ("tournament_id","challonge_participant_id");