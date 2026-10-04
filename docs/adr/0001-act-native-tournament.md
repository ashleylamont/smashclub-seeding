# Act native tournament lifecycle

Status: accepted and implemented; 4 October 2026. Implements the native-state
architecture for [#64](https://github.com/ashleylamont/smashclub-seeding/issues/64)
and the live tournament work in #90–93.

## Decision

Act is the authority for every native event night from its first pool lock or
first desk play/result operation. There is no adoption flag or alternate native
live backend. The existing desk, player, guest, live page and planner APIs resolve
live state from the same `native:<planId>` aggregate.

SQL owns draft planning before this boundary, global player identity and access,
guest credentials, published historical results and WHR computation. External
Challonge workflows retain their provider-specific implementation. Native live
state has one owner: Act owns entrants, attendance, pools, chosen pairings and
finals, scores and progress, reports, station scheduling, publication settings,
announcements, prizes, lifecycle and sealed result revisions.

Actions decide against current state. Events persist the facts chosen by those
actions; reducers apply those decisions without rerunning algorithms or fetching
current profile/rating data. Replay preserves actual opponent IDs, stations,
entrant orders and the chosen finals tree. Finalization retains the stream; no
close, archive or truncate operation is exposed.

## Ownership and migration

The boundary is a SQL transaction that locks the plan, validates and locks the
chosen pool draw, captures stable identities and ranking inputs, and inserts an
immutable handoff. Ownership starts when that transaction commits. Database
triggers reject legacy planning and operational writes from then on, including
while transfer into Act is pending. Transfer is idempotent and recoverable after
an interruption. Play cannot commit through the old SQL native writer first.

Startup recovers outstanding handoffs and automatically imports existing native
nights that have a lock, reports, play, finals or completed results. Import records
one `LegacyStateImportedV1` event with actual state. Original SQL match and
attendance audit is retained as imported evidence; migration does not fabricate
past commands. A completed night receives a receipt referencing its existing
history without republishing sets or requesting a new rating run. Historical
archive adoptions remain historical records.

An unplayed live draw can pause and resume. Pause retains ownership and the full
journal; attendance and resource commands can adjust it under Act. It does not
reopen SQL roster editing. Actual play, progress or reports prevent destructive
queue/finals resets. Withdrawal holds a pool match for an explicit organiser
forfeit; two withdrawn opponents produce a recorded no-contest without invented
games. Automatic finals advancement records its dependencies.

## Concurrency and requests

Act's internal stream version is a commit precondition, separate from semantic
match, progress, pool placement, scheduling, resource and reporting revisions.
Actions retry internal contention against fresh state and recheck semantic
preconditions. An unrelated announcement does not invalidate a score. Resource
checks combine station reservations, shared capacity and both players' current
availability in one decision.

Receipts deduplicate by actor and request identifier. Reusing an identifier with
a different intent fails. Standard transports preserve the original request hash
when supplying fresh internal preconditions, and generated entity IDs are stable
for explicit request IDs. Guest tokens and credentials never enter the journal.

## Results and recovery

Finalization seals an immutable result revision. A durable Act reaction exports
that revision into historical tournaments, participants and sets, inserts its
unique publication receipt and a rating intent in one SQL transaction, then
acknowledges publication in Act with explicit concurrency. A failure before commit
rolls everything back. A crash after commit retries against the receipt.

Reviewed corrections require the current published revision, match preconditions
and a ruling reason. They create a new sealed result and retain actual opponents
and the draw. Earlier result receipts and history remain available for audit;
public event results and recaps resolve the latest receipt, including from an old
result link. Prior sets are excluded from ratings, and recomputation independently
filters superseded revisions so manually changing an old exclusion cannot count
both. Global identity redirects apply to historical exports while the journal
retains the identities that actually entered the event.

WHR recomputation and rating-intent acknowledgement share a transaction and the
normal recompute lock. The worker retries pending transfer, publication and rating
work. The desk shows publication and rating status and exposes publication
recovery. Recovery unblocks only the event's publication subscription.

## Runtime and dependency decisions

Production uses Act-PG in the `native_act` PostgreSQL schema, with a cache scoped
to each runtime. The isolated PGlite development harness pairs its SQL store with
in-memory Act; both disappear when the harness stops. It is not the production
persistence implementation. Node >=22.23.3 is required by the pinned dependency.

Pinned dependencies are MIT-licensed `@rotorsoft/act` 1.32.3 and
`@rotorsoft/act-pg` 1.20.1, with Zod 4.6.5. The tracked pnpm patch fixes the
published Act release's no-event/idempotent-action crash when reactions are
registered, in both ESM and CJS distributions. Remove it only after a verified
upstream fix. The aggregate wraps full state in a tuple so Act's merge-patch
folding preserves explicit null clears. Server packaging includes Act's required
package metadata; the container uses the required Node release.

## Verification

Pure domain tests cover decisions and replay. PGlite tests cover SQL ownership,
handoff, standard API cutover, attendance, guest access, pause/resume, corrections,
effective public history and completed legacy imports. Real PostgreSQL/Act-PG
tests cover independent caches, contention, ownership races, duplicate requests,
snapshots, reconstruction, publication rollback and crash recovery. Browser tests
exercise the shipped native desk and public results, attendance, guest discovery
and score reporting. See [API and recovery notes](../native-live-api.md).
