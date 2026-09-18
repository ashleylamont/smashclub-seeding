CREATE TABLE "event_guest_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_guest_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"generation" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_guest_settings" (
	"event_plan_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"show_on_overlay" boolean DEFAULT false NOT NULL,
	"secret" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_score_reports" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "event_matches" ADD COLUMN "result_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_score_reports" ADD COLUMN "guest_session_id" uuid;--> statement-breakpoint
ALTER TABLE "event_guest_rate_limits" ADD CONSTRAINT "event_guest_rate_limits_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_guest_sessions" ADD CONSTRAINT "event_guest_sessions_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_guest_settings" ADD CONSTRAINT "event_guest_settings_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_guest_sessions_token_idx" ON "event_guest_sessions" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "event_score_reports" ADD CONSTRAINT "event_score_reports_guest_session_id_event_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."event_guest_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_score_reports_guest_request_idx" ON "event_score_reports" USING btree ("guest_session_id","request_id");--> statement-breakpoint
ALTER TABLE "event_score_reports" ADD CONSTRAINT "event_score_reports_one_reporter" CHECK (("event_score_reports"."user_id" IS NULL) <> ("event_score_reports"."guest_session_id" IS NULL));