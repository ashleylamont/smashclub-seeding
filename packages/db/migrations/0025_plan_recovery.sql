ALTER TABLE "event_plans" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_plans" ADD COLUMN "results_withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_plans" ADD COLUMN "retirement" jsonb;
--> statement-breakpoint
-- Project a terminal Act retirement without changing the frozen roster or draw.
-- Hard deletion and every other legacy write remain blocked after handoff.
CREATE OR REPLACE FUNCTION guard_native_plan_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM native_live_handoffs WHERE event_plan_id = OLD.id) THEN
    IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
      AND NEW.status = 'cancelled' AND NEW.retirement IS NOT NULL
      AND NEW.retirement->>'operation' IN ('reset', 'delete')
      AND NEW.retirement->>'actorId' IS NOT NULL
      AND NEW.retirement->>'requestId' IS NOT NULL
      AND (to_jsonb(NEW) - ARRAY['deleted_at','results_withdrawn_at','retirement','status','updated_at'])
        = (to_jsonb(OLD) - ARRAY['deleted_at','results_withdrawn_at','retirement','status','updated_at'])
    THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'This event is owned by Act; use the native live command API';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
