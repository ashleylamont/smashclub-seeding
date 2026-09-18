ALTER TABLE "event_match_audit" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "event_match_audit" ADD COLUMN "guest_session_id" uuid;--> statement-breakpoint
ALTER TABLE "event_pool_schedules" ADD COLUMN "self_run" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_pool_schedules" ADD COLUMN "auto_accept_scores" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_match_audit" ADD CONSTRAINT "event_match_audit_guest_session_id_event_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."event_guest_sessions"("id") ON DELETE no action ON UPDATE no action;