# Run a club night

The planner at **Admin → Event planner** saves the night's roster, seed snapshot, divisions and pools. New plans default to **Nemesis**, which runs pools and final brackets in the app. Choose **Challonge** when the brackets will be managed externally. Existing plans and imported tournament history keep their current mode.

## Prepare the plan

1. **Add attendance.** Paste one entrant per line. Parsing strips list markers and whitespace but does not create player records.
2. **Resolve names.** Select the correct player for each line or create a missing player. Candidate similarity is a review aid, not an automatic identity decision. A corrected spelling applies to this event unless **Remember spelling** creates a lasting alias.
3. **Freeze seeds and divisions.** The planner snapshots the current ranking and fills Upper and Lower, respecting explicit division choices. Review unranked entrants before freezing. Later rating changes do not reorder the saved draw.
4. **Build pools.** The planner stripes entrants across pools, balancing sizes around the selected target (normally four; divisions can have three- to five-player pools). Review allocations and publish the event when attendees should see it.

The plan and its step live in the URL, so an organiser can resume it on another device. Once external brackets are attached or play has begun, roster and seed changes have safeguards; use the attendance controls for late arrivals and withdrawals. [Station waves](pool-station-flow.md) and [pool sheets](pool-floor-sheets.md) cover venue setup.

## Nemesis path

Open **Run event** from the planner. Set up stations and pool queues, assign TOs, and control which pools can play. TOs can start matches, save live game counts, confirm results and review attendee reports. An in-progress score does not become a rating result. Signed-in attendees can report under the event policy; guests use a time-limited QR pass. The public **Event night** hub lists published events and provides pools, queues and results without requiring a login. See [event desk and displays](event-night-refinements.md) and [guest reporting and disputes](guest-event-night.md).

Resolve all pool matches and confirm pool finishing orders in the planner. Ties require an organiser decision. The top half of active entrants in each pool, rounded up (at least two), qualify for championship; the rest enter consolation. Preview the four final draws, then create them. Byes advance without inventing played scores. Confirmed results advance winners, while pending reports wait for the policy or a TO decision.

After the final brackets finish and pending submissions are resolved, **Finalize native results** writes the night's played sets to club history and ratings. Finalization is atomic and repeatable without duplicating results; finalized operations become read-only. Byes, forfeits and no-contests do not count as played games.

## Challonge path

The handoff step provides seed-ordered participant lists, pool cards and a settings checklist for the four external brackets: Upper and Lower championship and consolation. Create them in Challonge, then attach each slug to its plan slot. Keep all four on the same event date, which groups them as one club night for results and rating chronology. Upper and Lower are competitive divisions; neither should be marked as a rookie bracket.

Sync registered tournaments under **Admin → Tournaments**. Results mode defaults to **Auto**, which includes eligible group and final matches. Use **Final stage only** when group matches should not count. Byes, forfeits and excluded matches are ignored. Completed recent imports receive periodic refreshes for corrections; older events can be resynced manually. Attached external brackets can use local queues and station controls, with external score delivery explicitly gated by `CHALLONGE_SCORE_WRITES` and credentials.

If a completed external event diverged from its saved plan, use [historical event adoption](historical-event-adoption.md) to preview and associate the actual imported brackets without rewriting scores.

## Results and analysis

The tournaments list groups brackets from the same event date. Event pages show division standings, eligible pool and bracket records, and recaps. Player profiles show match stages and rating history. **Admin → Breakthroughs** compares actual wins with expectations based on earlier nights; unfinished events are marked provisional. An event's public board and overlay show live operations, while the saved plan remains the record of intended seeds and pool assignments.
