# Native doubles and tournament structures

Create a plan in **Admin → Event planner**, choose **Doubles — 2v2 (Nemesis)**, and save the draft. Select both registered players in each pair, optionally give the pair a public team name, and review the team count and structure recommendation. A person can enter only once in a competition. New players can be registered under Admin → Players before selecting their pair.

| Structure | Recommended field | Behavior |
| --- | --- | --- |
| Open round robin | 2–5 teams / 4–10 people | Everyone plays everyone; a TO confirms final placements and resolves ties. No finals stage. |
| Open pools and finals | 6–11 teams / 12–22 people | One competitive division, balanced pools of three to five teams, then championship and consolation. |
| Upper / Lower pools and finals | 12+ teams / 24+ people | Two seeded divisions; each has its own pools, championship, and consolation. |

Recommendations are guidance. A single round robin permits two to eight entrants; two divisions require at least six entrants, with three in each. Open pools and finals require at least three entrants. The same native structures are available for singles; count people instead of teams when choosing a singles structure.

Freeze team seeds, review/reorder seeds, generate pools, and open the event desk. Locking the draw freezes pair membership. Set up stations with four working controller connections. One doubles match occupies one station and one simultaneous-match slot. Use the club's standard doubles gameplay rules consistently; the pair rating currently has one common doubles scope, rather than separate estimates for different gameplay rulesets.

The **Doubles player availability** controls hold a pair when either member is away. Attendance controls remove a no-show pair or withdraw the whole pair; a TO explicitly resolves the remaining forfeits. Partners cannot be substituted or added after draw lock. Played sets stay in history; byes, forfeits, and no-contests never create rating evidence.

Either teammate can find the pair under their public names. Reports retain the individual reporter identity and use the existing approval/dispute policy. Confirm pool finishing orders in the planner. For a round robin, finalize directly afterward; for the other structures, create and finish the championship/consolation brackets first. A reviewed round-robin score correction must also include a reviewed complete finishing order.

Results retain both members and one team-versus-team result per set. Player profiles show doubles results separately. Doubles does not alter singles ratings, singles activity periods, or singles breakthrough analysis. Singles recaps remain a singles feature; doubles publishes team standings, records, and bracket results. Public views use both players' public aliases.

Run separate singles and doubles plans in sequential time blocks. Station and player reservations are local to one event plan. Concurrent competitions sharing players or physical stations require shared scheduling support and are not coordinated automatically.

## Ratings and uncertainty

By default a pair's strength is the average of its members' underlying singles WHR skill, without attendance deductions. Unknown players use the singles prior. Baselines for a doubles event use singles history strictly before that calendar event day, projected forward with WHR drift. No same-night or future singles result enters a pre-night doubles baseline.

Under an independent-marginal approximation:

```
pair mean = (mean A + mean B) / 2
pair variance = (variance A + variance B) / 4
seeding score = pair mean − 2 × pair SD
```

This propagates uncertainty before applying the conservative bound. It differs from averaging two conservative player scores. Posterior correlations and transfer from singles skill to doubles skill are approximations; model uncertainty is not a guarantee about outcomes.

The optional **Include experimental WHR pair adjustments in seeds** setting fits a time-varying, zero-centred residual for each unordered pair:

```
logit P(AB beats CD) = average singles skill AB − average singles skill CD
                     + pair residual AB − pair residual CD
```

The likelihood uses natural log-odds units; conversion to display points uses the existing `400 / ln(10)` scale. Each historical match supplies its own pre-night singles baseline as a known likelihood offset. Adding a pair rating to an initial prior alone would not represent a changing baseline correctly.

Residual prior SD is 0.25 natural units (about 43 display points), and Brownian drift variance is 0.00002 per day. These conservative initial parameters are recorded as `whr-pair-residual-v1` provenance. The existing configured, capped score-margin evidence weight applies to played sets. A new combination starts at zero adjustment even if either member has a successful history with another partner. Enabling the model adds residual uncertainty to the pair's total uncertainty. Inactivity widens uncertainty; it does not automatically erase the residual mean.

Pair estimates are derived on demand from the latest sealed result revision for each earlier doubles event. Replaced revisions cannot count twice. Identity redirects apply to the derived pair keys. Invalid duplicate-member history is rejected for review. Frozen seeds retain their estimates, uncertainties, source result revisions, settings, and member baseline inputs; later results or recomputes do not reorder the draw. Live event replay never reads current ratings to reconstruct past decisions.

The adjustment can absorb individual doubles aptitude, baseline error, and chemistry. It should not be interpreted as an isolated causal measure of chemistry. It is disabled by default. Keep average-based seeds until whole-night held-out predictions on real doubles history show a useful gain, especially for recurring pairs. If partners rarely repeat, individual doubles aptitude may be a more useful next model.

## Verification

Engine tests compare the residual optimizer with an independently solved MAP optimum, exercise expected and unexpected wins, historical offsets, side/partner symmetry, cold starts, drift, score weights, invalid inputs, and singles parity. A deterministic simulation checks prediction improvement on unseen matches when persistent pair effects actually exist; this establishes implementation behavior, not a measured improvement on club data.

API tests run all three doubles structures through frozen planning, live ownership, publication, and replay. They cover duplicate/incomplete pairs, individual availability, immutable membership, corrected round-robin standings, public-name privacy, revision supersession, historical baselines, and isolation from singles ratings. PostgreSQL tests exercise concurrent teammate reports and reconstruction/correction after restarting independent Act runtimes. A browser rehearsal creates pairs through the shipped planner and finishes a round robin through the event desk and public results.

The existing `playerId` / `player1Id` / `player2Id` native transport fields remain compatibility keys. For a doubles entrant those keys identify the event entry, while `memberPlayerIds` identifies the actual people. No player record is created for a team. V1 baseline fields remain unchanged; V2 baselines and sealed results explicitly carry competition format, structure, and membership.
