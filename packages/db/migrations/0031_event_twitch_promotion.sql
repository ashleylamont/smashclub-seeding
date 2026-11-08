CREATE TABLE "event_twitch_promotions" (
	"event_plan_id" uuid PRIMARY KEY NOT NULL,
	"channel" text,
	"expires_at" timestamp with time zone,
	"revision" integer NOT NULL,
	CONSTRAINT "event_twitch_promotion_pair" CHECK (("event_twitch_promotions"."channel" is null) = ("event_twitch_promotions"."expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "event_twitch_promotions" ADD CONSTRAINT "event_twitch_promotions_event_plan_id_event_plans_id_fk" FOREIGN KEY ("event_plan_id") REFERENCES "public"."event_plans"("id") ON DELETE cascade ON UPDATE no action;