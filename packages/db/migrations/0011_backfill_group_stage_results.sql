-- Before stage-aware imports, normalized tournament metadata did not contain
-- groupStageEnabled. Completed tournaments never enter the normal sync sweep,
-- so their missing pools cannot be recovered by recomputing existing sets.
-- We cannot distinguish old single-stage imports from old two-stage imports:
-- refresh both once, using the scheduler's unmetered public source.
-- Keep resultsMode and all stored results intact while the refresh is pending.
UPDATE "tournaments"
SET "sync_state" = 'registered', "last_synced_at" = NULL, "updated_at" = now()
WHERE "sync_state" = 'synced'
  AND ("raw" IS NULL OR NOT ("raw" ? 'groupStageEnabled'));
