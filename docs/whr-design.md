# Whole-History Rating: how it is integrated here

WHR (Coulom, 2008) refits every rating from all evidence at once. On this
club's data — a dozen-ish nights, ~1,000 sets, weakly-linked main and rookie
brackets, a long tail of one-event players — that is measurably the right
model: on walk-forward evaluation it beats every sequential Glicko variant and
every baseline (`pnpm rank-eval`). But a batch fit does not naturally answer
the questions this app is built around: *what did this set do to my rating*,
and *why did my number change when I didn't play*. This document records how
those are answered.

## The two books

A batch fit revises the past by design: night 12's results genuinely teach the
model something about how good you were on night 9. Shown naively, that reads
as numbers rewriting themselves. So the run keeps two books:

**The ledger** (`pre_rating`/`post_rating` on `rating_events`) is what the
board published as of each night, and it is *frozen*. It is computed from
prefix fits: event *k*'s numbers come from a fit that has seen events 1..k and
nothing later, so appending an event can never rewrite an old row. The match
log, the per-set Δs, the sparkline and the trajectory chart's solid line all
read from the ledger. It chains continuously — each row's `pre` is the
previous row's `post` — and a night's rows sum exactly to what the night did.

**The hindsight track** (`revised_rating`/`revised_sd`) is the current full
fit's estimate at each of the player's nights. It moves with every recompute,
and that is the point: revision is displayed as a labelled, dashed second
series on the profile chart ("with everything played since, this is how good
we now think you were that night") instead of leaking into the record.

The board itself always shows the latest full fit — which is also the last
prefix, so the ledger's final value and the board agree exactly.

## Per-set deltas

WHR does not attribute movement to individual results, but it comes very
close to licensing one: at the optimum, the first-order effect of a single
result on a player's rating is `posterior variance × (outcome − expected)` —
the same residual that drives the Newton step. So a night's total movement
`D` (from the prefix fits) is split as:

```
base_i   = v · trials_i · (outcome_i − p_i) · scale     (surprise share)
delta_i  = base_i + (D − Σ base_j) / n                  (remainder spread evenly)
```

where `p_i` is the win probability the *pre-night* fit would have quoted —
what the board actually expected before the set — and the remainder carries
what the linearisation cannot see (opponents' own movement that night, prior
shrinkage on a debut). Wins as the underdog get big positive shares, routine
wins small ones, losses negative ones, and the shares always sum to exactly
`D`. A share can disagree in sign with the result — you can win a set on a
night that still cost you points — which is honest, not a bug.

## Inactivity

Two mechanisms, deliberately separate:

- **Inside the model**: Brownian drift (`whrDriftVariancePerDay`) widens the
  posterior over unobserved time. The leaderboard evaluates everyone at the
  *club's latest event*, not at their own last appearance, so an absent
  player's band widens on the published board, their conservative seeding
  score (`skill − 2·sd`) sinks, and the confidence meter fades. Their point
  estimate does not move — Brownian motion is a martingale, and pretending
  absence is evidence of decline would be inventing data.
- **On the board**: the activity penalty, shared verbatim with the Glicko
  path. What missing a club night *costs* is club policy, stated in points,
  and must not change when the model does.

## Decisive sets

A 3-0 says more than a 3-2. A set counts as `1 + whrGamesWeight · (margin − 1)`
independent results, capped at 2 (games within a set are correlated — momentum,
counterpicks — so the margin is discounted, not counted outright). Forfeits
and unreadable scorelines rate as a plain set. The multiplier is stored as the
event's `weight` and surfaced in the match log (`×1.5` etc.).

## What is deliberately absent

The Glicko path's corrective stack — rookie down-weighting, isolation factor,
rating anchor, sample-confidence shrinkage — is not ported. Thin linkage
between the rookie and main pools comes out of the fit as *wider uncertainty*,
which is the honest answer; the prior on each player's first night keeps
disconnected pools anchored to 1500 instead of floating.

## Tuning

| Knob | Default | Meaning |
|---|---|---|
| `whrDriftVariancePerDay` | 0.0002 | ~55 display points of drift/year. Raise to track form faster and widen absence bands faster. |
| `whrPriorSd` | 1.2 natural (~208 display) | First-night prior; also the scale anchor and the confidence meter's "knowing nothing". |
| `whrGamesWeight` | 0.5 | Evidence per game of winning margin; 0 ignores scorelines. |

Tune against held-out prediction, not vibes: `pnpm rank-eval <cache>` compares
drift variants (and the Glicko models) on log loss with a paired bootstrap.

## Surfaces

- **Recompute** writes the ledger + hindsight columns, records WHR convergence
  in `recomputes.stats`, and takes `previousRank` from the second-to-last
  prefix — the same board members actually saw before the night — rather than
  a separate withheld refit.
- **Profile** explains Δs as shares of the night, draws the hindsight series
  when it diverges, and words the confidence tile for the model in force.
- **Leaderboard** confidence meter uses the server's model-appropriate
  `sampleConfidence` rather than a hardcoded Glicko scale.
- **Recap** quotes upset odds with the model's own probability formula
  (variance-sum attenuation for WHR).
- **Seeding** ranks on `skill − 2·sd` with drift-projected sd, so returners
  are seeded cautiously without being told they got worse.
