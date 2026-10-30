ALTER TABLE "event_guest_sessions" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "event_guest_settings" ALTER COLUMN "rotate_invitations" SET DEFAULT false;