# UI visual and accessibility review

Run `pnpm --filter @smashclub/web test:ui`. The separate `playwright.ui.config.ts` runs Vite on port 3411 and mocks all `/api/**` requests. It needs no database, OAuth credentials or production account. The real database-backed event flows still run through `pnpm test:e2e`.

The fixture clock, event identity, aliases, stations, match revisions and ordering are fixed. Fonts are self-hosted and loaded before capture; screenshot animations are disabled. Fixtures are synthetic rehearsal data with no real guest token or player email. Unexpected tRPC calls are asserted so a page cannot silently start relying on an unhandled response.

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

The current suite is a representative foundation for #88, not exhaustive coverage. Add light-theme event states, finalized result exports, wider bracket sizes and other admin forms as those surfaces migrate. Axe checks WCAG A/AA rules it can automate; manual assistive-technology review remains useful for real event operation.
