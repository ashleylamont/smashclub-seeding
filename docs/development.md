# Development and deployment

## Local rehearsal

Install Node.js 22.23.3+ and pnpm 10, then run from the repository root:

```bash
pnpm install
pnpm --filter @smashclub/web dev
```

In another terminal, run `pnpm dev:harness`. The harness applies the real migrations to an in-memory PGlite database, pairs it with an in-memory Act runtime, seeds sample tournaments and an event, and enables email/password sign-in for local testing. It prints account credentials and fresh event links on startup. Restarting it resets the data and journal. The web app opens at <http://localhost:5173> and proxies `/api` to port 3000.

To test the built frontend through the same server origin:

```bash
pnpm --filter @smashclub/web build
WEB_DIST_DIR="$PWD/apps/web/dist" pnpm dev:harness
```

See [deployment assurance](deployment-assurance.md) for mandatory PostgreSQL, production-image smoke tests and publication guarantees. Run workspace checks with `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm build`. `pnpm lint:fix` applies safe Oxlint fixes, and `pnpm format` writes Prettier formatting. CI runs lint and format as separate checks. The Oxlint config enforces workspace import direction and dependency cycles, checks correctness, React hooks, accessibility, and code style, and limits file size, function size, nesting, and complexity. Named overrides set bounded ceilings for existing large modules. New modules should stay within the default limits, and those ceilings should shrink as large modules are split. Prettier covers active code and configuration; generated migration snapshots, engine fixtures, legacy Python, and prose docs are excluded. `pnpm rank-eval` evaluates WHR variants against independent baselines. Read the [WHR-only migration guide](whr-only-migration.md) before upgrading an existing database.

For browser integration tests, install Playwright's Chromium once, build the web app, then run the suite from the repository root:

```bash
pnpm --filter @smashclub/web exec playwright install chromium
pnpm --filter @smashclub/web build
pnpm test:e2e
```

The browser suite starts a disposable API harness. It exercises event planning, attendance, guest and organiser reporting, native finals, public results, and desktop and mobile layouts. CI uploads page captures and retains traces for failures.

## PostgreSQL-backed server

Create a database, then start the API from the repository root:

```bash
DATABASE_URL=postgres://localhost:5432/smashclub \
MIGRATIONS_DIR="$PWD/packages/db/migrations" \
pnpm dev
```

The server applies migrations on startup. `MIGRATIONS_DIR` matters here because `pnpm dev` runs the server script from `apps/server/`, while migration files live in `packages/db/migrations/`. Start the Vite frontend separately as above. This server uses OAuth for sign-in; the local harness is the way to test credential sign-in without provider setup.

Native event nights use Act-PG in the `native_act` schema by default. Startup imports existing native live/completed nights and recovers pending handoffs before accepting traffic. The normal pool lock establishes ownership for a new night; there is no adoption toggle. Once locked, use the event desk for attendance, resources, scores and pause/resume. Draft SQL editing stays frozen. Publication and rating recovery run durably in the background; the desk exposes publication status, recovery and reviewed result corrections. See [the native API notes](native-live-api.md).

## Configuration

The source of truth is [`apps/server/src/env.ts`](../apps/server/src/env.ts). Values relevant to setup are:

| Variable | Use |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection string for the normal server. |
| `MIGRATIONS_DIR` | SQL migration directory; set explicitly outside the container. |
| `PORT` | API port, default `3000`. |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Auth secret and public base URL for a real deployment. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth provider credentials. |
| `ADMIN_EMAILS` | Comma-separated verified primary emails allowed to bootstrap the first administrator. |
| `CHALLONGE_API_KEY`, `CHALLONGE_USERNAME` | External sync and seeding integration. Native events do not need them. |
| `CHALLONGE_SCORE_WRITES` | Explicit opt-in to send organiser scores upstream; defaults to `false`. Rehearse with a disposable Challonge tournament before enabling it. |
| `WEB_DIST_DIR` | Built frontend directory when Fastify serves the SPA. |
| `TRUST_PROXY` | Set to `true` only behind a trusted proxy so per-client live-feed limits use the forwarded address. |
| `SSE_MAX_*` | Connection, per-IP, lifetime and buffered-byte limits for public live streams. |

`ADMIN_EMAILS` bootstraps the first administrator when the database has no verified admin. The address must be the account's verified primary sign-up email; an address from a later linked provider does not count. After that first promotion, the stored account role controls access. Use **Admin → Admins** to promote a signed-in, verified account or remove an administrator. Changes take effect on that account's next API request, including in an open session. The last verified admin cannot be removed until another account is promoted. Changing `ADMIN_EMAILS` after bootstrap does not add or remove admins; it can be unset once the first admin has signed in.

Users can link Discord and Google from `/me` after signing in with their original provider. Signing in separately with a new provider creates a separate account. Admin access follows the account across linked providers.

## Initial data

After deploying and configuring the server, import the player registry and historical tournament slugs. Put your registry at `legacy/players.yaml` (a gitignored path; see the [format example](../legacy/players.yaml.example)). Run this from the repository root so `$PWD` resolves the input paths before pnpm starts the tool in its package directory:

```bash
DATABASE_URL=postgres://... pnpm --filter @smashclub/import-registry start \
  --players "$PWD/legacy/players.yaml" \
  --tournaments "$PWD/legacy/challonge_tournaments.txt"
```

Then sign in with a verified `ADMIN_EMAILS` bootstrap account, sync tournaments under **Admin → Tournaments**, and resolve unmatched entrants under **Admin → Review**. The scheduler also refreshes registered tournaments. Ratings recompute after eligible results and identity decisions change.

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
