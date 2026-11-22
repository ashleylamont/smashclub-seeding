CREATE TABLE "app_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"description" text NOT NULL,
	"version" text NOT NULL,
	"build" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_feedback_created_at_id" ON "app_feedback" USING btree ("created_at","id");