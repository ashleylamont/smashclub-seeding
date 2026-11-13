CREATE TABLE "set_character_reports" (
	"kind" text NOT NULL,
	"match_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"picks" jsonb NOT NULL,
	"participant_ids" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "set_character_reports_kind_match_id_user_id_pk" PRIMARY KEY("kind","match_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "set_character_reports" ADD CONSTRAINT "set_character_reports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;