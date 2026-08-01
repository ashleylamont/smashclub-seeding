# Smash Club

Full-stack ranking and seeding app for a workplace Super Smash Bros. club:
Glicko-2 ratings computed from Challonge tournament history, a public
leaderboard with per-player rating charts, OAuth login with claimable player
profiles, an admin review queue for player-identity resolution, a seeding
workbench that pushes seeds back to Challonge, and near-real-time live
tournament feeds.

This replaces the original Python CLI (kept in [`legacy/`](legacy/) as the
reference implementation during the rework; see its README for the old
workflow).

## How it works

- **Sets are the source of truth.** Tournaments are synced from Challonge
  (idempotent upserts keyed by Challonge IDs). Ratings are derived: every
  recompute replays the full set history through the Glicko-2 engine and
  writes `rating_events` + `player_ratings` under a new `recomputes` row.
  Readers always use the latest complete recompute.
- **The board ranks cautiously.** Both the leaderboard and bracket seeding
  order on the conservative rating — the skill estimate less two standard
  deviations — so a place is earned in sets and held by turning up: missing
  club nights widens the deviation and costs places. The estimate and its ±
  band are shown next to it. Movement arrows compare against a replay with
  the most recent club night withheld, so they report what the games did and
  not what the last recompute happened to change.
- **The board shows the current field.** Players with no event in the last
  year are hidden by default (a setting on the rankings screen). A rank is a
  position *within* a field, so both the rank and the rank it is compared
  against are re-derived over the players on screen: ranks run 1..n with no
  holes, and ▲2 always means "passed two people who are still playing"
  rather than "two people above you aged out".
- **Identity is human-decided.** Challonge display names are cleaned
  (company tags, `@` conventions, parentheticals) and matched against player
  names *and* their stored aliases; safe structured short-forms auto-link;
  everything else — including every fuzzy match — lands in an admin review
  queue, where a reviewer can also look up any player by hand. Fuzzy
  similarity never merges on its own, and decisions (including "keep
  separate") are stored so a question is never asked twice.

  How *durable* an automatic link is tracks how strong the evidence was. An
  exact alias or a stored decision is a club record being recognised, so it
  links and stands. A structured short form ("Josh C") is only an inference
  from the pool as it stands today, so it links this participant and writes
  nothing — the moment a second Josh C. makes it ambiguous the name falls
  through to review instead of resolving silently on a year-old guess.

  A bracket roster is upstream input, though, and a display name is not proof
  of identity: whoever controls a name in a registered bracket chooses which
  existing alias it matches. Registering a bracket is admin-only and every
  link is reversible from **Admin → Review** and **Admin → Players**, which
  is the control that makes this acceptable — so register brackets you know,
  and treat a roster you did not recognise as something to review.
- **Live mode.** Tournaments that are underway on Challonge are polled every
  ~15s; changed sets trigger a debounced recompute and push SSE events to
  viewers on the tournament page.

## Repository layout

```
packages/engine/     Pure Glicko-2 + parsing/identity logic (no I/O)
packages/db/         Drizzle schema + SQL migrations
packages/shared/     zod schemas shared across packages (glicko settings)
apps/server/         Fastify: tRPC API, better-auth, SSE, sync scheduler
apps/web/            React SPA (Vite, TanStack Router/Query, Recharts)
tools/import-registry/  One-off bootstrap importer (players.yaml, slugs)
deploy/              Dockerfile + k8s manifests
legacy/              The original Python CLI (reference; removed post-rework)
```

## Development

Requirements: Node 22+, pnpm 10, a Postgres (or use PGlite-backed tests).

```bash
pnpm install
pnpm test                 # engine unit tests + server integration tests (PGlite)
pnpm typecheck
pnpm -r build

# Run the server (needs DATABASE_URL; migrations apply at startup)
DATABASE_URL=postgres://localhost:5432/smashclub pnpm dev

# Run the web app with API proxy to :3000
pnpm --filter @smashclub/web dev
```

Environment variables (see `apps/server/src/env.ts`): `DATABASE_URL`
(required), `CHALLONGE_API_KEY` + `CHALLONGE_USERNAME`,
`BETTER_AUTH_SECRET` + `BETTER_AUTH_URL`, `DISCORD_CLIENT_ID/SECRET`,
`GOOGLE_CLIENT_ID/SECRET`, `ADMIN_EMAILS` (comma-separated), `TRUST_PROXY`,
and the `SSE_MAX_*` live-feed limits.

### Administrators

`ADMIN_EMAILS` is the **single source of truth** for admin access. The
`user.role` column is a cache of it: every request reconciles the two in both
directions, so

- adding an address grants admin on that account's next call, and
- **removing one revokes it just as promptly** — including for a session that
  is already signed in, and for every provider linked to that account.

There is deliberately no way to pin an admin in the database that the
allowlist will not take back; a role nothing can revoke is a role nobody can
offboard. Offboarding is exactly "remove the address and redeploy" — no SQL,
no session invalidation step to forget.

`ADMIN_EMAILS` is matched against the account's primary email — the address
from whichever provider was used to *sign up*. Linking a second provider
later does not add its address to that check, so list the one the admin
signed up with. The address must also be one the provider reports as
**verified**: Discord hands out unverified addresses for accounts that never
confirmed their email, and an unverified address is not evidence that whoever
is signing in controls the allowlisted mailbox.

### Accounts and providers

Identity is the user row, never an email address. Discord and Google can be
linked to one account even when their email addresses differ, so a work
Google account and a personal Discord one land on the same player claim.

Linking happens from **/me** while signed in. Signing in with a
not-yet-linked provider creates a *separate* account instead — nothing can
match two providers up before the user has proven they own both — so the
sign-in page tells people to sign in with their original provider first and
link from there.

### Character head icons

Players can pin up to four fighters, drawn as head icons beside their name.
The PNGs live in `apps/web/public/characters/` and are committed — Vite
copies `public/` into `dist/` at build time and the server serves `dist/`,
so an icon absent from the build context is absent from the deployed image.

To refresh them after a roster change, use either
`pnpm --filter @smashclub/fetch-character-icons start` or the standalone
`tools/fetch-character-icons/fetch-icons.sh` (bash, curl and python3 only;
emits a zip), then rebuild the web app. See
`apps/web/public/characters/README.md`.

Every icon falls back to a two-letter badge, so a fighter without one is a
cosmetic gap rather than a broken page.

## Production bootstrap

1. Deploy (below) with secrets set.
2. Import the player registry and historical tournaments:
   ```bash
   DATABASE_URL=... pnpm --filter @smashclub/import-registry start \
     --players players.yaml --tournaments legacy/challonge_tournaments.txt
   ```
3. Log in with an `ADMIN_EMAILS` account, open **Admin → Tournaments**, and
   sync the registered tournaments (the scheduler will also pick them up).
4. Work through **Admin → Review** once — the initial sync queues every name
   the registry aliases don't cover. Ratings recompute automatically as
   items are resolved.

## Deployment (k8s)

One container (server serves the built SPA), one replica,
`strategy: Recreate` — the in-process scheduler must not double-run (a pg
advisory lock is the backstop). Startup applies DB migrations.

```bash
docker build -f deploy/Dockerfile -t <registry>/smashclub:<tag> .
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/ingress.yaml   # SSE annotations included
# secrets: see deploy/k8s/secret.example.yaml
```

The database is the club's system of record — schedule backups (e.g.
CloudNativePG with scheduled `pg_dump` to object storage).

### Live-feed limits

`/api/live` is public and long-lived, so the server bounds what an anonymous
client can make it hold: a global cap on concurrent streams
(`SSE_MAX_CONNECTIONS`), a per-client cap (`SSE_MAX_CONNECTIONS_PER_IP`), a
maximum stream lifetime (`SSE_MAX_STREAM_MS`) after which the server hangs up
on its own, and a buffered-bytes ceiling (`SSE_MAX_BUFFERED_BYTES`) that
closes a consumer which has stopped reading. Excess streams get
`503` + `Retry-After` rather than a socket. `EventSource` reconnects by
itself, so the lifetime close is invisible in the browser; a refused stream
is not retried, so a client over the cap keeps a working page that stops
live-updating until it is reloaded. Size the per-client cap with that in
mind — every open tab is one stream and a live tournament page is two.

Set `TRUST_PROXY=true` behind the ingress. Without it every request appears
to come from the ingress pod and the per-client cap collapses into a second
global one; with it, Fastify reads the client address from
`X-Forwarded-For`. Leave it off if the server is ever exposed directly —
otherwise clients pick their own address.

## Rating system notes

The engine faithfully ports the club's tuned system: per-set rating periods,
per-tournament inverse-diminishing match weights, rookie-bracket scaling,
missed-tournament RD decay, and a conservative seeding score
(`effective_rating − 2 × effective_rd` with confidence anchoring). Three
legacy bugs were fixed rather than ported — rookie scaling now uses the
current set's winner, trailing inactivity decay affects seeding, and sets
replay in deterministic chronological order (input order no longer changes
ratings) — so historical numbers differ slightly from the old CLI exports.
All tunables live in the admin settings page; changes trigger a recompute.
