CREATE TABLE "event_broadcast_presentations" (
	"event_plan_id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "event_broadcast_presentation_mode" CHECK ("event_broadcast_presentations"."mode" in ('auto', 'gameplay', 'progress')),
	CONSTRAINT "event_broadcast_presentation_revision" CHECK ("event_broadcast_presentations"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "event_broadcast_presentations" ADD CONSTRAINT "event_broadcast_presentations_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;