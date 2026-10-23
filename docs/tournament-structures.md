# Tournament structures and format inputs

Nemesis treats a structure as a deterministic transformation:

```text
ranked entrants + division assignments + structure + options
                         ↓
                  pure engine compilation
                         ↓
       stages + participant sources + matches + dependencies + order
                         ↓
       planner / preview / live decisions / queues / displays / exports
```

`packages/engine/src/tournament/` owns pool allocation, round-robin pairing,
qualification, rematch-aware finals seeding, and elimination trees. It has no
database, server, React, station, clock, or provider dependency. The existing
planner imports re-export those rules for compatibility.

## Contract

`compileTournament` accepts a structure, ordered entrant IDs within explicitly
assigned divisions, normalized structure options, and an optional pool size.
Roster policy chooses division assignments and seeds before compilation. A
singles player and a fixed doubles pair are both opaque entrant IDs here; member
availability, rating estimation, access control, and scoring belong elsewhere.

The versioned, JSON-serializable output contains:

- Round-robin and elimination stages, with explicit stage dependencies.
- Slots identified as an entrant, a pool finishing place, a feeder match's winner
  or loser, or a bye. Display strings such as “Winner UM-1” are adapter output.
- Stable logical match IDs, rounds, within-round slots, repetition numbers, and
  match dependencies. Array order is topological, not a demand to run independent
  matches sequentially.
- Guaranteed set counts, which timing and comparison views can consume.
- Explicit winners/losers/final lanes and an activation condition for the double
  elimination reset final. Consumers can distinguish possible and required sets.

`buildRoundRobin`, `buildFormatFinals`, `buildEliminationTree`, and
`buildDoubleEliminationTree` expose the same primitives for incremental live decisions. Finals use confirmed finishing orders
and current eligible entrants; the preview uses symbolic pool-place slots. Neither
predicts a winner. Qualification and bracket seeding are separate operations;
championship entrants no longer need fabricated consolation places to use the
rematch repair algorithm.

The preview is an adapter from the graph to labels and a provisional station
schedule. The preview dispatcher uses indexed readiness and lazy availability
updates instead of rescanning every pending match for each scheduled set. Timing,
recovery intervals, station banks, and actual dispatch are consumer concerns. They do not influence the format's match topology.

## Supported formats and inputs

All six formats support singles and fixed doubles entrants:

| Format | Stages and advancement |
| --- | --- |
| Open round robin | One round robin; a confirmed finishing order decides results. |
| Round robin → playoffs | One round robin followed by a seeded single-elimination cut; optional consolation for the remaining entrants. |
| Single elimination | A seeded knockout draw from the start, with automatic byes. |
| Double elimination | Seeded winners and losers brackets, grand final, and a reset only if the losers-bracket finalist wins the first final. |
| Open pools and finals | Balanced pools; the top half of each pool advances to championship, with optional consolation for the remainder. |
| Upper / Lower pools and finals | Two seeded divisions, each with its own pools and championship; optional consolation. |

`structureOptions.roundRobinMeetings` is a positive integer, defaulting to `1`.
One is single round robin, two is double round robin, and larger values repeat
the same circle schedule. Return meetings alternate sides. The option applies
to every round-robin stage, including pools before finals; it does not multiply finals or change the number of games in a set.

This is a parameter of a format, not another structure enum value. Further knobs
should have typed, validated inputs and explicit defaults rather than new labels
for every combination. `playoffSize` selects the round-robin playoff cut (at least
two, no larger than the roster); null or omitted advances everyone.
`consolation` controls the extra bracket: enabled by default for pool formats,
disabled by default for round-robin playoffs. It has no effect on standalone
knockout or plain round robin. Keep match scoring rules and resource assumptions
separate from these topology inputs.

The planner saves options in the draft and permits changes only while it is a
draft. Locking captures them with the actual chosen matches. Act reducers replay
those facts without running a current generator again. Sealed and corrected
results retain the options. Migration `0026` gives existing plans one meeting;
older journals without options retain their original one-meeting behavior.

Round robin has no entrant-count ceiling or count-based recommendation. It still
requires two entrants. Structural requirements remain for the existing pool
balancer: open pools need three entrants and two divisions need three per division.
Workload follows `meetings × n × (n − 1) / 2`; the preview shows its practical cost.

## Live decisions and results

Standalone knockout has no pool stage or separate finals-generation operation.
Locking records the entire chosen draw, including automatic byes, explicit loser
feeds and the conditional reset. Each played result resolves its downstream
sources. A skipped reset consumes no station and produces no history or rating
set. A loser feed from a bye is empty; it never creates a fictitious opponent.

The shared elimination standings function ranks entrants by their elimination
round, including tied ranks, and determines the champion using the reset outcome
when required. Publication preserves double-elimination history and loser-round
metadata. As for existing formats, byes, forfeits and no-contests are not rating
evidence. Double-elimination corrections may adjust a score with the same winner;
changing a winner with downstream feeds requires a future bracket-repair workflow
and is rejected rather than leaving those feeds inconsistent.

## Review findings

The existing implementation had a sound foundation: deterministic algorithms,
explicit pool orders, and durable decisions retaining actual pairings. Its main
architectural weakness was where those rules lived and how they were duplicated.

- Pure allocation and advancement rules lived inside the server planner. They
  now live in the engine, with no dependencies on their consumers.
- The preview and live finals independently built elimination trees. Both now
  use the engine tree builders and qualification/seeding functions. New extended
  native draws consume the compiled graph directly at the lock boundary.
- Extended native pool draws used nested pairs while the preview used circle
  rounds. Both now use the same round-robin generator. New live draws retain
  chosen round metadata; queues use it instead of regenerating a different order
  from sorted identity IDs. Legacy draws retain their stable fallback order.
- Capture validation and attendance repair assumed one match per pair. They now
  respect the captured meeting count and preserve existing match facts.
- An eight-entrant format cap also existed on corrected finishing orders. Both
  caps and the roster-size recommendations have been removed.

There are still provider and lifecycle adapters. Adding a wholly new stage
primitive will require deliberate live schema and publication support.
The graph contract is an extension boundary, not a claim that every tournament
can already run through the existing lifecycle.

## Formats worth exploring next

| Format or option | Why it is useful | Architectural requirement |
| --- | --- | --- |
| Swiss, optionally followed by a cut | Gives entrants a fixed round budget and pairs similar records. | Generate each round from a results snapshot; specify rematch avoidance, odd-field byes, ties, and withdrawal policy. |
| Placement flights / classification brackets | Gives more entrants a meaningful finishing match or standing. | Compose finishing-place selectors and classification stages; define tied ranks and extra-match policy. |

For Swiss and other adaptive formats, the initial output must describe a pending
stage or pairing rule. A pure next-round decision takes the format inputs plus
recorded results and emits the next concrete matches. Persist those chosen
pairings in Act. A full predetermined bracket would falsely imply that future
opponents are already known. Avoid building a general tournament scripting
language until these concrete stage primitives need it.

## Verification

Engine tests cover pairing uniqueness, repeated meetings, stage dependencies,
large fields, and every possible winner path for small single/double elimination
draws. Wider seeded draws check topology, loss counts and conditional finals.
Projection tests independently check capacity, recovery and participant overlap.
API rehearsals cover all formats, odd fields, doubles, optional consolation,
corrections, conflicts, replay, publication and rating exclusions. Browser tests
exercise format configuration, previews, draw generation and finalization.
