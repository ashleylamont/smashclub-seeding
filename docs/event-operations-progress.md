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
- [x] Editable draft settings and uneven pools/advancement
- [x] Late changes, withdrawals and safe post-start reconciliation
- [x] Four-bracket match queue and station assignments
- [x] Concurrent TO scoring, stale revision conflicts, idempotency and audit
- [x] Optional own-match player reporting and approval
- [x] Challonge write adapter or explicit verified manual reconciliation
- [x] Public event page, announcements, OBS display
- [x] Configurable prizes and downloadable results graphics
- [x] Representative whole-night fixture and development demo
- [x] Final integrated browser rehearsal and revised visual checks
- [x] Final integration review and local handoff

## Evidence
Before implementation: 115 targeted existing planner/results tests passed. Public tournament listing retrieved read-only from nemesis.ashl.dev for reference; raw data is outside the repository.

## Progress
Initial worktrees created and bounded assignments dispatched. Implementation underway.

### First review checkpoint
Planner changes integrated after diff review (5d2e8fb); 204 targeted tests passed on source branch. Public display/overlay and SVG graphics integrated (416c509); 45 web logic tests passed on source branch. Full integrated verification pending backend merge.

Read-only upstream API investigation: Challonge's official v1 documentation explicitly states that v1 has no two-stage tournament support (https://challonge.apidog.io/about-1726725m0). Existing client is v1. New operations must show local/pending/manual-reconciliation status and cannot label locally entered group scores delivered through an unsupported API. v2.1 write integration remains a separate implementation/verification task.


### Integrated rehearsal checkpoint
- 729 unit/integration tests across 55 files pass, including uneven pools, attendance previews, score revision conflicts, permissions, player approvals, source imports and delivery recovery.
- Workspace typecheck and lint pass. Web production build passes.
- Four browser regressions passed before the visual redesign: two TOs and player approval; stale player draft; rejected report resubmission; narrow-screen TO scoring. Final browser rerun follows the redesign.
- The development harness seeds an 18-player event with 5/4-player pools in both divisions, a completed confirmed pool, an active Stage match, stations, announcements, awards, an assigned TO and a claimed player account.
- Challonge v2.1 score adapter implements identity validation, preflight read, explicit write and post-write verification. Delivery is disabled by default with `CHALLONGE_SCORE_WRITES=false`; all write tests use mocks. No live Challonge writes have been attempted.
- All linked brackets can now be refreshed together using public reads. Partial failures preserve existing results. Manual score handoff remains available.
- Interrupted outbound requests have a GET-only reconciliation action. Verified outbound scores also update the imported local record, preventing later preparation from restoring stale scores.
- Advancement confirmation includes both match and placement revision checks. Withdrawn entrants retain played history and are excluded from newly confirmed advancement.
- User requested more creative broadcast design. The overlay is being revised from generic cards into a bone/ink/vermilion poster treatment with a transparent 16:9 capture aperture and a focused Stage scoreboard.

### Operating limits for review
- Shared screens poll every 2.5 seconds for TOs and 5 seconds for spectators; this is near-real-time polling, not a websocket transport.
- Local score records and linked Challonge brackets have explicit separate delivery state. Live upstream writes still need a disposable tournament rehearsal before enabling them for a real night.
- Late roster changes cannot automatically rewrite an in-progress Challonge bracket. The UI previews affected local matches and requires acknowledgement of external reconciliation.
- TOs confirm tied pool placements explicitly. There is no automatic invention of tiebreaker games or scores.
- Player reporting requires an approved player claim and TO approval; it is opt-in per event.
- OBS composites the capture card as a separate source beneath the transparent browser overlay. The web page does not ingest the capture card.
- Result exports are downloadable SVGs using confirmed placements. Top8er is visual inspiration; no Top8er API dependency has been introduced.
- No production data was mutated and nothing has been deployed. All accounts and rehearsal scores are synthetic local data.


### Final local review checkpoint
- Revised overlay visually inspected at 1920×1080 with a populated Stage match; NEMESIS title and all three queue entries fit. Capture aperture is transparent and 16:9. Public board inspected at 390px; no horizontal overflow.
- 27 unique browser scenarios verified across the main run and focused reruns: event operations (4), attendance (1), planner (2), existing public/admin/claim flows (20). Two legacy assertions were updated to distinguish advancement headings and omit a verification badge from the compared player name; the existing rematch warning assertion now uses its current wording.
- After the 729-test full-suite pass, final changed areas passed 38 targeted tests: planner (33), display helpers (3), and real PostgreSQL concurrency (2). The two-connection ownership test demonstrated the former failure against the old implementation and passed with the shared tournament lock.
- Final workspace typecheck and lint pass. Web production build passes (existing large-bundle warning remains).
- All agent changes were inspected and integrated on the local worktree branch. No merge into the original checkout and no deployment.
- The rehearsal server is left running at port3311. See `docs/event-operations-review.md` for exact links, synthetic accounts, OBS setup and the remaining operating limits.


### Guest reporting and broadcast result follow-up
- Added optional anonymous/unlinked guest submissions using 15-minute QR invitations and revocable one-hour guest passes. Every guest report stays pending until a TO approves it.
- Added hashed session storage, per-event scope, expiry/revocation checks, durable redemption/submission limits and idempotency. Guest credentials use fragments and POST bodies; public snapshots do not expose secrets.
- Optional overlay QR, independently enabled from guest reporting, preserves the gameplay aperture and on-deck list. QR codes are generated locally with no external service.
- Official results have timestamps, enabling a chronological recent-results strip and eight-second animated outcome banners. Corrections are distinguished, old results do not replay on reload, and reduced-motion disables movement.
- Independent review identified report-history ordering and cross-event notification state; both were addressed before integration.
- Full suite: 743 passed, with the two opt-in PostgreSQL cases then run separately and passing against the new migrations. Workspace build, typecheck and lint pass. Browser rehearsal additionally covers real QR decoding at display size, anonymous/unlinked reporting, rejection and retry, approval, revocation, reduced motion and separation from the capture area.
