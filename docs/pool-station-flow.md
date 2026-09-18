# Self-running pools and station queues

## Set up once

In the event desk, open **Divide stations between pools**, select the stations and choose how many each pool receives (usually two). Review the proposed groups and waves, then apply them together.

For example, four stations and four pools produce:

| Wave | Pool | Stations |
| --- | --- | --- |
| 1 | Upper A | 1 + 2 |
| 1 | Upper B | 3 + 4 |
| 2 | Lower A | 1 + 2 |
| 2 | Lower B | 3 + 4 |

An active pool reserves its stations. Other pools and bracket matches cannot take them. Later pools can reuse the same stations while on hold. When a pool finishes, its reservation releases automatically. **Open next pools on free stations** activates the waiting pools that fit, preserving other pools still in progress.

Individual pool settings remain available. Batch changes validate the complete proposed allocation and all revisions before writing, so two TOs cannot partially overwrite one another’s setup. Station changes cannot displace a playing match.

## Players run the pool

New station plans for native events enable player starts and immediate score acceptance. Existing schedules retain their previous TO approval policy until explicitly changed. Both options are visible in the setup preview and can be controlled per pool.

1. Open the pool’s player board or scan the existing event QR code and choose a pool. The pool selection stays in the URL for sharing.
2. Find the station marked **Play next**. When both players are there, press **We’re here — start match** from the reporting page.
3. Play the set and submit its final score. In a self-running pool with immediate acceptance enabled, that result is recorded immediately and the queue advances.
4. Follow **Play next** for the newly free station. No per-match TO start or approval is needed.

Signed-in attendees do not need a player profile link. Guests need a valid event QR session. Both routes enforce the same event, pool, station, availability and revision checks. Only the current queued match can be started. Two devices cannot claim the same match or double-book a player/station. Starts and results record the actual signed-in account or guest session in the audit history.

TOs can still correct completed pool results. Existing safeguards prevent changing advancement once downstream finals have started. Forfeits, withdrawals and other exceptional decisions remain TO actions. If immediate acceptance is disabled, a submitted score waits for TO approval and the station remains occupied until approval.

## Understand the queue

The public board and reporting pages are organised around station queues, with pool filters and a collapsible round-robin schedule. The overlay projects upcoming matches for its selected station even while that station is playing.

The round-robin schedule covers every pairing once and shows resting players for odd-sized pools. The ready selection excludes busy or withdrawn players, held matches/pools and unavailable stations. Existing TO station assignments are respected. Current and next matches never allocate the same player twice.

**Coming up** is a provisional order, not a start time or a reservation. It recalculates as results arrive, stations become free or TOs adjust the event. Read-only pages never start a match or save assignments merely by loading.

Adding a late entrant to a completed pool with allocated stations reopens that pool **on hold**, rather than reclaiming a bank that may now belong to another pool. The attendance preview explains this, and the TO can reassign or resume it. Conflicting reservations left by older data suppress queue calls and show a conflict instead of advertising an unstartable match.

## Compatibility and deployment

The feature uses additive migration 0017: opt-in pool policy fields and guest attribution on match audits. Existing pools default to ordinary TO approval. Self-service match starts and automatic score acceptance are limited to native Nemesis pools; Challonge events can use the station allocation and projected queues while retaining their existing result workflow.

No production data was changed during implementation. Unit/integration tests use migrated disposable databases; browser tests use synthetic local events. Real multi-connection PostgreSQL contention is guarded by the event-row transaction lock but is not simulated by PGlite’s single connection.

## Local verification

Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm lint` from the workspace root. After building, the focused Playwright scenarios are `pool-stations.spec.ts` (station banks and wave handover) and `pool-player-flow.spec.ts` (guest/signed-in starts, immediate results, mobile layout and overlay queues). Existing event operations, guest reporting, attendance, native event and display scenarios cover compatibility with the ordinary TO workflow.
