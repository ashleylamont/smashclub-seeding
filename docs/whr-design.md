# Whole-History Rating

WHR is the sole supported rating system. Settings expose WHR parameters and club policy; there is no model selector, Glicko runtime or model-comparison API. Historical records retain the model and settings that produced them.

## Fits and history

WHR jointly fits the eligible played history. A rating period is a club event day: main and rookie brackets on the same evening share a period. Prefix fits use only the history available through each night. The current full fit provides both the current rating and retrospective estimates at earlier nights.

The engine records each played set for participation, chronological career history and evidence weighting. Its legacy-named `pre_rating` and `post_rating` columns now repeat **pre-night and post-night estimates** on every set that night. They are not per-set updates and must never be summed as match deltas. The pre-night estimate comes from the immediately preceding history prefix, projected to the selected night; a debut uses its configured prior. Profiles and charts show one point per night, and match logs show evidence weights without rating deltas.

Appending later nights preserves earlier prefix estimates under unchanged input and settings. Corrections, identity resolutions or configuration changes can change recomputed estimates; these numbers are not a record of an immutable board publication. Old recomputes remain immutable provenance records. The `revised_rating` / `revised_sd` values describe the current fit's hindsight estimate at a past night.

The full explainability work remains in [#61](https://github.com/ashleylamont/smashclub-seeding/issues/61): [approximate result impact #95](https://github.com/ashleylamont/smashclub-seeding/issues/95), [new-night movement versus historical revision #96](https://github.com/ashleylamont/smashclub-seeding/issues/96), [expected outcomes and scoreline evidence #97](https://github.com/ashleylamont/smashclub-seeding/issues/97), and [consistent explanations #98](https://github.com/ashleylamont/smashclub-seeding/issues/98). This removal does not implement approximate influence, leave-one-result-out validation, or a complete nightly revision/attendance breakdown. Do not restore synthetic per-match chains or spread historical catch-up across match rows.

## Uncertainty, attendance and seeds

Brownian drift (`whrDriftVariancePerDay`) widens uncertainty over unobserved elapsed time. The board evaluates everyone at the club's latest rated event. No invented decay matches are emitted. The point estimate, posterior uncertainty and evidence calibration retain the existing WHR mathematics.

The public board orders **club rating = displayed skill − activity penalty**. Missing club nights incurs the configured grace window, charge and cap; playing clears the penalty. Provisional thresholds, fixed league bands and their one-time calibration are club policy. Sample confidence measures posterior tightening relative to the WHR prior.

Automatic seeding orders **displayed skill − 2 × SD**. Attendance deductions do not enter that score. Optional rookie debut priors and the existing isolation anchor are preserved: the anchor affects the displayed number, not the fit or its probability formula. A frozen tournament draw retains its stored seeds and original recompute reference through the cutover.

## Played evidence and probabilities

A played set's evidence weight is `min(2, 1 + whrGamesWeight × (winning margin − 1))`, with unknown or unusable played scorelines contributing one result. At the default 0.5, 3–0 has weight 2, 3–1 has weight 1.5 and 3–2 has weight 1. This weights model evidence; it does not multiply rating points. Games within a set are correlated, so the margin is discounted.

Forfeits award a tournament win/advancement with **no invented games and no rating input**. Byes are not played results. Recompute checks imported negative-score forfeits, impossible-score byes and explicit native unplayed outcomes independently of stored exclusion overrides. Unknown scores on an otherwise played result still contribute one result. Legitimate played 5–0 records must not be converted to forfeits based only on their score; audit/correction work is tracked in [#68](https://github.com/ashleylamont/smashclub-seeding/issues/68).

Forecasts use WHR's logistic probability with the summed uncertainty of both players. Breakthrough analysis fits strictly before the selected night and reports unavailable expectations for players without history. Recap upset probabilities use the recorded pre-night estimates, never a Glicko fallback. Broader forecast snapshot explanations remain in #97.

## Configuration and evaluation

| Knob | Default | Meaning |
| --- | --- | --- |
| `whrDriftVariancePerDay` | 0.0002 | Drift variance per elapsed day in natural units. |
| `whrPriorSd` | 1.2 | First-night prior SD in natural units. |
| `whrGamesWeight` | 0.5 | Discounted score-margin evidence; zero ignores margin. |
| `whrRookieDebutPrior` | 1500 | Display-scale prior centre for rookie debuts. |
| `whrIsolationAnchor` | false | Existing optional display anchor for isolated rookie records. |

`pnpm rank-eval --synthetic` or `pnpm rank-eval <cache>` evaluates WHR variants against coin-flip, experience and smoothed win-rate baselines using held-out walk-forward prediction, calibration and paired bootstrap. `--impact` reports WHR club rank versus conservative seeding. The independent baselines have no Glicko dependency. The old Python tree is an unsupported historical archive; its Glicko golden-check workspace tool has been retired.

## Data cutover

See [WHR-only migration](whr-only-migration.md) for configuration migration, canonical reader gating and deployment rehearsal.
