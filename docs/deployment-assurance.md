# Deployment assurance

PRs run **CI**. Main pushes, version tags and manual publication run the same reusable CI through **Publish**, then publish only after every required job succeeds. Branch protection should require **All checks** on PRs. This change does not configure repository branch protection or deploy anything.

## Required contracts

- **Unit tests:** engine, shared policy, UI logic, server/PGlite and workflow policy contracts. WHR uses deterministic synthetic histories and an independently solved two-player reference. Corrections, evidence weights, ledger continuity, uncertainty, input ordering and convergence exhaustion are checked. A warmed three-sample median of a 1,440-set / 24-night history must stay under five seconds; local measurements are around 130 ms. This generous budget catches catastrophic regressions on shared runners, not small timing differences.
- **PostgreSQL integration:** PostgreSQL 17, explicitly selected. CI uses `postgres:17.10-bookworm` in disposable, randomly named containers with random localhost ports. Locally, `initdb`/`pg_ctl` major 17 use a private Unix socket and disable TCP. Each file owns and removes its cluster. No external database URL is accepted. Deliberate row-lock barriers wait for independent transactions to block before release, ensuring the tests exercise contention rather than merely calling promises together.
- **Migration upgrades:** real historical journals through migrations 0010, 0018 and 0020, followed by the current complete journal. Synthetic identities, historical results, result-stage policy, untouched/played/explicitly locked draws, uniqueness and foreign keys must survive as appropriate. New connections reapply the normal migrator without duplicating ledger entries.
- **Lifecycle:** soft-lock retries preserve assignments; reopening connections preserves committed state; unsafe feeder corrections fail after downstream play starts. Injected database failures roll back both report and event finalization. Concurrent finalizers and retry after reconnection create one durable history, while byes/forfeits advance but never invent rated games. WHR recomputations produce identical player ratings from durable results.
- **Production image runtime:** builds `deploy/Dockerfile`, uses its production-only dependencies as the unprivileged `node` user, boots against PostgreSQL 17, upgrades a synthetic pre-stage-aware database, exercises health, public identity API/privacy, anonymous auth/admin boundaries, frontend assets and deep links, then restarts and repeats probes. The internal Docker network prevents external provider calls. Logs are retained on both success and failure.
- **Browser event flows** and **UI accessibility and visuals:** real API event rehearsals plus deterministic isolated visual fixtures. See [UI review](ui-visual-review.md). Existing screenshots, traces and baselines are retained.
- **Server bundle boots:** preserves the original missing-`DATABASE_URL` environment-validation check, which catches module-load failures independently of the image check.

**All checks** rejects failed, cancelled, skipped or missing mandatory dependencies. `pnpm test:postgres` additionally validates its JUnit report: all four named required suites must appear and no tests may be skipped. Missing binaries, wrong PostgreSQL major, missing Docker, migrations or an empty/skipped suite fail the command.

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:postgres # PostgreSQL 17 initdb and pg_ctl on PATH
POSTGRES_TEST_CONTAINER=1 pnpm test:postgres # Docker alternative, same CI image
pnpm test:image # Docker; builds the actual Dockerfile
pnpm --filter @smashclub/web test:ui
pnpm --filter @smashclub/web build
pnpm test:e2e
```

`SMOKE_IMAGE=existing-local-image pnpm test:image` checks an already-built image. `SMOKE_LOG_DIR` changes the diagnostic output directory; defaults are `test-results/image` and `test-results/postgres.xml`. Do not point tests at production. If a process is forcibly killed, remove its `smashclub-test-*` / `smashclub-smoke-*` containers; ordinary errors and interrupts clean up automatically. `RUN_POSTGRES_TESTS` no longer controls these required suites; ordinary `pnpm test` excludes `*-postgres.test.ts` so fast tests need no database installation.

Historical fixtures use the checked-in migration SQL and truncated real journal, not handcrafted modern schemas masquerading as upgrades. Add a representative historical boundary when a new data migration introduces a materially different transition. Keep all fixture identities and provider records synthetic.

## Publication guarantees and tags

Verification has only `contents: read`; registry credentials are available only to the dependent publication job. No fork PR or `pull_request_target` trigger publishes. Publish downloads the image artifact from its own reusable CI invocation, checks its OCI revision against the full event SHA, and pushes those exact tested image bytes. It never rebuilds a different image after validation.

Publication supports main pushes, `vMAJOR.MINOR.PATCH` tags whose commits are on main's history, and manual runs selecting main. Other manual refs, invalid version names and commits outside main are rejected before registry login. Every publication gets `sha-<full 40-character SHA>`. Current main also gets `main`; superseded runs get only their immutable commit tag. Full versions get `MAJOR.MINOR.PATCH`. Major/minor aliases and the former short SHA aliases are deliberately omitted to avoid ambiguous or out-of-order release tags. Consumers using short SHA aliases should move to full SHA or digest pins.

One publication job at a time writes tags. It reads current main after verification/loading, so an older run that finishes late cannot roll the main tag back over a newer commit. A newly pushed main commit is published after its own gates pass. Tag names should never be moved to a different commit. Main/version/dispatch decisions and failed/skipped/missing gate behavior have fast structural/policy tests in `test/ci/deployment-gates.test.ts`.

## Scope and remaining integration

Production's PostgreSQL major is not declared in this repository; 17 matches the available development runtime and is the tested deployment contract. Confirm the database operator's major before adopting the gate; test it explicitly if different. These checks do not test database backup restoration, real OAuth credentials, real external-provider outages, Kubernetes rollout or a second active replica.

PR #100's Act implementation remains independent and is not imported here. It already contains opt-in `native-live-postgres.test.ts`, replay, cutover and recovery coverage. On merging that work, adapt its cluster helper to this disposable-container contract, remove its skip gate, and require its suite in `postgres-report-policy.mjs`. Reconcile the current synchronous finalizer and correction/revision contracts with Act's outbox/recovery behavior; do not claim future Act replay or exactly-once rating-intent behavior is covered by the current-main tests. The new current-main tests exercise connection restart, not an Act store process crash. The production image gate should then run unchanged against the merged runtime and additive migrations.
