CREATE TABLE "recap_rankings" (
	"tournament_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"ordered_ids" jsonb,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recap_rankings_tournament_id_input_hash_pk" PRIMARY KEY("tournament_id","input_hash")
);
--> statement-breakpoint
ALTER TABLE "recap_rankings" ADD CONSTRAINT "recap_rankings_tournament_id_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."tournaments"("id") ON DELETE cascade ON UPDATE no action;