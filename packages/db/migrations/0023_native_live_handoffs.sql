CREATE TABLE "native_live_handoffs" (
	"event_plan_id" uuid PRIMARY KEY NOT NULL,
	"baseline" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_rating_intents" (
	"result_id" uuid PRIMARY KEY NOT NULL,
	"recompute_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "native_result_publications" (
	"result_id" uuid PRIMARY KEY NOT NULL,
	"event_plan_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"result" jsonb NOT NULL,
	"tournament_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_result_publications_revision_check" CHECK ("native_result_publications"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "native_live_handoffs" ADD CONSTRAINT "native_live_handoffs_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_rating_intents" ADD CONSTRAINT "native_rating_intents_result_id_native_result_publications_result_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."native_result_publications"("result_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_rating_intents" ADD CONSTRAINT "native_rating_intents_recompute_id_recomputes_id_fk" FOREIGN KEY ("recompute_id") REFERENCES "public"."recomputes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_result_publications" ADD CONSTRAINT "native_result_publications_event_plan_id_native_live_handoffs_event_plan_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."native_live_handoffs"("event_plan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_result_publications_revision_idx" ON "native_result_publications" USING btree ("event_plan_id","revision");
--> statement-breakpoint
CREATE FUNCTION immutable_native_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Native baseline/publication history is immutable';
END $$;
--> statement-breakpoint
CREATE TRIGGER immutable_native_baseline BEFORE UPDATE OR DELETE ON native_live_handoffs
FOR EACH ROW EXECUTE FUNCTION immutable_native_handoff();
--> statement-breakpoint
CREATE TRIGGER immutable_native_publication BEFORE UPDATE OR DELETE ON native_result_publications
FOR EACH ROW EXECUTE FUNCTION immutable_native_handoff();
--> statement-breakpoint
-- Backstop for every legacy path, including automatic/import/merge writers.
-- Lock the plan before checking ownership: a writer racing adoption must wait,
-- then see the committed handoff. New Act publication writes historical tables
-- only; it never mutates frozen operational rows.
CREATE FUNCTION guard_native_live_writer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_plan uuid; new_plan uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_plan := OLD.event_plan_id; END IF;
  IF TG_OP <> 'DELETE' THEN new_plan := NEW.event_plan_id; END IF;
  PERFORM id FROM event_plans WHERE id IN (old_plan, new_plan) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM native_live_handoffs WHERE event_plan_id IN (old_plan, new_plan)) THEN
    RAISE EXCEPTION 'This event is owned by Act; use the native live command API';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY[
    'event_plan_entries', 'event_pool_assignments', 'event_plan_pool_placements',
    'event_plan_brackets', 'event_matches', 'event_native_brackets',
    'event_score_reports', 'event_match_audit', 'event_attendance_audit',
    'event_withdrawals', 'event_stations', 'event_pool_schedules',
    'event_operation_settings', 'event_prizes', 'event_announcements'
  ] LOOP
    EXECUTE format('CREATE TRIGGER guard_native_live BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_native_live_writer()', tab);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_native_plan_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM native_live_handoffs WHERE event_plan_id = OLD.id) THEN
    RAISE EXCEPTION 'This event is owned by Act; use the native live command API';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER guard_native_plan BEFORE UPDATE OR DELETE ON event_plans
FOR EACH ROW EXECUTE FUNCTION guard_native_plan_writer();
