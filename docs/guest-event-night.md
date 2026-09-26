# Guest event night and score approval

## Player entry

The main navigation's **Event night** link (`/play`) lists explicitly published events. An unpublished planner draft never appears. An event's player hub (`/play/:planId`) can be opened without an account; the public event board remains at `/live/:planId`.

Players can find their pool, station queues, round schedule, standings and recorded results without signing in. Choosing a player for **My matches** only filters this device's view; it does not verify identity or grant permissions.

Starting eligible self-running matches or reporting scores anonymously still requires the event's QR guest pass. A pass already redeemed on this browser is reused in the player hub. Expiry or revocation removes reporting access while leaving a published event browseable; scan the current QR to renew access. Private QR invitations are not exposed by the public event directory. The TO controls whether a QR appears on the overlay.

## Approve unless disputed

For native Nemesis events, an admin can choose **Score approval → Event score policy → Approve unless disputed** in the event operations page. Existing events retain their previous TO approval / per-pool settings until this is enabled.

- The first valid played score records the result and advances play immediately.
- An identical follow-up confirms the result without advancing or recording it again.
- A differing follow-up becomes a pending conflict. The original result stays recorded, including any matches already advanced from it.
- Completed played matches remain available for attendees to confirm or dispute. This is available to QR guests as well as signed-in attendees with reporting access.
- Byes, forfeits and authoritative corrections remain TO actions.

Score submissions put conflicting reports first and show the recorded and proposed scores. **Keep recorded result** rejects that report; **Use submitted result** attempts the normal TO correction. Existing revision and downstream-play checks still apply: if a later bracket match has started, changing its feeder winner may be blocked. The policy does not rewind a bracket automatically. Pending reports must be resolved before finalizing an event; completed or cancelled events no longer accept submissions or review actions.

The policy overrides per-pool immediate acceptance while enabled. Switching policies does not retroactively select a winner among conflicting pending submissions. A subsequent report matching all current pending submissions can approve them together; a disagreement remains a TO decision.

## Validation and deployment

Database migration `0018_mean_runaways.sql` adds the optional score mode and report provenance/dispute fields, with backward-compatible defaults. Apply the repository's normal database migration process when deploying.

Server regressions cover first reports, duplicate retries, matching confirmations, disagreements, concurrent forms, stale TO edits, switching policy, guest scope and native downstream/finalization guards. Concurrency tests use PGlite serialization; they do not simulate independent production PostgreSQL connections. Production's existing event row lock remains in place.
