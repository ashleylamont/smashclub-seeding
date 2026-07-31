ALTER TABLE "tournaments" ADD COLUMN "live_until" timestamp with time zone;--> statement-breakpoint
-- Live monitoring is now explicit and self-expiring (tournaments.live_until)
-- rather than inferred from Challonge's sticky `underway` state. Retire the
-- rows that inference left behind: nothing selects sync_state = 'live' any
-- more, so leaving them would strand those tournaments — the fast poller no
-- longer looks at them and the sweep used to skip them.
--
-- 'registered' (not 'synced') so the sweep picks them up on its normal cadence
-- and re-derives their real state from Challonge.
UPDATE "tournaments" SET "sync_state" = 'registered' WHERE "sync_state" = 'live';
