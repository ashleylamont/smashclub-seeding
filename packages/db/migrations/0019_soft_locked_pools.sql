ALTER TABLE "event_plans" ADD COLUMN "soft_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_plans" ADD COLUMN "soft_locked_by" text;--> statement-breakpoint
ALTER TABLE "event_plans" ADD CONSTRAINT "event_plans_soft_locked_by_user_id_fk" FOREIGN KEY ("soft_locked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing operational plans already rely on stable pools; retain that commitment.
UPDATE "event_plans" SET "soft_locked_at" = "updated_at"
WHERE "status" IN ('underway', 'complete')
   OR EXISTS (SELECT 1 FROM "event_matches" WHERE "event_matches"."event_plan_id" = "event_plans"."id")
   OR EXISTS (SELECT 1 FROM "event_pool_assignments" WHERE "event_pool_assignments"."event_plan_id" = "event_plans"."id")
   OR EXISTS (SELECT 1 FROM "event_withdrawals" WHERE "event_withdrawals"."event_plan_id" = "event_plans"."id")
   OR EXISTS (SELECT 1 FROM "event_plan_brackets" WHERE "event_plan_brackets"."event_plan_id" = "event_plans"."id" AND ("challonge_slug" IS NOT NULL OR "tournament_id" IS NOT NULL));
