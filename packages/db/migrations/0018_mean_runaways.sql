ALTER TABLE "event_operation_settings" ADD COLUMN "score_reporting_mode" text DEFAULT 'to_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_score_reports" ADD COLUMN "auto_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "event_score_reports" ADD COLUMN "submitted_revision" integer;--> statement-breakpoint
ALTER TABLE "event_score_reports" ADD COLUMN "is_dispute" boolean DEFAULT false NOT NULL;