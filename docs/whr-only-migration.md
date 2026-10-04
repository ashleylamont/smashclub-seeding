# WHR-only cutover

Migration `0022_whr_only_ratings.sql` renames `settings.glicko` to `settings.rating`, keeps the supported WHR parameters and club policy keys, removes the retired model selector and Glicko knobs, and increments the settings version. Missing settings retain the existing WHR and policy defaults. The recompute model default becomes `whr`; no old row is relabelled.

## Historical data

Source sets, player identities, old recompute settings snapshots, derived events/ratings, seeding runs, locked seed entries and frozen planner snapshots are preserved. Both old Glicko runs and old WHR runs remain historical provenance with their original values. Automatic recompute pruning is removed so it cannot detach a seed snapshot's provenance. Storage will grow with subsequent runs; a future retention policy must preserve referenced and historically required runs.

Canonical board, profile, history, recap and new-seeding readers select only a **completed WHR run from engine version 2.0.0**. Earlier WHR runs are also retired from canonical reading because their per-set columns used synthetic trajectory semantics. Before the first current-engine WHR run succeeds, rating surfaces are empty and unrated rather than substituting an old model. Existing frozen draws remain intact.

A recompute fits before publishing. Nonconvergence fails the run. Rating rows, effective calibrated settings/version and the completion marker commit together; failures leave the previous eligible WHR run available. The completed snapshot records the actual calibrated settings. Settings changes during a run cause failure instead of publishing under stale configuration. New source corrections and settings saves queue another recompute through the existing trigger.

## Deployment steps (not performed by this change)

1. Back up the database and retain the prior application image and configuration. Rehearse against a disposable restored database.
2. Coordinate this application/schema release: old binaries expect `settings.glicko`, so do not keep an old writer running after the column rename. The existing single-replica startup migration workflow supports the cutover.
3. Apply the versioned migrations using the repository's usual deployment workflow. Startup queues a WHR recompute if there is no current eligible run. An organiser can retry **Admin → Settings → Recompute now** if it fails.
4. Verify a completed `model = 'whr'`, `engine_version = '2.0.0'` run with `stats.whr.converged = true`, effective settings, expected rated set/player counts and no non-played input. Confirm frozen event seeds and their recompute IDs match the backup.
5. Do not modify live seeds to adopt the new ratings. New drafts may use the new WHR board; live and frozen tournaments keep their baseline until an explicit existing lifecycle action permits changes.

If reverting the release, stop the new writer and restore the backed-up application/schema/configuration together. Do not relabel a WHR or Glicko recompute or alter source results to imitate the other model. No migration or recompute against a production database was run while implementing this change.

## Verification and concurrent work

Fixture tests migrate both old model configurations, preserve customised policy, verify original match/recompute/event records and pushed locked seeds, recompute WHR, and verify migration idempotency. A separate anonymous fixture generated with the pre-removal WHR engine at `1f24143` pins the entire leaderboard and previous ranks, including weighting, drift, rookie anchoring and participation policy. Failure tests protect publication gating.

The concurrent Act lifecycle migration owns draft SQL, the first soft-lock baseline, live event sourcing and finalization. This change preserves the boundary where finalized played results feed durable WHR recomputation. Shared-file/contract overlap includes `packages/db/src/schema/domain.ts`, migration journal/snapshot numbering, `apps/server/src/trpc/routers/public.ts` and `admin.ts`, recompute and seeding reader contracts, and the web rating/settings surfaces. Resolve migration numbering and generated snapshots together when integrating branches. The UI foundations refactor owns general components and style; rating UI changes here remove model selection/comparison and misleading per-set rating usage.
