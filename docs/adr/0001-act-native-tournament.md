# Act native tournament lifecycle

Status: prototype, explicit opt-in; 4 October 2026. Implements a representative
backend lifecycle for [#64](https://github.com/ashleylamont/smashclub-seeding/issues/64)
and informs #90–93. The approved native-state architecture supersedes older issue
criteria requiring an atomic journal plus authoritative legacy SQL updates.

## Decision

Draft planning stays relational. One `native:<planId>` Act stream owns the event
night after its first soft lock: pools, actual finals draws, results, reports,
entrant availability and shared resources. Actions decide against current state;
reducers only apply persisted decisions. Authentication, guest credentials, player
profiles and WHR computation stay outside this aggregate. Stream version is an
internal commit precondition; match/resource revisions and client catch-up cursor
are separate contracts. Finalization seals results; it never closes, truncates or
archives the Act stream.

Baseline transfer is a SQL transaction that locks the draft, soft-locks it using
existing validation, captures stable identities/settings/frozen ranking inputs
and the chosen pool draw, and inserts an immutable handoff. Ownership starts at
that commit. Legacy tournament writers must fail for owned plans, including while
transfer is pending. A recoverable worker initializes Act idempotently from that
record. A crash cannot let SQL draft editing race an initialized live stream.

Finalization emits an immutable versioned result revision. An at-least-once Act
reaction exports that revision into historical tournaments/participants/sets,
inserts a unique publication receipt and a durable rating intent in one SQL
transaction, then acknowledges publication in Act with explicit concurrency.
Commit followed by process death is safe: retry reads the receipt. SQL failure
leaves no partial history. Recompute intent is acknowledged only after a successful
WHR run; replay itself never recomputes ratings or runs reactions.

## Candidate verification

Review published package source, not only documentation. Current releases are
`@rotorsoft/act` 1.32.3 and `@rotorsoft/act-pg` 1.20.1 (both MIT, including shipped
LICENSE files), with Zod 4.6.5 and Node >=22.23.3. Pin these versions. Act's optional
Vitest peer is for its test helpers; this project does not import `act/test` and
retains its existing runner. The earlier 1.31.0 core **drops expectedVersion on
reaction dispatch**, so it is unsuitable for critical reaction writes. The chosen
release passes that value through. We still retry by reloading current state and
rechecking domain preconditions, never by blindly appending a prior decision.

The published 1.32.3 core also dereferences `snapshot.event.name` when an
idempotent action returns a loaded snapshot without emitting events, if reactions
are registered. `patches/@rotorsoft__act@1.32.3.patch` filters actual commits before
arming reactions/emitting the committed signal in both ESM and CJS distributions.
This is a maintained compatibility patch, not an unmodified-library success claim.
The direct compatibility tests cover no-event retries and explicit expectedVersion
inside a reaction. Do not upgrade/remove the patch without rerunning them.

Snapshots are checkpoints in the retained log, not a replacement for history.
Verify cold loading, independent cache instances, snapshot replay and pure replay
equivalence. Reaction leases, correlation watermarks, retries and blocked-stream
recovery provide delivery, not exactly-once external SQL writes. The publication
receipt supplies that missing idempotency boundary. Disable automatic stream
close. Numeric epoch timestamps avoid the adapter's ISO-string Date revival
changing domain payload types.

Act merge patches interpret null as deletion. The aggregate stores one domain
frame in a singleton tuple so reducers replace the entire frame and preserve
explicit nullable facts. Decided events store changed slices, command/source,
semantic decision basis, causation and correction references. Snapshot/replay tests
compare the unwrapped frame, including nulls, receipts and publication state.

[Act source](https://github.com/Rotorsoft/act-root),
[core package](https://www.npmjs.com/package/@rotorsoft/act),
[PostgreSQL adapter](https://www.npmjs.com/package/@rotorsoft/act-pg).

Direct Drizzle/Postgres could combine journal and SQL writes but would require us
to build replay, snapshots, delivery leases and recovery. Act is selected for the
prototype, conditional on real integration tests. Emmett is excluded because its
license is unresolved. Message DB is not introduced: a second infrastructure
prototype would not prove this selected integration. PGlite remains useful for
domain/SQL handoff tests, but Act-PG uses node-postgres connections, separate
transactions, leases and optional LISTEN/NOTIFY: prove these in an isolated real
PostgreSQL cluster. Do not describe an in-memory Act store as adapter verification.

## Writer inventory and rollout

Existing writers include `service.ts` prepare/update/report/review, native
draw/reset/advancement/finalize, attendance lock/unlock/add/withdraw/redistribute/
reset, controls/live scores/pool settings, station queue/dispatch, self-service
starts, planning roster/placements/bracket links/closure, source refresh and
provider synchronization, and player merge participant repairs. These must either
dispatch an Act action or be blocked for an owned plan. No dual live authority is
permitted. New native transport is isolated under `eventOps.live`; consumers can
migrate incrementally. No default adoption of existing or already-played events:
lost early decisions cannot be fabricated. The first prototype adopts an unplayed
native draft only and retains original SQL rows as frozen planning evidence.

Correction policy remains explicit: preserve actual played opponents, never undo
resource history by a generic dependency link. Same-winner score amendments and
unplayed descendant repair are safe bounded cases. Started descendant winner
changes need a reviewed ruling; post-publication changes require a replacement
result revision plus rating invalidation, not edits to a sealed result. Do not
enable incomplete correction workflows.

Shared changes: server dependencies/lockfile, SQL migration and additive tRPC
namespace, root package metadata/Node minimum and Docker packaging for the pinned
patch and Act's runtime package metadata. React layout/component work belongs to
the parallel UI worktree.

## Verified slice and remaining rollout

The prototype covers an unplayed draft baseline, reporting policy, played scores,
honest forfeits, reports/review/disputes, player availability, shared capacity and
reserved station dispatch, explicit pool orders, chosen native finals, automatic
advancement, lifecycle transitions, sealed results, publication, durable recompute
and recovery. The PostgreSQL suite proves independent-cache concurrency, duplicate
requests, resource contention, ownership races, snapshots, reconstruction, SQL
rollback and post-commit crash/restart. PGlite handoff tests and pure domain tests
remain fast; existing app/domain regression checks pass.

This is not full rollout: the existing UI has no Act adapter; live game progress,
late entrant insertion/redistribution, provider import adoption, guest reporting,
announcements/prizes and result replacement corrections still need dedicated
commands/transports. Legacy writers are guarded rather than silently allowed to
change an owned event. Unlock/relock is journaled but the prototype does not reopen
relational editing or discard/reseed the live draw. Enable no default adoption of
existing events. Next work should migrate those bounded writers and consumers, not
relax ownership guards. Catch-up currently offers a consistent public snapshot and
domain cursor/full resync; incremental delivery is a later transport optimization.
