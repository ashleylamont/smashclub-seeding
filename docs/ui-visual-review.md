# UI visual and accessibility review

Install Chromium once with `pnpm --filter @smashclub/web exec playwright install chromium`, then run `pnpm test:ui` from the repository root. The runner always starts its own fixture server; set `UI_PORT` to choose a free port when another checkout is running. The separate `playwright.ui.config.ts` runs Vite on port 3411 and mocks all `/api/**` requests. It needs no database, OAuth credentials or production account. The real database-backed event flows still run through `pnpm test:e2e`.

The fixture clock, event identity, aliases, stations, match revisions and ordering are fixed. Fonts are self-hosted and loaded before capture; finite animations and inherited color transitions settle before accessibility scans, and screenshot animations are disabled. Fixtures are synthetic rehearsal data with no real guest token or player email. Each test clones mutable overview extras so report edits cannot leak into another test on the same worker. Unexpected tRPC calls are asserted so a page cannot silently start relying on an unhandled response. Null API responses stay null: the OBS fixtures have no guest invitation and explicitly assert that no reporting QR appears. Their four refreshed baselines remove the bogus QR previously caused by converting null into an empty array; the app itself is unchanged.

Coverage includes:

- Gallery in dark and light themes, with pending, disabled, error and success states.
- Dialog labels, validation, focus containment, Escape and focus restoration, including the registry's existing conditional caller.
- Manual tab activation and keyboard help.
- Player phone reporting, tied-score guards, pending submission, revision preservation and retry after loading failure for signed-in and guest users.
- TO desktop and phone destinations, preserved score drafts, refresh, station-to-match focus, cleared drafts when changing broadcast matches and axe accessibility checks.
- Active and idle 1920×1080 OBS composition, transparent gameplay aperture and unclipped `Tech In Place` identity.
- Phone bracket with a bye, unresolved dependency, uneven rounds and a long alias.

The CI job **UI accessibility and visuals** runs Chromium on `macos-15`, matching the committed Darwin snapshot suffix. The explicit runner replaces `macos-14`, whose [scheduled brownouts and retirement](https://github.com/actions/runner-images/issues/13518) prevent the required job from running. It contributes to **All checks** and uploads `ui-review` with its HTML report, traces and expected/actual/difference images. Database-backed event tests stay on Linux. Browser and font rendering are platform-dependent; a Linux run needs separately reviewed Linux baselines. Runner upgrades retain the existing assertions, baselines and tolerance; review any rendering differences before updating individual images.

## Reviewing an intentional visual change

1. Run the suite without updating snapshots. Open `apps/web/playwright-report/ui/index.html` or use `pnpm --filter @smashclub/web exec playwright show-report playwright-report/ui`.
2. Compare expected, actual and difference images. Check hierarchy, density, wrapping, focus visibility and status text; on OBS check transparency and the gameplay aperture.
3. Update only the intended fixtures on macOS with `pnpm --filter @smashclub/web test:ui --update-snapshots=all --grep 'test name'`. This writes the actual image even when a small intentional change falls inside the pixel tolerance. The initial baselines were generated locally on macOS; the first CI run confirms runner compatibility.
4. Run the normal suite again. Commit the changed PNGs alongside the component change and explain the reason in the PR. A reviewer approves the images; a passing pixel comparison alone does not approve a redesign.

Pixel tolerance is 0.3% per capture to accommodate small rasterization differences. Broad layout, typography or state changes should produce a failure. Do not increase the tolerance to hide an unexplained difference. Keep baseline updates out of automatic CI steps.

Additional deployment-assurance fixtures cover a populated sixteen-slot bracket in a light surrounding theme at desktop and phone sizes, a busy light TO desk with pending disputes and keyboard tab traversal, phone next-match start with its expected revision, loading/empty feedback, active/idle 1280×720 OBS capture, and an actual downloaded SVG rendered in Chromium. SVG text bounds are checked against the export canvas and the file remains in test results. These eight new images are scoped Darwin baselines, generated and inspected locally; only the four OBS baselines were refreshed for the corrected null-invitation fixture. The event poster and OBS intentionally use a dark palette inside a light app; shared controls must retain readable contrast there.

The current suite is a representative foundation for #88, not exhaustive coverage. Add light-theme event states, finalized result exports, wider bracket sizes and other admin forms as those surfaces migrate. Axe checks WCAG A/AA rules it can automate; manual assistive-technology review remains useful for real event operation.


The unified player hub adds fixture checks in `player-event-hub.spec.ts` for printed `/live` and `/guest` aliases, retained pool/player/station context, cold results anchors, phone section navigation and score drafts, offline/stale revision recovery, transport retry identities, signed-in guest access when account reporting is off, account expiry/replacement, and guest permission polling interruptions. The hub embeds pools, brackets and results in the surrounding app theme; `/overlay` retains its standalone broadcast composition. Existing player/empty/station captures and `/live`-based bracket captures can change intentionally as the public routes now reach `/play`. Review those normal macOS CI expected/actual/difference artifacts before updating scoped Darwin PNGs. Linux fixture captures are useful for semantic and accessibility checks but must not replace the Darwin baselines.

Bracket element screenshots use `bracketCaptureOptions` to keep the site navigation in normal document flow during capture. Without this temporary `position: static` override, a tall component capture can include the sticky navigation across the middle of the draw. The navigation remains rendered; normal page captures and the semantic, accessibility and keyboard checks retain production styling. This isolates the bracket image without masking content or changing screenshot tolerances.


## 31 October 2026 consistency audit (#140)

The supplied completed-player screenshot exposed a gap in the earlier component checks: the whole hub combined browser-default blue progress bars, rounded custom navigation, poster spacing, duplicated closed-state feedback and a forced-dark embedded draw. The fix uses shared navigation buttons, labelled `ui/Progress`, app theme tokens and spacing, neutral completed-match chips, one closed-event explanation and archived-result copy. The header/status area is composed as one group rather than many independently spaced grid rows.

Embedded pool, prize and bracket panels now use the surrounding theme and reading fonts. Standalone OBS keeps its intentional event palette. The expanded draw uses an explicit `live-event-brackets` layout scope; it no longer relies on the poster ancestor to override the tournament-list link row's `.event-brackets` flex rules. Phone checks expand the full draw and verify document overflow remains absent.

Recent changes reviewed:

| Surface | Finding and action |
| --- | --- |
| Shared player hub, stage focus and personal journey (#126/#129/#133) | Fixed progress, navigation, spacing, embedded palette, small helper text and completed-state copy. Preserve report receipts, identity boundaries, score drafts and actual progression facts. |
| Main-stage TO side preference (#134) | Reuses shared buttons and public player tuples; dark/light phone/desktop fixture audit covers the live panel and accessibility. Its independent OBS presentation remains intentional. |
| Attendance restore and history (#135) | Reuses shared select/input/button/disclosure/feedback styles. The heading now covers all attendance actions, and a token-spaced rule separates the form from history. Dark/light phone/desktop audit covers the restore selection and chronological-history panel with no write. Durable and real-workflow validation remains with the attendance feature. |
| Forfeit controls (#137) | Reuses the shared TO score-card controls; existing local and CI checks cover cancellation, retries, stale revisions and independent result/live drafts. No new replacement control appearance. |
| OBS recent results (#132) | Dedicated broadcast composition; retain its aperture, character/name/score ownership and 720p/1080p checks rather than applying app-panel styling to it. |

The regression set adds active and completed hubs in both themes at 390px and 1440px, with long aliases, actual expanded feeder paths, read-only results and private report feedback. Completed states have four new full-page Darwin references; all states check accessibility, navigation, native-progress appearance and page overflow. The existing hub, guest/privacy, stage and journey fixtures remain in use. The gallery demonstrates shared progress in both themes.

[AGENTS.md](../AGENTS.md) now points UI changes at these foundations and requires component reuse, whole-route review and expanded-state checks. The native-control lint guard includes `progress`. These checks complement manual image review; passing types, Axe or individual component snapshots alone does not establish a consistent composition. The Top8er results-image redesign is tracked separately in #139, and the TO draw/print launcher is #136.

For #141, normal macOS CI run `41169700632` supplied the review artifacts. Six existing images (two gallery, reporting phone, bracket phone and two populated light brackets) were checked against every expected/actual/difference image; four new completed-hub images were inspected directly. The updates reflect the shared progress example, compact composition, chips and app-themed bracket typography/palette. Only these ten approved Darwin images were copied byte-for-byte. The normal suite is rerun with unchanged assertions and 0.3% tolerance.

Run `41170163975` then passed the unchanged loading/anchor assertions and all other visual cases apart from the newly reached empty-page image. Its expected/actual/difference review confirmed the same intended compact, shared-control composition with retained empty-state explanations; that eleventh Darwin image was copied from the normal CI artifact.

## OBS intermission progress (#83)

The source-local `presentation` choice supports `gameplay` (the existing transparent layout), `auto` (progress until the focused station actually starts play) and `progress` (a deliberate local override). TO Broadcast includes source links, and Display setup edits the current source URL. These choices do not remotely update another browser source or change event/scoring state; persisted remote settings remain #86.

Progress pages cover pool records in groups of six and every native bracket match in adjacent-round sections, retaining actual IDs, public names, source labels and visible feed edges. Long pairs reduce the number of cards per column. `EventBracketLane` supplies the same measured cards/connectors; only its optional window mode normalizes viewport round/slot coordinates and sizes the canvas from actual card bounds. Full public/TO draws retain their existing geometry. Cards scale with 720p/1080p source width.

Rotation choices are 15, 30 or 60 seconds. Visible controls pause/move pages; arrow/Page keys remain available when controls are hidden. Reduced motion makes paging manual. Poll interruptions retain last-known data with the existing interruption badge. Completed/cancelled and empty events use factual summaries. Pools remain review records, not manufactured confirmed seeds. Native and pool pages are covered; richer linked-upstream bracket scenes and remote TO overrides remain follow-ups in #83/#86.

The regression set covers 720p/1080p pool and DE/reset scenes with long pairs, all-match coverage and actual content bounds, timers/pause, call-versus-start handoff, source-local override, reduced motion and interrupted polling. Existing default bracket geometry and recent TO fixtures are retained. A real TO and independent public OBS browser rehearsal verifies call → actual start → official result transitions, transparent active gameplay, source choices surviving reload and unchanged match revisions/results when presentation changes. Normal macOS references are reviewed before scoped updates.

Normal macOS run `41174165092` passed all 100 existing/interactive cases and differed only because four new 720p/1080p pool/bracket references did not exist. All four actual images were manually inspected before byte-for-byte Darwin copies. Final fixtures also check text bounds for titles, captions, records and card labels. The normal suite is rerun with the same assertions and 0.3% tolerance.

The final #143 visual run passed all new scenes but exposed a two-pixel scroll-offset race in the existing phone Start/draft screenshot. That capture now waits for font/layout readiness and centers the same station action after editing, rather than restoring an earlier timing-dependent scroll position. Its original image and reporting/revision/draft assertions remain intact; the normal suite is rerun.
