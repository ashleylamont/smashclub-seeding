# UI visual and accessibility review

Run `pnpm --filter @smashclub/web test:ui`. The runner always starts its own fixture server; set `UI_PORT` to choose a free port when another checkout is running. The separate `playwright.ui.config.ts` runs Vite on port 3411 and mocks all `/api/**` requests. It needs no database, OAuth credentials or production account. The real database-backed event flows still run through `pnpm test:e2e`.

The fixture clock, event identity, aliases, stations, match revisions and ordering are fixed. Fonts are self-hosted and loaded before capture; finite animations and inherited color transitions settle before accessibility scans, and screenshot animations are disabled. Fixtures are synthetic rehearsal data with no real guest token or player email. Unexpected tRPC calls are asserted so a page cannot silently start relying on an unhandled response. Null API responses stay null: the OBS fixtures have no guest invitation and explicitly assert that no reporting QR appears. Their four refreshed baselines remove the bogus QR previously caused by converting null into an empty array; the app itself is unchanged.

Coverage includes:

- Gallery in dark and light themes, with pending, disabled, error and success states.
- Dialog labels, validation, focus containment, Escape and focus restoration, including the registry's existing conditional caller.
- Manual tab activation and keyboard help.
- Player phone reporting, tied-score guards, pending submission, revision preservation and retry after loading failure for signed-in and guest users.
- TO desktop and phone destinations, preserved score drafts, refresh, station-to-match focus, cleared drafts when changing broadcast matches and axe accessibility checks.
- Active and idle 1920×1080 OBS composition, transparent gameplay aperture and unclipped `Tech In Place` identity.
- Phone bracket with a bye, unresolved dependency, uneven rounds and a long alias.

The CI job **UI accessibility and visuals** runs Chromium on `macos-14`, matching the committed Darwin snapshot suffix. It contributes to **All checks** and uploads `ui-review` with its HTML report, traces and expected/actual/difference images. Database-backed event tests stay on Linux. Browser and font rendering are platform-dependent; a Linux run needs separately reviewed Linux baselines.

## Reviewing an intentional visual change

1. Run the suite without updating snapshots. Open `apps/web/playwright-report/ui/index.html` or use `pnpm --filter @smashclub/web exec playwright show-report playwright-report/ui`.
2. Compare expected, actual and difference images. Check hierarchy, density, wrapping, focus visibility and status text; on OBS check transparency and the gameplay aperture.
3. Update only the intended fixtures on macOS with `pnpm --filter @smashclub/web test:ui --update-snapshots=all --grep 'test name'`. This writes the actual image even when a small intentional change falls inside the pixel tolerance. The initial baselines were generated locally on macOS; the first CI run confirms runner compatibility.
4. Run the normal suite again. Commit the changed PNGs alongside the component change and explain the reason in the PR. A reviewer approves the images; a passing pixel comparison alone does not approve a redesign.

Pixel tolerance is 0.3% per capture to accommodate small rasterization differences. Broad layout, typography or state changes should produce a failure. Do not increase the tolerance to hide an unexplained difference. Keep baseline updates out of automatic CI steps.

Additional deployment-assurance fixtures cover a populated sixteen-slot bracket in a light surrounding theme at desktop and phone sizes, a busy light TO desk with pending disputes and keyboard tab traversal, phone next-match start with its expected revision, loading/empty feedback, active/idle 1280×720 OBS capture, and an actual downloaded SVG rendered in Chromium. SVG text bounds are checked against the export canvas and the file remains in test results. These eight new images are scoped Darwin baselines, generated and inspected locally; only the four OBS baselines were refreshed for the corrected null-invitation fixture. The event poster and OBS intentionally use a dark palette inside a light app; shared controls must retain readable contrast there.

The current suite is a representative foundation for #88, not exhaustive coverage. Add light-theme event states, finalized result exports, wider bracket sizes and other admin forms as those surfaces migrate. Axe checks WCAG A/AA rules it can automate; manual assistive-technology review remains useful for real event operation.
