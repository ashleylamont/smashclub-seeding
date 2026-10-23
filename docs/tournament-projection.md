# Preview a tournament night

In **Admin → Event planner**, expand **Night preview → Explore timeline, run order and brackets**. It is available before saving a new Nemesis plan and on saved plans while drafting, reviewing frozen seeds, or reviewing pools. Singles counts players; doubles counts fixed pairs, with two people per entrant.

The preview compares the six supported structures:

- **Open round robin:** one pool, everyone plays everyone, then confirmed finishing order decides the night. Requires at least two entrants, with no format-specific maximum.
- **Round robin → playoffs:** one pool followed by the configured playoff cut and optional consolation.
- **Single elimination:** a seeded knockout draw with automatic byes and no pool stage.
- **Double elimination:** winners and losers brackets followed by a grand final and possible reset.
- **Open pools and finals:** balanced pools, followed by championship and optional consolation.
- **Upper / Lower pools and finals:** two divisions, each with its own pools and final brackets. Requires at least six entrants and at least three per division.

The selected plan format is marked **Plan format**. Clicking another comparison card changes only the preview. To run that format, select it in the plan's actual tournament structure control while the roster is a draft. **Use plan counts and format** restores the preview to the roster count, plan format, round-robin meetings and Upper target; timing assumptions remain as entered.

## Set the assumptions

Use the actual entrant count or try a hypothetical count (at least two). Set round-robin meetings per pairing (one for single round robin, two for double round robin), available stations (1–32), local start time, average minutes per complete set, station turnaround, player recovery time and the break between pools and finals. Meetings apply to every pool, including pools before finals. An optional Upper size overrides an even division split. A doubles pair uses one station for a set, just like a singles entrant; allow more minutes per set if doubles usually takes longer.

The preview does not save these assumptions, change entrants, freeze seeds, reserve stations, generate live matches, or affect ratings. They are local what-if controls and reset when leaving or reloading the planner. The query is restricted to administrators and makes no database changes.

## Read the views

**Station timeline** places provisional sets on horizontal station lanes. Select a set for its pairing, start/end time and feeder matches. The run sheet lists the same order in a table and can be downloaded as CSV. Clock labels include a next-day offset if the night crosses midnight.

**Pools and bracket layout** shows striped seed placeholders in each pool and the advancement paths into the final brackets. `UA1` means Upper pool A, first place; `LB3` means Lower pool B, third place; `OA2` means Open pool A, second place. Bracket lines connect feeder matches. Automatic byes advance without consuming a station or a played set. Empty brackets and single-qualifier consolation brackets are identified explicitly.

Pool balancing, round-robin pairings, qualification and elimination trees use the same pure engine functions as the real planner and live decisions. Until results exist, finalists are pool-place placeholders and subsequent matches identify the **Winner** or **Loser** of a feeder; no winner or rating outcome is predicted. The bracket is a rehearsal of the format's shape, not the saved draw or a prediction of actual standings. Frozen seed reordering, division pins and attendance changes can alter the real allocation. See [Tournament structures](tournament-structures.md) for the graph contract and further format options.

## Interpret the finish time

The simulation dispatches the next available set onto a free station. Pool entrants cannot play two sets at once and get the chosen recovery time. Final matches wait for their feeder matches. All pools finish before finals start, with at least the greater of the finals break and player recovery time. All stations are assumed to share one queue and to support every set; actual pool station banks or reserved finals stations may take longer.

The finish time is approximate. The set-length sensitivity range reruns the simulation with sets 20% shorter and 25% longer, rounded to whole minutes. It is a comparison of timing assumptions, not a statistical confidence interval. Add venue time for setup, check-in, pauses, disputes, awards and overruns. Double elimination includes the possible reset in its upper-bound set count and schedule; live play skips it when the winners-bracket finalist wins the first final. Symbolic feeder resources are conservative until actual results resolve them.
