ALTER TABLE "sets" ADD COLUMN "result_stage" text DEFAULT 'final' NOT NULL;--> statement-breakpoint
ALTER TABLE "tournaments" ADD COLUMN "results_mode" text DEFAULT 'auto' NOT NULL;