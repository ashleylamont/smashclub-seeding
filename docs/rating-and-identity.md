# Rating and identity notes

## Results and recomputes

Completed, eligible sets are the rating input. Challonge tournaments are synchronized with idempotent upserts keyed by their external IDs; native Nemesis results enter the same history when an organiser finalizes the event. A set needs resolved players and an event date, and byes, forfeits, excluded matches and ignored result stages do not affect ratings. **Admin → Tournaments** can choose **Auto** (include eligible group and final stages) or **Final stage only** for a Challonge tournament.

Ratings are derived from the full eligible history. Each recompute writes `rating_events` and `player_ratings` under a new `recomputes` row, and canonical readers use the latest completed current-engine WHR recompute. WHR is the sole supported model. Profiles show night estimates and retrospective revisions; match logs carry evidence weights without exact per-set rating deltas. See [WHR design](whr-design.md) and the [cutover guide](whr-only-migration.md).

## Board and seeds

The public leaderboard ranks by **club rating**: skill estimate minus a stated attendance penalty. The penalty has a free missed-night window, then a flat per-night charge up to a cap; returning clears it. It changes published order, not the model's fitted skill. The row shows both skill with its uncertainty band and the deduction. Players absent for more than a year are hidden by default, and ranks and movement are recalculated over the visible field.

This separates club attendance from uncertainty. Ranking directly on a conservative estimate made people with little data fall far down the board even when they had not missed an event. The board now states the missed-night rule explicitly, while seeding still uses uncertainty where a surprising draw has a direct competitive cost. Movement compares with a replay that withholds the latest club night, so it describes that night's results rather than an unrelated later recompute.

Automatic bracket seeding uses a conservative rating that accounts for uncertainty. Its order can therefore differ from the public board, especially for a newcomer or someone returning after a long break. The planner freezes a ranking snapshot before dividing an event, so later recomputes do not silently change its draw. The administrator can review seeds in the planner and seeding workbench.

Uncertainty and attendance are separate: missing events can widen a rating's uncertainty, while the club's attendance policy is an explicit deduction. WHR retains its fitted uncertainty, score-margin evidence weights and optional rookie display policy. The Python CLI in [`legacy/`](../legacy/) is an unsupported historical archive. Settings changes trigger a recompute. The model evaluation harness is available through `pnpm rank-eval`.

## Identity review

The registry stores a canonical player name and known aliases. Sync cleans entrant names and applies an evidence ladder: exact known names or stored decisions, then unambiguous structured short forms. Fuzzy similarity provides candidates but never links on its own. A reviewer can select a player, create one or keep an entrant separate. Decisions persist; short-form inferences are not saved as permanent aliases, so a later ambiguity returns to review.

A bracket display name is upstream input, not proof of identity. Register brackets you recognize and inspect **Admin → Review** and **Admin → Players** for mistaken links. Organisers can reverse them. The event planner uses the same matching rules when resolving an attendance list; parsing the list alone does not create players or aliases.

## Public names and accounts

Public pages use a player's chosen alias. Without one, the default is their first name plus initials for later names (`Fox McCloud` → `Fox M`). Unresolved bracket entrants receive the same shortening from their submitted display name. Canonical names remain in admin workflows for identity review. Public player search matches aliases, while the admin roster can search canonical names and stored aliases. The public route regression tests in `apps/server/test/public-names.test.ts` guard serialized responses against accidental name exposure.

Searching canonical names on a public route would still reveal them indirectly through repeated substring queries, even if responses only showed aliases. A shortened default alias remains usable as a structured short form for bracket matching.

A claimant can set an alias and link providers from `/me`; an administrator can edit aliases under **Admin → Players**. Chosen aliases are unique club-wide. The user account, rather than an email address, is the identity: Discord and Google can be linked to the same account even when they return different emails. [Development and deployment](development.md#configuration) explains first-admin bootstrap and later role management.
