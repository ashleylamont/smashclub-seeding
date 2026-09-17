# Tournament operations implementation

## Objective
Build the agreed local event-running hub: flexible attendance and pools; four-bracket control; concurrent TO scoring; optional player reports; match queue and stations; live public/OBS display; prizes and results graphics; safe stage handover and integration with Challonge.

## Local review workflow
Integration branch: `codex/event-operations`.
Worktrees live under the original checkout's `.worktrees/` directory.
- `codex/flexible-pools`: planner and lifecycle invariants.
- `codex/live-scoring`: persisted operations API and concurrency/permissions tests.
- `codex/event-display`: spectator/OBS/results presentation.
Root owns organiser/player UI, integration, cross-branch review, realistic fixtures and full rehearsal.
No production mutations, deployment or external announcements are part of the local rehearsal.

## Decisions
- Preserve four-player pool allocation exactly; new uneven divisions use balanced 3–5 player pools.
- Top two from each pool advance; remaining entrants enter consolation. Explicit TO confirmation resolves ties.
- Local score submissions have visible delivery state, not an implied successful Challonge write.
- Player reports are opt-in and require TO confirmation initially.
- Public outputs expose aliases only; unpublished operations are not public.
- OBS uses a transparent browser overlay over a separate capture source.

## Acceptance checklist
- [ ] Editable draft settings and uneven pools/advancement
- [ ] Late changes, withdrawals and safe post-start reconciliation
- [ ] Four-bracket match queue and station assignments
- [ ] Concurrent TO scoring, stale revision conflicts, idempotency and audit
- [ ] Optional own-match player reporting and approval
- [ ] Challonge write adapter or explicit verified manual reconciliation
- [ ] Public event page, announcements, OBS display
- [ ] Configurable prizes and downloadable results graphics
- [ ] Representative whole-night fixture and development demo
- [ ] Automated unit/integration/Playwright validation and visual checks
- [ ] Review all agent diffs and integrate locally

## Evidence
Before implementation: 115 targeted existing planner/results tests passed. Public tournament listing retrieved read-only from nemesis.ashl.dev for reference; raw data is outside the repository.

## Progress
Initial worktrees created and bounded assignments dispatched. Implementation underway.

### First review checkpoint
Planner changes integrated after diff review (5d2e8fb); 204 targeted tests passed on source branch. Public display/overlay and SVG graphics integrated (416c509); 45 web logic tests passed on source branch. Full integrated verification pending backend merge.

Read-only upstream API investigation: Challonge's official v1 documentation explicitly states that v1 has no two-stage tournament support (https://challonge.apidog.io/about-1726725m0). Existing client is v1. New operations must show local/pending/manual-reconciliation status and cannot label locally entered group scores delivered through an unsupported API. v2.1 write integration remains a separate implementation/verification task.
