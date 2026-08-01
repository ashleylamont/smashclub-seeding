ALTER TABLE "review_items" ADD COLUMN "candidates_computed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Existing rows were scored exactly once, at insert time, so backdate the stamp
-- to created_at rather than claiming they were computed at migration time.
UPDATE "review_items" SET "candidates_computed_at" = "created_at";
