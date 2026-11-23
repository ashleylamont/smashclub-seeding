# Rating and identity notes

## Results and recomputes

Completed, eligible sets are the rating input. Challonge tournaments are synchronized with idempotent upserts keyed by their external IDs; native Nemesis results enter the same history when an organiser finalizes the event. A set needs resolved players and an event date, and byes, forfeits, excluded matches and ignored result stages do not affect ratings. **Admin → Tournaments** can choose **Auto** (include eligible group and final stages) or **Final stage only** for a Challonge tournament.

Ratings are derived from the full eligible history. Each recompute writes `rating_events` and `player_ratings` under a new `recomputes` row, and canonical readers use the latest completed current-engine WHR recompute. WHR is the sole supported model. Profiles show night estimates and retrospective revisions; match logs carry evidence weights without exact per-set rating deltas. See [WHR design](whr-design.md) and the [cutover guide](whr-only-migration.md).

## Board and seeds

The public leaderboard ranks by **club rating**, which subtracts any attendance penalty from the current skill estimate. The penalty follows the club's configured grace period, per-night charge, and cap. Returning clears it. Each row shows the skill estimate, its uncertainty, and any deduction. When rookie anchoring applies, the current skill estimate moves toward the player's starting estimate. The nightly profile breakdown shows the WHR fit before that adjustment.

Rankings hides players who last played six months ago or earlier by default. When this removes players, **Active rank** and movement use the remaining field. Turn off **Hide inactive** to see **Published rank**, the position in the full rated field that also appears on player profiles. When no players are inactive, Rankings shows **Published rank** with the setting on or off. Search, company, and sort controls retain the rank in the selected field.

This separates club attendance from uncertainty. Ranking directly on a conservative estimate made people with little data fall far down the board even when they had not missed an event. The board now states the missed-night rule explicitly, while seeding still uses uncertainty where a surprising draw has a direct competitive cost. Movement compares with a replay that withholds the latest club night, so it describes that night's results rather than an unrelated later recompute.

Automatic bracket seeding uses a conservative rating that accounts for uncertainty. Its order can therefore differ from the public board, especially for a newcomer or someone returning after a long break. The planner freezes a ranking snapshot before dividing an event, so later recomputes do not silently change its draw. The administrator can review seeds in the planner and seeding workbench.

Uncertainty and attendance are separate: missing events can widen a rating's uncertainty, while the club's attendance policy is an explicit deduction. WHR retains its fitted uncertainty, score-margin evidence weights and optional rookie display policy. The Python CLI in [`legacy/`](../legacy/) is an unsupported historical archive. Settings changes trigger a recompute. The model evaluation harness is available through `pnpm rank-eval`.

### A bracket win and the rating gap

On 29 September 2026, Player A beat Players B and C 2–1 in singles and placed first in their bracket. Player A's raw WHR gap to Player B narrowed from 103.5 to 66.6 points, and their gap to Player C narrowed from 37.1 to 21.1 points. Player A moved from 49th to 39th in **Published rank**. Players B and C had published ranks of 30 and 32 after the night.

The offline replay fitted the archived eligible sets once using only earlier nights and once including that night. The second fit reproduced the archived board. Player B's legacy profile showed +83.1 points, which combined +25.7 from the night and +57.4 from a revision to earlier estimates. Returning to play also cleared Player B's separate 120-point attendance deduction.

On **Head to head**, **Skill gap by night** compares raw estimates before and after all rated sets on a shared night. On **Rankings**, **How to read the board** defines **Tournament placing** as your finish in a bracket or division and **Bracket seed** as your starting position in a draw. Automatic rating-based seeding uses the saved skill estimate and its uncertainty from the draw's rating snapshot.

## Identity review

The registry stores a canonical player name and known aliases. Sync cleans entrant names and applies an evidence ladder: exact known names or stored decisions, then unambiguous structured short forms. Fuzzy similarity provides candidates but never links on its own. A reviewer can select a player, create one or keep an entrant separate. Decisions persist; short-form inferences are not saved as permanent aliases, so a later ambiguity returns to review.

A bracket display name is upstream input, not proof of identity. Register brackets you recognize and inspect **Admin → Review** and **Admin → Players** for mistaken links. Organisers can reverse them. The event planner uses the same matching rules when resolving an attendance list; parsing the list alone does not create players or aliases.

## Public names and accounts

Public pages use a player's chosen alias. Without one, the default is their first name plus initials for later names (`Fox McCloud` → `Fox M`). Unresolved bracket entrants receive the same shortening from their submitted display name. Canonical names remain in admin workflows for identity review. Public player search matches aliases, while the admin roster can search canonical names and stored aliases. The public route regression tests in `apps/server/test/public-names.test.ts` guard serialized responses against accidental name exposure.

Searching canonical names on a public route would still reveal them indirectly through repeated substring queries, even if responses only showed aliases. A shortened default alias remains usable as a structured short form for bracket matching.

A claimant can set an alias and link providers from `/me`; an administrator can edit aliases under **Admin → Players**. Chosen aliases are unique club-wide. The user account, rather than an email address, is the identity: Discord and Google can be linked to the same account even when they return different emails. [Development and deployment](development.md#configuration) explains first-admin bootstrap and later role management.
