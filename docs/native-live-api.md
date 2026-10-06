# Native live tournament API

Native live events use Act by default through the existing event APIs. There is
no opt-in adoption endpoint. [The ADR](adr/0001-act-native-tournament.md) describes
ownership, migration, concurrency and publication.

Run Node >=22.23.3. Production initializes Act-PG in the `native_act` schema and
recovers legacy native nights before accepting traffic. The PGlite development
harness uses an isolated in-memory Act runtime for the same application APIs.

## Standard application API

`eventOps.softLockPools` establishes the immutable SQL handoff and transfers the
chosen draw into Act. A first native desk score/control operation also establishes
this boundary automatically. Anonymous guests cannot initiate a fresh handoff.
Once owned, native events require the runtime and cannot fall back to SQL writes.

The existing `eventOps` snapshot/overview, score/review/progress, station/pool,
attendance, publication settings, announcement and prize procedures use Act.
Player and guest self-service recheck authenticated access outside the aggregate
and submit credential-free domain commands. Native planner reads, pool orders,
finals preview/generation/reset and event close operations use the same state.
Draft setup and global identity/access remain relational.

Player and guest reporting open once the organiser locks the pool draw. A valid
guest pass is independent of the signed-in player-reporting switch; its validated
access is captured as guest attribution without recording the bearer credential.

Standard mutations accept their existing preconditions; live progress has a
separate progress revision, station controls can send a resource revision, and
publication settings can send a reporting revision. Mutations based on a plan
also accept an optional `requestId`; reuse the same ID for a transport retry.
Scores require their existing actor-scoped request ID. Pool orders retain all
relevant match revisions and a pool placement revision. Attendance and finals
apply a reviewed preview token.

## Direct command and recovery API

| Procedure | Behavior |
| --- | --- |
| `eventOps.live.command` | Authenticated actor plus `planId`, `requestId`, `command`; resolves organiser access and returns a receipt, sequence and publication status. |
| `eventOps.live.snapshot` | Published view with optional domain `cursor`; returns `unchanged` or full `resync` metadata. No reports, actor history or credentials. |
| `eventOps.live.overview` | Operator view with reports, grouped commands and pending rating intents. |
| `eventOps.live.recover` | Operator retries pending transfer/publication, unblocks this publication subscription and returns status. |

Commands are discriminated by `kind`; schemas are in
`apps/server/src/tournament/schemas.ts` and `commands.ts`:

- Results: `score`, `review`, `progress`. Played scores infer a decisive winner;
  forfeits have null games and an explicit winner. Byes come from the recorded
  draw. Agreeing reports do not apply a second result; disputes require review.
- Scheduling: `dispatch`, `matchControl`, `resources`, `poolResources`,
  `configurePools`, `station`. Match and resource preconditions protect dispatch;
  scheduling and placement revisions are distinct.
- Attendance and policy: `availability`, `attendance`, `reporting`. Attendance
  captures a new entrant's identity facts and applies a reviewed preview.
- Draw and lifecycle: `placements`, `poolOrders`, `drawFinals`, `resetFinals`,
  `resetQueue`, `unlock`, `relock`, `cancel`. Unlock means pause for an unplayed
  Act-owned draw; SQL editing stays frozen. Chosen draws and dependencies are
  persisted, so replay does not call the draw algorithm.
- Communications: `announce`, `prize`.
- Publication: `finalize`, `replaceResult`. Replacement names the current result,
  its corrected match revisions and a ruling reason. It retains actual opponents
  and the draw and publishes a new revision through the same durable reaction.

Publication status is `pending`, `blocked` or `published`; published includes
historical tournament IDs. Rating-intent completion is independent of the
publication acknowledgement. The desk exposes both statuses and a recovery
control, plus a reviewed score/forfeit correction form on sealed native events.

Stream version, semantic revisions and the public domain cursor have different
purposes. Do not send a cursor as a universal mutation precondition. Incremental
transport delivery can be added independently; current clients receive consistent
replacement snapshots from authoritative state.

## Verification and recovery

```sh
pnpm exec vitest run apps/server/test/native-live-domain.test.ts apps/server/test/native-act-runtime.test.ts apps/server/test/native-live-handoff.test.ts apps/server/test/native-live-cutover.test.ts
pnpm test:postgres
pnpm --filter @smashclub/web exec playwright test --project=desktop native-event.spec.ts event-attendance.spec.ts guest-event-discovery.spec.ts event-night-reporting.spec.ts
```

The PostgreSQL suite creates and removes a private temporary cluster and Unix
socket; it never connects to an external `DATABASE_URL`. `initdb`/`pg_ctl` must be
available. Local OS restrictions may require allowing sockets/shared memory.

A crash before baseline append leaves the frozen handoff for the recovery worker.
SQL publication failures roll back history, receipt and rating intent together.
A post-commit crash is deduplicated by the immutable receipt; Act then records the
acknowledgement. Ratings and intent completion commit together under the common
recompute lock. Replay is a read-only reducer operation and never calls providers,
changes history, touches credentials or triggers ratings/notifications. No stream
close/archive/truncate operation is exposed.
