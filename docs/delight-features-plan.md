# Delight features — exploration & plan

A plan for the "fun layer" on top of the ranking machinery: post-tournament
recaps, a big-screen live view for club nights, and smaller moments of delight
on player pages. Everything here is grounded in data the app already stores —
none of it needs new sync work or schema changes to get started.

## What we already have to build on

The delight features almost design themselves once you list what's sitting in
the database:

- **`rating_events` is a per-set story.** Every rated set has pre/post rating
  *and* RD for both players, the opponent, a weight, and a `set_id` link. That
  means we can compute "true" upset magnitude (winner's pre-set rating vs
  loser's), the biggest rating swing of the night, career meeting counts
  between any two players, and career-high ratings — all from one table.
- **Seeds and final ranks are stored per participant.** `challonge_seed` +
  `final_rank` give seed upsets, Cinderella runs, and seed-performance without
  touching ratings at all — which matters, because these work even *before*
  identities are resolved and a recompute has run.
- **`player_ratings.previous_rank` is already the honest movement number**
  (computed against a withheld-night replay). "Movers of the night" is
  essentially free.
- **Sets carry bracket structure.** `round` (positive = winners, negative =
  losers), `suggested_play_order`, `identifier`, `scores_csv`,
  `completed_at`, and the DQ flag (`excluded_from_ratings`). Enough for
  losers-bracket-run detection, grand-finals detection (the max round),
  nailbiter detection (deciding games), and a live "now playing / up next"
  ordering.
- **A per-tournament SSE feed already exists** (`/api/live/:tournamentId`,
  `set_updated` / `sync_completed` / `recompute_completed`), driven by the
  ~15s live poller and the debounced recompute. A live view gets its realtime
  plumbing for free — and because recomputes run *during* the night, live rank
  movement is actually feasible, not aspirational.
- **Character mains + `CharacterIcons`** give every feature faces, not just
  names.
- **`eventKeyOf`** groups the main and rookie brackets of one evening into a
  single *event* — recaps should probably be per-night, not per-bracket.
- **The design language is strong and specific** (arcade CRT: hard edges, one
  red, Oswald scoreboard type, no gradients/shadows). Delight features should
  lean into it — takeover cards that look like an arcade "WINNER" screen —
  rather than importing confetti-and-gradient idioms from elsewhere.

Two constraints worth respecting throughout:

1. **Ratings lag the bracket.** Right after a set finishes (or a bracket
   completes), identities may be unresolved and the latest recompute may not
   include the tournament yet. Every feature needs a seed/score-only fallback,
   with rating-flavoured facts appearing when they exist rather than being
   load-bearing.
2. **DQ/forfeit sets** (`excluded_from_ratings`) must not win "most dominant
   sweep" or "biggest upset". Excluded sets are excluded from facts too.

---

## 1. Post-tournament recap — "the night in review"

The flagship. When a tournament completes, its page opens with a recap instead
of jumping straight to a standings table: a podium, then a handful of the most
notable *facts* about the night.

### The facts engine (pure, in `packages/engine`)

A new module, e.g. `packages/engine/src/recap.ts`, following the repo's
"engine is pure, server does I/O" rule. Input: typed slices of sets,
participants (seed + final rank), and the tournament's rating events (plus a
career-history slice for meeting counts/milestones). Output: `Fact[]`, each
with a `kind`, the player ids involved, structured payload, and a
**notability score** so the UI can rank and take the top N deterministically.
This makes every fact unit-testable in vitest alongside the existing engine
tests, and reusable later (Slack/Discord recap posts, a yearly "wrapped").

Fact catalogue, with where each comes from:

| Fact | Source | Notes |
| --- | --- | --- |
| **Podium** | `final_rank` 1–3 + seeds + character icons | "Seeded 6th, won the whole thing" is itself a fact |
| **Biggest upset (seed)** | seed inversion, weighted by log seed ratio | Works with zero rating data |
| **Biggest upset (rating)** | winner `pre_rating` < loser's; Glicko expected score → "a 12% shot" | Only when rating events exist |
| **Losers-bracket run** | consecutive wins in negative rounds | "Won 5 elimination sets in a row" |
| **Cinderella / overperformer** | `final_rank` vs `challonge_seed` | Classic SPR |
| **Nailbiters** | `scores_csv` deciding-game sets | Needs a small tolerant scores parser |
| **Clean sweep** | won every set without dropping a game | Skip excluded sets |
| **Biggest climb of the night** | Σ(post − pre) per player over the night's rating events | |
| **Movers** | `previousRank` → rank delta (already computed) | Reuse, don't re-derive |
| **Rivalry rematch** | career meeting count + series score from all rating events | "7th career meeting; series now 4–3" |
| **Debuts & milestones** | first event; 50th/100th career set; career-high rating | From career rating-event history |
| **Turnout** | participant count vs recent tournaments | "Biggest turnout since March" |
| **Grand-finals story** | max-round sets; bracket reset detection | "It took a bracket reset" |

### Server

One new public tRPC procedure, `public.tournamentRecap({ slug })` (next to the
existing `tournament` query in `apps/server/src/trpc/routers/public.ts`). It
fetches the rows, calls the engine, and returns ranked facts. The queries are
per-tournament and small; if it ever matters, the result is trivially
cacheable by `(tournamentId, recomputeId, lastSyncedAt)`.

Per-night vs per-bracket: recommend the recap procedure accepts the anchor
tournament but folds in sibling brackets sharing the same `eventKeyOf` (main +
rookie night), sectioning facts by bracket. A rookie's Cinderella run is
exactly the kind of thing a recap should surface.

### Web

A recap header section on `TournamentPage` when `challongeState === 'complete'`:
podium hero (big Oswald numerals, character heads, seed → result), then fact
cards in the scoreboard aesthetic. Facts degrade gracefully — the component
just renders whatever facts came back, so a freshly-finished bracket shows
seed/score facts immediately and gains rating facts after the next recompute
(the page's existing SSE invalidation even makes that live). A dedicated
shareable route can come later without redesign.

---

## 2. Big-screen live view — "venue mode"

A fullscreen view of a live tournament meant for a TV/projector at the club
night: `/tournaments/$slug/live`. This is where animation belongs.

### Layout (steady state)

Route renders without the app chrome (own full-viewport layout + a
`requestFullscreen` button). Panels, all from the existing `tournament` query:

- **Now playing** — sets in `open` state, ordered by `suggested_play_order`,
  with H2H career records between the two players when known.
- **Up next** — the following few pending sets.
- **Results ticker** — recently completed sets (the existing `recentSets`
  logic, promoted).
- **Bracket progress** — completed/total sets as a chunky meter, plus "N sets
  until grand finals".
- **Standings so far** — who's still alive in winners/losers.

### Moments (event-driven)

- **Set resolution takeover.** The client keeps a ref of completed set ids;
  when an SSE-triggered refetch brings a newly completed set, enqueue a
  takeover card (5–8s, queued so simultaneous reports play sequentially):
  winner's name huge, character icons, score, loser below — styled like an
  arcade WINNER screen (hard-cut scanline wipe, the one red, no gradients).
  If the set was an upset (seed or rating inversion), it gets the UPSET
  treatment. No server changes required; optionally enrich `set_updated`'s
  payload with the set id so the animation never depends on refetch timing.
- **Finals escalation.** Derived from remaining sets: when only the max-round
  sets remain, the view shifts into GRAND FINALS mode — banner, both players'
  night-so-far and career H2H side by side, bracket-reset awareness.
- **Live rank movement.** On `recompute_completed`, refetch the leaderboard
  and push movement ticks into the ticker ("Ash ▲3 → #7"). The debounced
  live recompute already makes this correct.
- **Idle carousel.** If nothing completes for ~90s, rotate "tonight so far"
  stat cards (upset of the night so far, current streaks, turnout) so the
  screen is never static.

`prefers-reduced-motion` collapses all of it to fades. Sound: default off,
maybe a toggle later — not in scope.

---

## 3. Smaller delights (player pages & leaderboard)

- **Rivals table on the player page** — most-played opponents with series
  records, best matchup / nemesis. One `rating_events` aggregation; arguably
  the highest delight-per-line-of-code in this whole plan.
- **Career-high marker** on the trajectory chart (max `post_rating`), and
  milestone chips (100th set, 10th event, longest win streak) computed from
  the same events the page already loads.
- **H2H preview** reused in venue mode's "now playing" panel.

---

## Phasing

1. **Facts engine + recap** — pure data work, testable, immediately valuable
   for every *past* tournament too. (engine module + 1 tRPC procedure + recap
   section)
2. **Venue mode MVP** — fullscreen route, panels, ticker, set-resolution
   takeover.
3. **Venue mode escalation** — finals mode, live rank ticks, idle carousel.
4. **Player-page rivalries & milestones.**

Stretch, all reusing the facts engine: shareable recap image, a Slack/Discord
"night in review" post, and an end-of-year club "wrapped".

## Open questions

- Recap scope: per-night (recommended, via `eventKeyOf`) or strictly
  per-bracket?
- Does venue mode want an explicit "hide names / streamer mode"? (Workplace
  club — probably not, but cheap to ask.)
- Should the recap eventually get its own route for sharing, or stay a
  section of the tournament page? (Start as a section; split later if links
  get passed around.)
