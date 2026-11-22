# Deployment assurance

PRs run **CI**. Main pushes, version tags and manual publication run the full reusable CI through **Publish**, then publish only after every required job succeeds. Branch protection should require **All checks** on PRs.

## Affected checks on pull requests

The **Changeset** job summary reports affected pnpm workspaces and their dependents, the checks it authorized skipping, and any further candidates that still run. It compares the tested merge tree against its first parent and verifies the second parent matches the PR head. Moves across scopes count both paths. On PRs, the **Typecheck** job runs the full typecheck and then adds a bounded, advisory **Preview Nx affected tasks** step. It reports which package typechecks and unit suites Nx would select for the same comparison. **Unit tests** runs the full suite, and Publish runs both full checks.

Web-only and prose-only PRs skip **PostgreSQL integration** and **Legacy Python tests**. Prose covers repository Markdown guidance, Markdown under `docs/` and Changeset notes. Visual, bundle, and production-image checks still run. Browser event flows and their report also run, with a deferral for validated version-only PRs until Publish verifies the exact main commit. A change outside the isolated scopes, including workspace configuration, migrations, or workflow scripts, runs the full suite. Set the repository Actions variable `CI_REPORT_ONLY` to `true` to keep the summaries and run every check on PRs.

## Required contracts

- **Unit tests:** engine, shared policy, UI logic, server/PGlite and workflow policy contracts. WHR uses deterministic synthetic histories and an independently solved two-player reference. Corrections, evidence weights, night-boundary estimates against independent history-prefix fits, uncertainty, input ordering and convergence exhaustion are checked. A warmed three-sample median of a 1,440-set / 24-night history must stay under five seconds; local measurements are around 130 ms. This generous budget catches catastrophic regressions on shared runners, not small timing differences.
- **PostgreSQL integration:** PostgreSQL 17, explicitly selected. CI uses `postgres:17.10-bookworm` in disposable, randomly named containers with random localhost ports. Locally, `initdb`/`pg_ctl` major 17 use a private Unix socket and disable TCP. Each file owns and removes its cluster. No external database URL is accepted. Deliberate row-lock barriers wait for independent transactions to block before release, ensuring the tests exercise contention rather than merely calling promises together.
- **Migration upgrades:** real historical journals through migrations 0010, 0018 and 0020, followed by the current complete journal. Synthetic identities, historical results, result-stage policy, untouched/played/explicitly locked draws, uniqueness and foreign keys must survive as appropriate. New connections reapply the normal migrator without duplicating ledger entries.
- **Lifecycle:** soft-lock retries preserve assignments; reopening connections preserves committed state; unsafe feeder corrections fail after downstream play starts. Injected database failures roll back both report and event finalization. Concurrent finalizers and retry after reconnection create one durable history, while byes/forfeits advance but never invent rated games. WHR recomputations produce identical player ratings from durable results.
- **Production image runtime:** builds `deploy/Dockerfile`, uses its production-only dependencies as the unprivileged `node` user, boots against PostgreSQL 17, upgrades a synthetic pre-stage-aware database, exercises health, public identity API/privacy, anonymous auth/admin boundaries, frontend assets and deep links, then restarts and repeats probes. The internal Docker network prevents external provider calls. Logs are retained on both success and failure.
- **Browser event flows** rehearse the real API on Ubuntu. **UI behavior and accessibility** runs portable fixture cases in three Ubuntu shards, and **UI accessibility and visuals** runs the fixture cases with Darwin baselines on macOS. Each job retains its diagnostic artifacts. [UI review](ui-visual-review.md)

- **Server bundle boots:** preserves the original missing-`DATABASE_URL` environment-validation check, which catches module-load failures independently of the image check.

The portable UI jobs have a 20-minute budget including checkout, dependencies,
browser installation, discovery, execution and artifact upload. The named
**Install portable UI browser** and **Run portable UI shard** steps print elapsed
wall time with Bash `time`; the same steps run on PRs and exact-main Publish
verification. Compare both steps rather than attributing the whole job to tests.
All three portable jobs must report a common disjoint and exhaustive shard plan,
match the Darwin case-set digest and pass every assigned case on the first attempt.

This budget follows the [#370 first-attempt timeout](https://github.com/ashleylamont/smashclub-seeding/actions/runs/42761702568/job/129648662811):
browser installation took 2m 49s and shard execution used 12m 09s before the job
was cancelled, with 187 of 196 cases passed and no failed assertions. The
[same-commit retry](https://github.com/ashleylamont/smashclub-seeding/actions/runs/42761702568/job/129654058370)
installed the browser in 20s and passed all 196 cases in 10.1m. On the later
[exact-main Publish run at d3bae24](https://github.com/ashleylamont/smashclub-seeding/actions/runs/43514940681),
installation took 20s/28s and the complete runner steps took 8m 00s/9m 23s for
shards 1/2 and 2/2 respectively. Five additional job minutes leave room for the
observed slow setup and execution together without changing test selection,
workers, per-test timeouts, retries or image baselines. Verify future changes on
both a PR and its exact-main Publish run using the named step timings.

**All checks** rejects failed, cancelled, missing and unexpected skipped jobs. The two optional PR jobs and the version-only browser deferral require an explicit plan from a successful **Changeset** job. The browser deferral must apply to both the event flows and their report. Publish requires every job to pass. `pnpm test:postgres` additionally validates its JUnit report: all named required suites must appear and no tests may be skipped. Missing binaries, wrong PostgreSQL major, missing Docker, migrations or an empty/skipped suite fail the command.

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

Publish can verify up to two ordinary builds alongside one numbered release. The final hexadecimal digit of an ordinary main commit's SHA assigns it to one of two queues by parity. Manual builds share the existing ordinary queue with even SHAs. Version-changing main pushes and version tags share the original main queue, so releases already waiting there keep their place. If classification fails, the build joins the original queue and still runs full CI. One registry job writes tags at a time.

Publication supports main pushes, `vMAJOR.MINOR.PATCH` tags whose commits are on main's history, and manual runs selecting main. Other manual refs, invalid version names and commits outside main are rejected before registry login. Every publication gets `sha-<full 40-character SHA>`. Current main also gets `main`; superseded runs get only their immutable commit tag. Full versions get `MAJOR.MINOR.PATCH`. Major/minor aliases and the former short SHA aliases are deliberately omitted to avoid ambiguous or out-of-order release tags. Consumers using short SHA aliases should move to full SHA or digest pins.

One publication job at a time writes tags. It reads current main after verification/loading, so an older run that finishes late cannot roll the main tag back over a newer commit. A newly pushed main commit is published after its own gates pass. Tag names should never be moved to a different commit. Main/version/dispatch decisions and failed/skipped/missing gate behavior have fast structural/policy tests in `test/ci/deployment-gates.test.ts`.

## Native journal compatibility and rollback

An image rollback is supported only when the target image can read **every persisted
native event, embedded command and state field** in the database, and its SQL schema
is compatible with the applied migrations. A lower application version or an unchanged
`DecisionRecordedV1` event name does not establish that compatibility. For example,
#366 added `renameDoublesPair` to the command union inside existing decision schemas;
a pre-rename reader rejects that decision even though its top-level event version
is unchanged (V2 in the regression fixture). New decision versions, legacy imports
and sealed results can introduce other boundaries. Treat a new durable command as a rollback boundary unless the
candidate older reader has been verified against it.

Before deploying a release that adds durable facts:

1. Record the running image's immutable full SHA tag or digest, the candidate image,
   applied migration ledger and a restorable database backup. Keep the original
   journal, handoffs, publication receipts and rating intents together. Test any
   restore on an isolated database; CI does not prove your backup is restorable.
2. Rehearse the candidate on an isolated copy using its normal migration and native
   recovery startup path. Exercise the new command on synthetic events with recorded
   play. Compare replayed scores, actual opponents, frozen seeds and audit history;
   include sealed results/publication when that release affects them.
3. If rollback must remain available after the new command, test the **specific older
   image** against that updated copy, including full original-journal replay and
   history reads. A healthy process or a successfully loaded checkpoint alone is
   insufficient: checkpoints can bypass the unsupported historical decision. Do not
   infer rollback support from the PR's green checks or the currently tested image.
4. Use the single-replica `Recreate` deployment strategy. Do not run old and new
   writers together. Once new facts have been written, retain a capable image as the
   recovery candidate rather than automatically selecting the preceding version.

If the older image rejects a stream, stop the failed rollout and retain the database.
Redeploy the last image that understands all recorded facts, or ship a forward fix
that retains those readers. Startup awaits `nativeRuntime.recover()` before opening
the HTTP listener; verify recovery finishes, compare full replay/history with the
retained evidence, and retry interrupted requests with their original IDs and payloads.
This preserves the new decision and the earlier scores, seeds and audit record.

Do not delete, rewrite, truncate, rename or silently skip unsupported journal rows,
reset an event, or remove checkpoints as a normal rollback procedure. Those operations
do not make an incompatible reader safe. Restoring an earlier backup loses later
recorded play unless a separate, explicitly reviewed reconciliation plan preserves
it; it is disaster recovery, not an ordinary image rollback. SQL down-migrations
are likewise not implied by switching the image.

The mandatory `doubles-postgres.test.ts` contract writes a real scored doubles
stream, proves the command reader without `renameDoublesPair` accepts it before the
rename and rejects the new embedded discriminator afterward, and checks that rejection
changes no journal rows. A cold current runtime then runs production's recovery path,
replays the original history and retries the rename without changing recorded scores,
frozen baseline or journal rows. This isolates the pre-#366 schema boundary using
Zod's real discriminated-union validation; it is not execution of a historical image,
a Kubernetes rollback, or a database-backup rehearsal. Repeat the release-specific
image/copy checks above before claiming an older image is supported.

## Scope and remaining integration

Production's PostgreSQL major is not declared in this repository; 17 matches the available development runtime and is the tested deployment contract. Confirm the database operator's major before adopting the gate; test it explicitly if different. These checks do not test database backup restoration, real OAuth credentials, real external-provider outages, Kubernetes rollout or a second active replica.

The merged Act runtime is covered by the mandatory `native-live-postgres.test.ts` suite. It uses the same disposable-cluster helper and fail-on-skips report policy as the other PostgreSQL suites. It exercises independent-cache concurrency and idempotency, resource contention, ownership transfer, replay, failed publication rollback, process restart and durable publication recovery. PGlite rehearsals and browser recovery scenarios exercise the real application API with an in-memory journal; only the PostgreSQL suite exercises Act-PG durability. Production-image smoke checks verify startup and HTTP boundaries; they do not replace this native lifecycle coverage. See [native live API](native-live-api.md) for the storage, publication and recovery contracts.

The checkpoint-loss regression removes one paused draw's derived checkpoints in the disposable cluster, including the latest checkpoint at the stream head. A cold runtime reproduces its canonical and public state from the original journal rows, returns the existing withdrawal receipt on retry, and appends one relock decision after the surviving authoritative head.

PR and publication verification both run `ci.yml`. A passing PR can still miss a timing-dependent failure in an identical merge tree. Recovery coverage therefore forces an empty cold-start claim to overlap a persisted retry becoming due, and checks a remote seal after the polling worker has gone idle with notifications disabled. The pinned Act compatibility patch makes explicit `correlate()` polling re-arm discovery and draining; internal background settling retains its idle optimization. Keep these contracts when upgrading Act.

Browser acknowledgement-loss interception handles individual procedures within tRPC batches. A poll and a retry can share a POST in either order: only the read envelopes are held stale, and mutation inputs and real receipts are selected by procedure index. Fast transport tests cover both orders on every PR, alongside the real browser retry/idempotency flow. Do not disable batching, add blanket retries or increase deadlines to conceal these schedules.
