CREATE TABLE "app_feedback_issues" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"marker" uuid DEFAULT gen_random_uuid() NOT NULL,
	"issue_number" integer,
	"rejected" boolean DEFAULT false NOT NULL,
	"claimed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp (3) with time zone,
	"rate_bucket" text
);
--> statement-breakpoint
CREATE INDEX "app_feedback_issues_claimed_at" ON "app_feedback_issues" USING btree ("claimed_at");--> statement-breakpoint
CREATE INDEX "app_feedback_issues_rate_bucket" ON "app_feedback_issues" USING btree ("rate_bucket","claimed_at");