# Preview a tournament night

In **Admin → Event planner**, expand **Night preview → Explore timeline, run order and brackets**. It is available before saving a new Nemesis plan and on saved plans while drafting, reviewing frozen seeds, or reviewing pools. Singles counts players; doubles counts fixed pairs, with two people per entrant.

The preview compares the three supported structures:

- **Open round robin:** one pool, everyone plays everyone, then confirmed finishing order decides the night. Supports 2–8 entrants.
- **Open pools and finals:** balanced pools, followed by championship and consolation.
- **Upper / Lower pools and finals:** two divisions, each with its own pools, championship and consolation. Requires at least six entrants and at least three per division.

The selected plan format is marked **Plan format**. Clicking another comparison card changes only the preview. To run that format, select it in the plan's actual tournament structure control while the roster is a draft. **Use plan counts and format** restores the preview to the roster count, plan format and Upper target; timing assumptions remain as entered.

## Set the assumptions

Use the actual entrant count or try a hypothetical count (2–128). Set the number of available stations (1–32), local start time, average minutes per complete set, station turnaround, player recovery time and the break between pools and finals. An optional Upper size overrides an even division split. A doubles pair uses one station for a set, just like a singles entrant; allow more minutes per set if doubles usually takes longer.

The preview does not save these assumptions, change entrants, freeze seeds, reserve stations, generate live matches, or affect ratings. They are local what-if controls and reset when leaving or reloading the planner. The query is restricted to administrators and makes no database changes.

## Read the views

**Station timeline** places provisional sets on horizontal station lanes. Select a set for its pairing, start/end time and feeder matches. The run sheet lists the same order in a table and can be downloaded as CSV. Clock labels include a next-day offset if the night crosses midnight.

**Pools and bracket layout** shows striped seed placeholders in each pool and the advancement paths into the final brackets. `UA1` means Upper pool A, first place; `LB3` means Lower pool B, third place; `OA2` means Open pool A, second place. Bracket lines connect feeder matches. Automatic byes advance without consuming a station or a played set. Empty brackets and single-qualifier consolation brackets are identified explicitly.

Pool balancing, top-half qualification and finals seeding use the same functions as the real planner. Until results exist, finalists are pool-place placeholders and subsequent matches say **Winner** of a feeder; no winner or rating outcome is predicted. The bracket is a rehearsal of the format's shape, not the saved draw or a prediction of actual standings. Frozen seed reordering, division pins and attendance changes can alter the real allocation.

## Interpret the finish time

The simulation dispatches the next available set onto a free station. Pool entrants cannot play two sets at once and get the chosen recovery time. Final matches wait for their feeder matches. All pools finish before finals start, with at least the greater of the finals break and player recovery time. All stations are assumed to share one queue and to support every set; actual pool station banks or reserved finals stations may take longer.

The finish time is approximate. The set-length sensitivity range reruns the simulation with sets 20% shorter and 25% longer, rounded to whole minutes. It is a comparison of timing assumptions, not a statistical confidence interval. Add venue time for setup, check-in, pauses, disputes, awards and overruns. No third-place match, bracket reset or extra stage is invented: the projection follows Nemesis's current round-robin and single-elimination finals structures.
