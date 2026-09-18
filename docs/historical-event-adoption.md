# Adopting an event played outside the planner

Use **Event planner → Open plan → Choose historical brackets** when an event has
already finished and the imported brackets describe what happened more accurately
than the saved roster or pool plan.

Choose the four completed, synced tournaments, then preview the adoption. The
preview shows the existing and proposed links, participant counts, planned entrants
missing from the imports, additional imported entrants, division changes and
unresolved identities. Apply only after reviewing that comparison. A changed plan
or import requires a fresh preview.

Adoption changes bracket membership and marks the plan complete. It records who
applied it, when, the previous links and the reviewed comparison. Corrections use
the same preview flow and retain earlier adoption records.

The original roster, division seeds, pool assignments and placements remain as
archived planning intent. Adoption does not create operational matches, invent pool
finishing orders, resolve player identities, resync Challonge or change imported
scores, tournament dates, result modes or rating settings. Event results and recaps
read the imported brackets. Subsequent corrections to an imported result continue
to use the existing tournament administration tools.

Cancelled plans, imports owned by another event, incomplete or unsynced brackets,
and plans with operational matches or score reports cannot be adopted through this
flow. Existing operational history needs its own reconciliation rather than being
discarded by adoption.

## Tech In Place 11

Read-only production inspection on 18 September 2026 found a completed saved plan
with 40 entrants and two attached main brackets. The consolation brackets had been
registered separately. Explicit plan membership therefore split the public event
overview and recap into a main-bracket group and a consolation-bracket group.

The proposed association is:

| Slot | Existing imported tournament | Challonge slug |
| --- | --- | --- |
| Upper main | Tech In Place 11 (Upper Division) | `techinplace11_upper` |
| Upper consolation | Tech In Place 11 (Upper Losers) | `d5bm0y9c` |
| Lower main | Tech In Place 11 (Lower Division) | `techinplace11_lower` |
| Lower consolation | Tech In Place 11 (Lower Losers) | `bdz8m414` |

Both mains contain 20 imported entrants and a 10-player final field. Each
consolation contains 10 entrants. Their original start timestamps differ and are
preserved by adoption. The production preview must be generated after deployment
to check the then-current roster and links. No production adoption was performed
while developing this feature.

## Local rehearsal

The development harness seeds **Nemesis · Historical Rehearsal**, a completed plan
with two linked mains and two separate consolations. Its actual roster includes one
late entrant, one planned entrant absent from the imports and two division moves.
It has no operational matches. This exercises the same partial-registration shape
without using production data.

Service tests check preservation of source rows, grouping from all four bracket
entry points, administrator access, stale previews, ownership conflicts and
operational-history rejection. The Playwright regression exercises selection,
preview invalidation, a second administrator applying concurrently, a fresh retry,
the archived-plan presentation and the resulting public standings.
