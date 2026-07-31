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
- **Identity is human-decided.** Challonge display names are cleaned
  (company tags, `@` conventions, parentheticals) and matched against player
  aliases; safe structured short-forms auto-link; everything else — including
  every fuzzy match — lands in an admin review queue. Fuzzy similarity never
  merges on its own, and decisions (including "keep separate") are stored so
  a question is never asked twice.
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
`GOOGLE_CLIENT_ID/SECRET`, `ADMIN_EMAILS` (comma-separated; promoted to
admin at login).

`ADMIN_EMAILS` is matched against the account's primary email — the address
from whichever provider was used to *sign up*. Linking a second provider
later does not add its address to that check, so list the one the admin
signed up with.

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
