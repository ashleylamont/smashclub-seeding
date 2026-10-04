# Native live backend prototype

The backend slice is explicitly adopted per event. Existing event desks are still
relational consumers: do not adopt a real night until its UI/writers are migrated.
[ADR](adr/0001-act-native-tournament.md) explains the ownership boundary, dependency
patch, tests and outstanding rollout.

Run Node >=22.23.3. The normal PostgreSQL server initializes Act-PG in the
`native_act` schema and starts durable recovery. PGlite's dev harness deliberately
does not create a fake production Act-PG adapter; `eventOps.live` returns a clear
precondition error there. The tests pair PGlite with in-memory Act only for SQL
handoff coverage.

## tRPC contract

| Procedure | Input | Behavior |
| --- | --- | --- |
| `eventOps.live.adopt` | `planId` | Operator-only, first soft lock of an unplayed native draft; freezes SQL ownership, transfers immutable baseline, returns private snapshot. Safe to retry after interruption. |
| `eventOps.live.command` | `planId`, `requestId`, `command` | Server resolves actor/operator access. Deduplication is scoped to actor + request. Response includes receipt/sequence, affected match and publication status. |
| `eventOps.live.snapshot` | `planId`, optional `cursor` | Published public view. Consistent domain cursor; `unchanged` when current, `resync` when a full replacement is needed. No reports, actor history or credentials. |
| `eventOps.live.overview` | `planId` | Operator view includes reports, grouped commands and pending rating intents. |
| `eventOps.live.recover` | `planId` | Operator retries baseline/publication work, unblocks this publication subscription only and returns current status. |

Commands are discriminated by `kind`. The exact schemas live in
`apps/server/src/tournament/schemas.ts`:

- `score`: match ID, expected match revision, played score or a forfeit with null
  games and explicit winner. Decisive played scores infer the winner. A TO can
  record a completed result without dispatching first.
- `review`: report ID, approval/rejection, current match revision. Agreeing reports
  never apply a second result; disputes stay pending for an operator.
- `dispatch`: match revision plus resource revision. Rechecks both players,
  aggregate capacity and optional reserved station together. Dispatch does not
  change the score/pairing revision.
- `availability`, `resources`, `poolResources`, `reporting`: explicit entrant,
  resource or reporting preconditions. Availability includes a recorded reason.
- `placements`: pool revision plus all relevant match revisions, and a complete
  entrant order. No algorithmic tie resolution is implied by a manual order.
- `drawFinals`: persists the selected entrants, slots, parent dependencies and
  match IDs. Replay does not call the draw algorithm.
- `unlock`, `relock`: retained lifecycle decisions for an unplayed live draw.
- `finalize`: seal results exactly once per request. `pending` means the durable
  publication reaction has not acknowledged; `blocked` appears in the snapshot
  after delivery is quarantined; `published` includes historical tournament IDs.
  Pending rating intents are independent of publication acknowledgement.

Match revisions, the resource/reporting revisions, the public domain cursor and
Act's internal stream version have different purposes. Send semantic revisions
with commands; do not send a public cursor as a universal mutation precondition.
The server retries Act contention against freshly loaded state and revalidates
semantic conditions. Guest credentials and other secrets never enter commands.

## Verification and recovery

```sh
pnpm exec vitest run apps/server/test/native-live-domain.test.ts apps/server/test/native-act-runtime.test.ts apps/server/test/native-live-handoff.test.ts
RUN_POSTGRES_TESTS=1 pnpm exec vitest run apps/server/test/native-live-postgres.test.ts
```

The PostgreSQL test suite creates and removes its own temporary cluster/Unix socket;
it never connects to an external `DATABASE_URL`. PostgreSQL `initdb`/`pg_ctl` must be
available. OS sandbox restrictions may require allowing local sockets/shared memory.

A crash before baseline append leaves the frozen SQL handoff; the recovery worker
retries it. SQL publication failures roll back history/receipt/rating intent
together. A crash after commit is deduplicated by the immutable receipt, then Act
records acknowledgement with explicit concurrency. Ratings and intent completion
commit together under the common recompute lock. Replaying the retained log is a
read-only reducer operation and does not touch providers, history, credentials,
notifications or ratings. No Act close/archive/truncate operation is exposed.
