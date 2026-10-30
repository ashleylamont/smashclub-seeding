# Shared match dispatch

The native TO desk can run ordinary setups as a concurrency count, with only key
stations such as Main stage tracked by name. Pool membership determines opponents
and qualification, not the setup on which a set must be played.

## Set up the night

Lock the native draw, then open **Run matches → Use a flexible shared match
queue**. Enter **Ordinary concurrent matches** and select any existing stations
that should remain separately reserved. Selecting a named station subtracts it
from the initial ordinary count until you explicitly edit that count. Review the
combined count before confirming.

The change records one native command. It releases future pool-to-station
reservations, keeps existing results and active match identities, and preserves
pool holds and score policies. An active set on an old ordinary station retains
its original station fact and gets that station's name as its call location. It
counts as ordinary occupancy; it is not moved to Main stage. Existing imported
or captured nights retain their station-bank behavior until this deliberate
conversion. Fresh nights offer shared setup as the primary Run matches action.

After setup, capacity controls sit in the **Capacity and named stations** disclosure so current calls and pairings lead the desk.

Ordinary capacity and named stations are independent. One ordinary setup plus
Main stage permits one ordinary call and one Main stage set at the same time.
Adding or renaming a named station does not change the ordinary count. Disable
an idle named station to stop future use; finish or release its active set first.
Named stations can be renamed from the same setup panel.

Lowering ordinary capacity never discards active sets. The desk shows any excess
and refuses further ordinary calls until occupancy is below the new cap. Named
stations continue to use their own availability.

## Call, play and release

**Ready and waiting pairings** is a private TO view. It distinguishes known
opponents from unknown qualifiers, held pools, unavailable players, occupied
capacity and score reports awaiting review. Search or change Queue view to
inspect waiting pairings. A pending score report holds that pairing for review
without consuming a setup; rejecting it restores readiness.

**Call ordinary match** reserves one ordinary slot and both players, including
the members of a doubles pair. An optional call location is a human instruction,
not another tracked resource. The call appears on public/player screens, but the
suggested order and snoozing information do not.

A call does not claim that play occurred. **Return untaken call** releases its
slot without creating actual-play evidence. **Mark playing** is optional for
ordinary sets; live score entry also records actual play. **Start named station**
is an explicit start suitable for Main stage and broadcast. Returning a set that
has actually started releases its resources while retaining its actual-play and
live-score facts; it does not undo a result or make an unsafe bracket correction
permissible. Recording a result releases occupancy normally. Reporting UI
improvements that remove older self-run Start prerequisites are tracked in #53.

Calls survive unrelated score updates. If a feeder correction legitimately
changes an unplayed called pairing, its call is released; corrections cannot
silently replace opponents once actual downstream play exists.

## Suggestions and availability

The default order uses five-minute waiting bands, oldest first, based on the
later of pairing readiness and either entrant's last completed set. Within a
band, matches feeding a later round come first, then exact waiting time and
stable draw order. Newer ready work cannot displace an older waiting band.
**Move up / Move down** records an explicit TO ordering override. Suggestions are
not reservations or promised start times; dispatch always rechecks the current
pairing, holds, pending reports, members and resource state.

**Player availability and pool holds** supports manual snooze/return for an
entrant or individual doubles member. Snooze lasts until a TO marks them back.
It does not withdraw the entrant or stop other pairings. A playing/called
entrant must release their current set before snoozing. Pools can be held or
resumed independently without station banks.

Qualification remains a separate dependency: this feature does not fabricate
finals opponents or remove the current native all-pools finals-generation gate
tracked in #75/#76.

## Contracts and compatibility

- The existing Act command boundary supplies atomic member/resource checks,
  actor-scoped retry receipts and replay. There is no second scheduling store.
- `configureDispatch` selects ordinary capacity and reserved station IDs with a
  resource revision. It preserves existing active match facts. `queueMove` uses
  a separate queue revision, so changing a suggestion does not invalidate an
  otherwise current dispatch.
- Shared ordinary dispatch records `started: false`, `calledAt` and optional
  `callLocation`. `beginPlay`, explicit named starts and live progress record
  actual play. Match score revisions remain independent of dispatch.
- Optional settings/match fields preserve old journal facts. Replay folds the
  recorded decisions; it does not rerun the queue or reconvert old baselines.
  No relational migration is required for these additions.
- `eventOps.overview.operatorDispatch` and `eventOps.live.dispatchDesk` are
  operator-only. Both normal and direct public snapshots exclude queue order,
  private actor history and snooze notes. Shared public views expose actual
  calls and avoid projecting a mandatory next-station queue.
- External Challonge events retain their existing station/provider workflow.

## Verification

The native dispatch domain/API tests exercise counts, membership, pending score
review, holds, call versus actual-play facts, public privacy, exact retries and
legacy conversion/replay. The required native PostgreSQL suite includes competing
calls from independent stores, a simultaneously occupied Main stage, capacity
reduction and restart/replay. The browser `shared-dispatch.spec.ts` rehearses
desktop and phone setup, ordering, Main stage, public calls, snooze/return,
focused scoring, overflow and accessibility against the real disposable API.
