# Running a night entirely in Nemesis

New plans default to **Nemesis** in the Bracket system selector. Existing plans and imported tournament history retain Challonge mode. There is no automatic conversion of a historical event or an in-progress external draw.

## Event desk

1. Paste and resolve the roster, freeze divisions, generate pools, then open **Run event** and prepare the match queue.
2. Add named stations or a numbered batch. The station board shows which setups are free and which match is playing.
3. Under **Pool queues and stations**, allocate each pool to stations and turn off **Allow this pool to play now** for later waves. No allocation means any available station. **View pool matches** opens that pool's queue.
4. **Ready to start** requires known, available players and a free eligible station. Waiting cards explain the blocker. With stations configured, starting an unassigned match automatically chooses a free eligible station.
5. **Update live score** saves game counts (including 0–0 and ties) while the match remains in progress. **Finish match** confirms a result, releases its station, and advances a native bracket. Live scores never create rating results.
6. Review attendee submissions before they become official. Signed-in attendees can report any open match without a player link. Guest QR passes remain available. Corrections and forfeits remain TO actions.

TOs share the event desk using their assigned account. Revision checks reject conflicting edits and preserve score drafts for explicit reload. The desk polls every 2.5 seconds; public displays poll every 5 seconds.

## Pools to finals and club results

Resolve all pool matches and confirm finishing orders in the planner. Ties need an explicit organiser decision. The top two active entrants per pool qualify for championship; the remaining active entrants enter consolation.

**Preview finals** displays the four single-elimination draws before creation. Byes advance automatically without inventing played scores. Confirmed results advance winners; pending player reports do not. Unplayed draws can be removed and rebuilt; downstream play prevents unsafe feeder corrections.

When all championship and consolation brackets finish and submissions are reviewed, **Finalize native results** publishes the night's pool and finals results into existing tournament history and club ratings. Finalization is atomic and repeatable without duplicating results. Finalized operations are read-only. Byes, forfeits and no-contests do not count as played games for ratings.

Native history is excluded from both Challonge schedulers and explicit external synchronization. External events retain their separate integration section. Player identity merges involving a frozen or running event are blocked until the event is closed, protecting its roster and result identities.

## Public displays

The public event page includes station occupancy, live pool standings, pool progress and allocations, native bracket rounds, results and prizes. Live pool tables are provisional; confirmed pool order remains the advancement authority. Character mains use the existing player character assignments and public names.

The overlay uses the shared Nemesis mark, station-specific current match, game score, other station matches, recent-result animation and timed announcements. Open **Display setup** to choose the station; the URL preserves that choice. Press **S** to show or hide setup, and **Escape** to close it.

For OBS, add the overlay as a 1920 × 1080 browser source **above** the gameplay source and fit gameplay underneath its transparent 16:9 centre. Add `controls=0` to hide the setup button on load.

For a standalone browser screen, explicitly choose a shared window/screen or camera/capture card in setup, then fullscreen the display. Video remains local and stops when capture is closed or the page unmounts. This mode is video-only; OBS should handle stream audio. Capture requires HTTPS or localhost and a supported browser/device. Tests simulate browser media streams; physical capture-card and venue audio testing remains a rehearsal task.

## Invitations and announcements

A displayed QR invitation remains valid for 60–75 minutes. It rotates every 15 minutes while earlier invitations continue to work until their own expiry. Scanning creates a separate one-hour guest reporting session. Expired or revoked passes direct the attendee to scan the current screen's QR code. Turning guest reporting off or rotating access revokes existing passes.

Announcements default to five minutes in the TO form, with one-, ten- and thirty-minute options. Expired messages leave the public feed automatically.

## Migration and review

Migration `0016_broken_zarda.sql` adds native draw dependencies, native provider/mode markers, live scores, pool schedules and announcement expiry. Existing rows default to Challonge; no result data is rewritten. Migration and all rehearsals were run on disposable local databases, not production.

Implementation was split across local Worktrunk branches for event controls, native brackets and displays. Each branch was reviewed before integration into `codex/event-night-refinements`; independent review also covered withdrawals, feeder corrections, native sync protection and identity merges.

## Verification

- Full suite: 785 passed, 2 existing skipped, across 62 passing test files.
- Workspace typecheck, production build and lint pass. Vite retains the existing bundle-size warning.
- Thirteen browser scenarios passed across targeted runs: planner and URL recovery, uneven-pool confirmation, two TOs, player approval, stale/rejected drafts, 390px TO scoring, guest QR/revocation, historical adoption, public display/capture, native draw presentation, unlinked attendee reporting, station/live-score/pool holds, and native finalization into public club results.
- Native finalization also passed at 390px with no page-level horizontal overflow; desktop, mobile and overlay screenshots were inspected.
- Independent review fixes include reset after withdrawal, premature feeder byes, paused downstream correction safety, no-contest progression, imported participant changes retaining old live scores, and initial pool-schedule conflicts.
