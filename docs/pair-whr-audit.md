# Experimental pair WHR audit

Audit date: 31 October 2026. Requested in #145 after enabling experimental pair ratings changed seeds for pairs without doubles history. Source baseline: `39e05f6` (includes #142/#143). This is a source, numerical-test and synthetic API/browser audit; it does not identify the user's exact production roster or validate predictive accuracy on club data.

## Finding: zero mean adjustment can still change a seed

The observed cold-start behavior follows the configured model. `fitDoubles` uses a zero-centred prior for each unordered pair. A combination with no eligible played results has exactly zero mean adjustment; a member's results with another partner do not supply that combination's residual. Its members' singles estimates can still differ from 1500 without any doubles history.

Enabling the model also introduces residual uncertainty. The configured prior SD is `0.25 × 400 / ln(10) = 43.429448` display points. The calculation is:

```
baseline mean = (member A skill + member B skill) / 2
baseline SD = hypot(member A SD, member B SD) / 2
enabled mean = baseline mean + learned pair mean adjustment
enabled SD = hypot(baseline SD, pair residual SD)
seed = mean − 2 × SD
```

For example, a baseline mean of 1600 with member SDs of 60 and 60 has pair baseline SD 42.4264 and seed 1515.1472. With no prior pair results, enabling the model retains mean 1600 and adjustment 0, adds prior residual SD 43.4294, and produces total SD 60.7134 and seed 1478.5732. The seed falls about 36.57 points. The fall depends on baseline uncertainty; it is not a fixed 86.86-point deduction and is not evidence of worse chemistry. Even entirely new pairs can change relative seed order because the added variance affects their conservative bounds differently.

The planner previously showed only total skill/SD and seed, while saying adjustments started at zero. That omitted the distinction between a learned mean and model uncertainty. The change in #145 exposes the baseline, applied residual mean/SD and eligible prior set/night counts. View-only skill/seed sorting helps compare them without changing roster order or frozen seeds. New frozen rosters store their breakdown alongside existing provenance. Older snapshots without a breakdown show it as unavailable rather than borrowing today's evidence.

## Checks and boundaries

| Area | Evidence and result |
| --- | --- |
| Optimizer and units | Existing independent scalar MAP root check with known singles offset agrees with the fitted residual. Side/partner symmetry, historical offsets, score weighting, drift and singles parity tests are retained. The display conversion is consistent with the natural-rating definition in [Coulom's WHR paper](https://www.remi-coulom.fr/WHR/WHR.pdf), section 2.1. The pair residual extension and its parameters are club choices, not parameters established by that paper. |
| Cold starts and partner changes | Engine tests and a real planner API test keep residual mean exactly zero while showing increased variance and lower conservative seeds. A successful pair's evidence/mean does not transfer to another combination. Counts represent actual played sets, not weighted pseudo-trials. |
| Time boundary | `loadDoublesRatings` restricts doubles publications to event days strictly before the planned event. Each likelihood offset fits singles history strictly before that historical doubles day. Tests withhold same-day/future doubles and later singles results. Engine `fitDoubles` itself fits all supplied history retrospectively; calling its `rating` at an earlier time does not make that full fit a causal forecast. The server's prefix loading supplies the required boundary. |
| Revisions and outcomes | Loader selects the latest sealed revision per event and excludes withdrawn publications. Only `played` outcomes enter the pair fit; byes, forfeits and no-contests add no evidence. Corrected-publication tests verify changed estimates with unchanged evidence counts and superseded result IDs absent. |
| Identity | Historical member redirects are resolved before constructing unordered pair keys. An API test merges a historical identity and retains the exact pair's evidence, while a new partner stays at zero. Invalid collapsed/overlapping historical membership is rejected rather than fitted. |
| Frozen seeds | New evidence is captured in the existing JSON provenance at freeze. A test publishes an earlier doubles event after freeze and verifies that saved means, SDs, scores, seeds and breakdown remain unchanged. Legacy context without the new breakdown retains its original scores and has no invented explanation. No journal version or competitive command changes are needed. |
| UI and sorting | Shared controls and tokens; rating sorts use the numbers actually displayed, including frozen snapshots, with source-line tie order. Browser checks verify no write requests from sorting and unchanged API roster/seeds. Phone/desktop and both themes include cold/experienced pairs, long names, keyboard-accessible table scrolling and accessibility checks. |

## Accuracy limits

No numerical defect was found in the reported no-history behavior. The formula and parameters remain unchanged. A zero-centred uncertain prior is an explicit modelling assumption, not an adjustment learned from nonexistent matches.

The current model fixes singles means as likelihood offsets, approximates baseline variance with independent marginals, and uses the existing conditional WHR variance calculation rather than a complete joint covariance model. Residuals can absorb doubles aptitude and baseline error as well as partnership effects. The narrow prior and drift parameters have not been calibrated in this audit against recurring club pairs. Existing held-out synthetic tests establish implementation behavior, not club predictive benefit.

The option remains experimental and off by default. A decision to change its prior, conservative bound or default requires whole-night held-out evaluation against the average-singles baseline on real doubles history, reporting repeat-pair coverage, calibration and loss. This audit does not change the separate seeding policy in #57/#99 or rewrite historical ratings.
