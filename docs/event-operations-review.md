# Local tournament operations review

Everything is on `codex/event-operations` in `.worktrees/codex-event-operations`. Main and production were not changed.

## Open the rehearsal

Start the local rehearsal at http://127.0.0.1:3311 using the command below. The server prints fresh event links on startup. The links below refer to the last local review session and may change after restart.

- [Event control](http://127.0.0.1:3311/admin/event-operations?plan=cc77a595-1e27-47f4-8051-e7a81bfe9f91)
- [Public event board](http://127.0.0.1:3311/live/cc77a595-1e27-47f4-8051-e7a81bfe9f91)
- [OBS overlay](http://127.0.0.1:3311/overlay/cc77a595-1e27-47f4-8051-e7a81bfe9f91?station=Stage)
- [Player score reporting](http://127.0.0.1:3311/play/cc77a595-1e27-47f4-8051-e7a81bfe9f91)

All local passwords are `devpassword123`:

| Account | Role |
| --- | --- |
| admin@smashclub.dev | Administrator and planner |
| organiser@smashclub.dev | Assigned event TO |
| rehearsal-player@smashclub.dev | Claimed player, score submissions |
| player@smashclub.dev | Unclaimed account for the existing claim flow |

These synthetic accounts exist only in the local harness. Its database resets when the process restarts, and event URLs change. New URLs print on startup.

## Suggested rehearsal

1. Open control as admin. The event has eighteen entrants in four uneven pools: five/four in each division. One pool is finished and confirmed, with a Stage match underway elsewhere.
2. Open a second browser profile as the assigned TO using `/operate/<planId>`. Record scores and watch the other desk refresh. Try recording a stale score draft; it must require review.
3. Submit a score as the rehearsal player. Approve or reject it from a TO desk. Player reports do not immediately become official results.
4. Use the Ready filter, assign a station and start a match. Occupied stations and players already playing cannot be double-booked.
5. Preview a late arrival into a four-player pool. Existing assignments and completed scores remain intact. Withdraw an entrant and explicitly resolve outstanding forfeits, then reconfirm pool advancement.
6. Publish an announcement and award multiple prizes. Check the event board and the OBS view.
7. In the planner, inspect championship qualifiers and the consolation draw, including byes. Export the handoff for the four brackets. Refresh all linked sources from event control after updating Challonge.
8. Download a results graphic from confirmed pool standings or completed tournament results. Unfinished matches never imply final placements.

## OBS

Add the overlay URL as a 1920×1080 browser source above the capture card. Default gameplay aperture is approximately x=384, y=140, width=1498, height=842 (16:9). Position/scale the capture source underneath it. The overlay itself is transparent in that region.

`?station=Stage` focuses the scoreboard on that station; station IDs also work. The sidebar selects distinct available players. Screens refresh every five seconds. The treatment is bone, ink and vermilion, with condensed typography and a club-poster layout.

## Restart locally

From this worktree:

```sh
pnpm install --frozen-lockfile
pnpm --filter @smashclub/web build
PORT=3311 WEB_DIST_DIR="$PWD/apps/web/dist" pnpm dev:harness
```

## Deliberate limits

- Direct Challonge score writes are disabled by default. The v2.1 adapter is implemented and mock-tested, but has not written to a real tournament. Use a disposable upstream event to rehearse before enabling `CHALLONGE_SCORE_WRITES`.
- Attached upstream rosters need manual reconciliation after late attendance changes. Nemesis explains that step and preserves local history.
- Before play, reset an unplayed queue and reopen the roster to reshuffle. Once play has started, additions and withdrawals preserve pool membership; moving a played entrant between pools is not supported.
- Late arrivals use existing active player records. Create a new player through the existing admin workflow first if needed.
- Tie resolution and final pool order remain explicit TO decisions.
- Linked-player reporting and guest reporting are separate opt-in settings. Guest reporting needs no login or player link; all guest submissions require TO approval.
- The broadcast does not capture video itself; OBS composites it.

See [implementation evidence](event-operations-progress.md) for the review and test record.


## Guest reporting and live outcomes

In event control, enable **Allow guest score reports**, then **Generate guest QR**. Anyone holding the invitation can propose a played match score, including logged-out visitors and logged-in accounts without a player claim. Byes, forfeits and corrections remain TO actions.

Invitations rotate on 15-minute boundaries. Scanning exchanges the invitation for a one-hour event-scoped guest pass stored in that browser tab. **Revoke all guest passes** invalidates invitations and existing passes immediately; disabling guest reporting also revokes them. Only hashes of guest session credentials are stored in the database. Bearer values travel in URL fragments and POST bodies, not query strings. Guest reports are labelled separately in the approval queue and have duplicate, stale-revision and submission-limit protection.

**Show a rotating QR on the OBS overlay** is a separate option. Stream viewers can scan it too. Keep it off to share invitations only at the venue. The demo enables both options on its synthetic event, while newly created events default to off. QR links use the site's current origin; for an actual phone scan, open the site at an address reachable from that phone.

The overlay's bottom strip now lists the three most recent confirmed results. A new result triggers an eight-second animated `GG!` banner confined to that strip. Corrections use `CORRECTED`; byes and forfeits are described as such. Several arriving results are queued, opening/reloading the overlay does not replay old wins, and reduced-motion preferences remove the animation. The announcement returns after the result banner.
