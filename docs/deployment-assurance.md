# Deployment assurance

PRs run **CI**. Main pushes, version tags and manual publication run the same reusable CI through **Publish**, then publish only after every required job succeeds. Branch protection should require **All checks** on PRs. This change does not configure repository branch protection or deploy anything.

## Required contracts

- **Unit tests:** engine, shared policy, UI logic, server/PGlite and workflow policy contracts. WHR uses deterministic synthetic histories and an independently solved two-player reference. Corrections, evidence weights, night-boundary estimates against independent history-prefix fits, uncertainty, input ordering and convergence exhaustion are checked. A warmed three-sample median of a 1,440-set / 24-night history must stay under five seconds; local measurements are around 130 ms. This generous budget catches catastrophic regressions on shared runners, not small timing differences.
- **PostgreSQL integration:** PostgreSQL 17, explicitly selected. CI uses `postgres:17.10-bookworm` in disposable, randomly named containers with random localhost ports. Locally, `initdb`/`pg_ctl` major 17 use a private Unix socket and disable TCP. Each file owns and removes its cluster. No external database URL is accepted. Deliberate row-lock barriers wait for independent transactions to block before release, ensuring the tests exercise contention rather than merely calling promises together.
- **Migration upgrades:** real historical journals through migrations 0010, 0018 and 0020, followed by the current complete journal. Synthetic identities, historical results, result-stage policy, untouched/played/explicitly locked draws, uniqueness and foreign keys must survive as appropriate. New connections reapply the normal migrator without duplicating ledger entries.
- **Lifecycle:** soft-lock retries preserve assignments; reopening connections preserves committed state; unsafe feeder corrections fail after downstream play starts. Injected database failures roll back both report and event finalization. Concurrent finalizers and retry after reconnection create one durable history, while byes/forfeits advance but never invent rated games. WHR recomputations produce identical player ratings from durable results.
- **Production image runtime:** builds `deploy/Dockerfile`, uses its production-only dependencies as the unprivileged `node` user, boots against PostgreSQL 17, upgrades a synthetic pre-stage-aware database, exercises health, public identity API/privacy, anonymous auth/admin boundaries, frontend assets and deep links, then restarts and repeats probes. The internal Docker network prevents external provider calls. Logs are retained on both success and failure.
- **Browser event flows** and **UI accessibility and visuals:** real API event rehearsals plus deterministic isolated visual fixtures. See [UI review](ui-visual-review.md). Existing screenshots, traces and baselines are retained.
- **Server bundle boots:** preserves the original missing-`DATABASE_URL` environment-validation check, which catches module-load failures independently of the image check.

**All checks** rejects failed, cancelled, skipped or missing mandatory dependencies. `pnpm test:postgres` additionally validates its JUnit report: all five named required suites must appear and no tests may be skipped. Missing binaries, wrong PostgreSQL major, missing Docker, migrations or an empty/skipped suite fail the command.

## Run locally

```sh
fnm install && fnm use # optional fnm setup using .node-version
pnpm install --frozen-lockfile
pnpm dev:doctor
pnpm test
pnpm test:postgres # PostgreSQL 17 initdb and pg_ctl on PATH
POSTGRES_TEST_CONTAINER=1 pnpm test:postgres # Docker alternative, same CI image
pnpm test:image # Docker; builds the actual Dockerfile
pnpm --filter @smashclub/web exec playwright install chromium
pnpm test:ui
pnpm test:e2e # includes a fresh frontend build
```

`SMOKE_IMAGE=existing-local-image pnpm test:image` checks an already-built image. `SMOKE_LOG_DIR` changes the diagnostic output directory; defaults are `test-results/image` and `test-results/postgres.xml`. Do not point tests at production. If a process is forcibly killed, remove its `smashclub-test-*` / `smashclub-smoke-*` containers; ordinary errors and interrupts clean up automatically. `RUN_POSTGRES_TESTS` no longer controls these required suites; ordinary `pnpm test` excludes `*-postgres.test.ts` so fast tests need no database installation.

Historical fixtures use the checked-in migration SQL and truncated real journal, not handcrafted modern schemas masquerading as upgrades. Add a representative historical boundary when a new data migration introduces a materially different transition. Keep all fixture identities and provider records synthetic.

## Browser transport recovery

`pnpm --filter @smashclub/web test:e2e event-recovery.spec.ts` exercises eight isolated native-event scenarios through the real API and merged Act runtime. Each test copies only the synthetic rehearsal roster into its own locked event and uses independent authenticated/guest browser contexts. The browser harness remains PGlite plus in-memory Act; the required PostgreSQL job separately covers durable storage and true database contention.

- Lost acknowledgements: the real guest mutation commits before Playwright drops its response. Previously received snapshots are temporarily held so polling cannot hide the retry. Pending-approval and automatic-result modes reuse the exact request ID/payload, return the same receipt, and produce one report and Act decision with the expected score revision; reload recovers the recorded state.
- Disconnection: actual browser offline/online events retain guest and signed-in player drafts across station dispatch, require a TO to reopen a score made stale by another TO, and recover missed board/OBS results without reloading. Known offline state pauses queries without setting a fetch error, so event pages explicitly mark cached data and block score/start controls during the interruption.
- Competing browsers: transport barriers hold two actual UI submissions before either reaches the server. Conflicting TO scores and competing guest station starts return one success and one conflict, show the server's reason to the losing browser, and append only one domain decision. Both clients converge; a second station pairing must not start.

The browser runner always owns its harness. Set `E2E_PORT` to a free port when another checkout is running. No production accounts, external providers, snapshot tolerance changes or automatic screenshot updates are needed.

## Publication guarantees and tags

Verification has only `contents: read`; registry credentials are available only to the dependent publication job. No fork PR or `pull_request_target` trigger publishes. Publish downloads the image artifact from its own reusable CI invocation, checks its OCI revision against the full event SHA, and pushes those exact tested image bytes. It never rebuilds a different image after validation.

Publication supports main pushes, `vMAJOR.MINOR.PATCH` tags whose commits are on main's history, and manual runs selecting main. Other manual refs, invalid version names and commits outside main are rejected before registry login. Every publication gets `sha-<full 40-character SHA>`. Current main also gets `main`; superseded runs get only their immutable commit tag. Full versions get `MAJOR.MINOR.PATCH`. Major/minor aliases and the former short SHA aliases are deliberately omitted to avoid ambiguous or out-of-order release tags. Consumers using short SHA aliases should move to full SHA or digest pins.

One publication job at a time writes tags. It reads current main after verification/loading, so an older run that finishes late cannot roll the main tag back over a newer commit. A newly pushed main commit is published after its own gates pass. Tag names should never be moved to a different commit. Main/version/dispatch decisions and failed/skipped/missing gate behavior have fast structural/policy tests in `test/ci/deployment-gates.test.ts`.

## Scope and remaining integration

Production's PostgreSQL major is not declared in this repository; 17 matches the available development runtime and is the tested deployment contract. Confirm the database operator's major before adopting the gate; test it explicitly if different. These checks do not test database backup restoration, real OAuth credentials, real external-provider outages, Kubernetes rollout or a second active replica.

The merged Act runtime is covered by the mandatory `native-live-postgres.test.ts` suite. It uses the same disposable-cluster helper and fail-on-skips report policy as the other PostgreSQL suites. It exercises independent-cache concurrency and idempotency, resource contention, ownership transfer, replay, failed publication rollback, process restart and durable publication recovery. PGlite rehearsals and browser recovery scenarios exercise the real application API with an in-memory journal; only the PostgreSQL suite exercises Act-PG durability. Production-image smoke checks verify startup and HTTP boundaries; they do not replace this native lifecycle coverage. See [native live API](native-live-api.md) for the storage, publication and recovery contracts.
