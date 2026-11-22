CREATE TABLE "app_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"description" text NOT NULL,
	"version" text NOT NULL,
	"build" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_feedback_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE INDEX "app_feedback_created_at_id" ON "app_feedback" USING btree ("created_at","id");