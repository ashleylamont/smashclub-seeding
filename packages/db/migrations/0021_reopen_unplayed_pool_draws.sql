-- The previous migration treated a prepared match queue as a TO soft-lock.
-- Reopen only draws with no sign of play, handoff, attendance changes, or
-- configured pool operations. Explicit TO locks always have soft_locked_by.
CREATE TEMP TABLE reopenable_pool_draws AS
SELECT p.id FROM event_plans p
WHERE p.status = 'pools_ready'
  AND p.soft_locked_at IS NOT NULL
  AND p.soft_locked_by IS NULL
  AND NOT EXISTS (SELECT 1 FROM event_matches m WHERE m.event_plan_id = p.id AND
    (m.stage <> 'group' OR m.status <> 'ready' OR m.score1 IS NOT NULL OR m.score2 IS NOT NULL
     OR m.live_score1 IS NOT NULL OR m.live_score2 IS NOT NULL OR m.winner_id IS NOT NULL
     OR m.outcome IS NOT NULL OR m.source_set_id IS NOT NULL))
  AND NOT EXISTS (SELECT 1 FROM event_score_reports r WHERE r.event_plan_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM event_match_audit a WHERE a.event_plan_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM event_plan_pool_placements pp WHERE pp.event_plan_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM event_withdrawals w WHERE w.event_plan_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM event_native_brackets nb WHERE nb.event_plan_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM event_pool_schedules ps WHERE ps.event_plan_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM event_attendance_audit aa WHERE aa.event_plan_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM event_plan_brackets b WHERE b.event_plan_id = p.id AND
    (b.tournament_id IS NOT NULL OR b.challonge_slug IS NOT NULL));--> statement-breakpoint
DELETE FROM event_matches WHERE event_plan_id IN (SELECT id FROM reopenable_pool_draws);--> statement-breakpoint
DELETE FROM event_pool_assignments WHERE event_plan_id IN (SELECT id FROM reopenable_pool_draws);--> statement-breakpoint
UPDATE event_plans SET soft_locked_at = NULL, updated_at = NOW()
WHERE id IN (SELECT id FROM reopenable_pool_draws);--> statement-breakpoint
DROP TABLE reopenable_pool_draws;
