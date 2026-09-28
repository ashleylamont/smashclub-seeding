# Development and deployment

## Local rehearsal

Install Node.js 22+ and pnpm 10, then run from the repository root:

```bash
pnpm install
pnpm --filter @smashclub/web dev
```

In another terminal, run `pnpm dev:harness`. The harness applies the real migrations to an in-memory PGlite database, seeds sample tournaments and an event, and enables email/password sign-in for local testing. It prints account credentials and fresh event links on startup. Restarting it resets the data. The web app opens at <http://localhost:5173> and proxies `/api` to port 3000.

To test the built frontend through the same server origin:

```bash
pnpm --filter @smashclub/web build
WEB_DIST_DIR="$PWD/apps/web/dist" pnpm dev:harness
```

Run workspace checks with `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build`. `pnpm rank-eval` compares rating models, and `pnpm golden-check` checks the legacy reference output.

## PostgreSQL-backed server

Create a database, then start the API from the repository root:

```bash
DATABASE_URL=postgres://localhost:5432/smashclub \
MIGRATIONS_DIR="$PWD/packages/db/migrations" \
pnpm dev
```

The server applies migrations on startup. `MIGRATIONS_DIR` matters here because `pnpm dev` runs the server script from `apps/server/`, while migration files live in `packages/db/migrations/`. Start the Vite frontend separately as above. This server uses OAuth for sign-in; the local harness is the way to test credential sign-in without provider setup.

## Configuration

The source of truth is [`apps/server/src/env.ts`](../apps/server/src/env.ts). Values relevant to setup are:

| Variable | Use |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection string for the normal server. |
| `MIGRATIONS_DIR` | SQL migration directory; set explicitly outside the container. |
| `PORT` | API port, default `3000`. |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Auth secret and public base URL for a real deployment. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth provider credentials. |
| `ADMIN_EMAILS` | Comma-separated primary, verified account emails allowed to administer. |
| `CHALLONGE_API_KEY`, `CHALLONGE_USERNAME` | External sync and seeding integration. Native events do not need them. |
| `CHALLONGE_SCORE_WRITES` | Explicit opt-in to send organiser scores upstream; defaults to `false`. Rehearse with a disposable Challonge tournament before enabling it. |
| `WEB_DIST_DIR` | Built frontend directory when Fastify serves the SPA. |
| `TRUST_PROXY` | Set to `true` only behind a trusted proxy so per-client live-feed limits use the forwarded address. |
| `SSE_MAX_*` | Connection, per-IP, lifetime and buffered-byte limits for public live streams. |

`ADMIN_EMAILS` is the admin allowlist. Each request reconciles the stored role with it, so removing an address revokes admin access for an existing session. Match the account's primary sign-up email; an address from a later linked provider does not count. The provider must report that email as verified. Users can link Discord and Google from `/me` after signing in with their original provider; signing in separately with a new provider creates a separate account.

## Initial data

After deploying and configuring the server, import the player registry and historical tournament slugs. Put your registry at `legacy/players.yaml` (a gitignored path; see the [format example](../legacy/players.yaml.example)). Run this from the repository root so `$PWD` resolves the input paths before pnpm starts the tool in its package directory:

```bash
DATABASE_URL=postgres://... pnpm --filter @smashclub/import-registry start \
  --players "$PWD/legacy/players.yaml" \
  --tournaments "$PWD/legacy/challonge_tournaments.txt"
```

Then sign in with an `ADMIN_EMAILS` account, sync tournaments under **Admin → Tournaments**, and resolve unmatched entrants under **Admin → Review**. The scheduler also refreshes registered tournaments. Ratings recompute after eligible results and identity decisions change.

## Kubernetes

The [Dockerfile](../deploy/Dockerfile) builds the web app and server into one image and sets the migration and web paths. The [deployment](../deploy/k8s/deployment.yaml) runs one replica with `Recreate` so the in-process scheduler has one owner; a PostgreSQL advisory lock is a backstop. Copy the [example secret](../deploy/k8s/secret.example.yaml) to `deploy/k8s/secret.yaml` and fill in real values. Replace the image and public `BETTER_AUTH_URL` placeholders in the deployment, then apply the manifests:

```bash
docker build -f deploy/Dockerfile -t <registry>/smashclub:<tag> .
kubectl apply -f deploy/k8s/secret.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/ingress.yaml
```

Keep `secret.yaml` out of version control. Schedule regular database backups; PostgreSQL holds the club's player, event and result records.

The public `/api/live` streams have global and per-IP connection caps, a maximum lifetime and a buffered-byte limit. Set `TRUST_PROXY=true` only when requests pass through the trusted ingress; leave it off for direct exposure.
