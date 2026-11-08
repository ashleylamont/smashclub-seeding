CREATE TABLE "rating_nights" (
	"recompute_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"event_key" date NOT NULL,
	"played" boolean NOT NULL,
	"pre_rating" double precision NOT NULL,
	"post_rating" double precision NOT NULL,
	"post_rd" double precision NOT NULL,
	"revised_rating" double precision NOT NULL,
	"pre_penalty" double precision NOT NULL,
	"post_penalty" double precision NOT NULL,
	CONSTRAINT "rating_nights_recompute_id_player_id_event_key_pk" PRIMARY KEY("recompute_id","player_id","event_key")
);
--> statement-breakpoint
ALTER TABLE "rating_nights" ADD CONSTRAINT "rating_nights_recompute_id_recomputes_id_fk" FOREIGN KEY ("recompute_id") REFERENCES "public"."recomputes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rating_nights" ADD CONSTRAINT "rating_nights_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;