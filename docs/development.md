# Development and deployment

## Local rehearsal

Use Node.js 22.23.3+ and pnpm 10.33.0. The checked-in `.node-version` is also used by CI. With fnm, run `fnm install && fnm use`, then:

```bash
pnpm install --frozen-lockfile
pnpm dev:doctor
pnpm dev
```

`pnpm dev` runs Vite and the seeded API together and watches both sources. Open <http://127.0.0.1:5173/login>. Choose Administrator, Player (profile claim), Event player or Event organiser and submit the prefilled sample password. The API exposes enabled sign-in methods; credential UI appears only with the rehearsal harness. Normal servers offer only configured OAuth providers.

The harness applies real migrations to in-memory PGlite, pairs it with an in-memory Act runtime, and seeds tournaments and event scenarios through the real import/recompute paths. It prints account credentials and fresh event links on startup. Restarting it resets data and the journal; server source edits trigger that reset. It has no persistence option. Use PostgreSQL for work that must survive restarts. `DEV_CACHE_DIR=/absolute/path/to/.challonge-cache pnpm dev` optionally rehearses imported history; default fixtures are synthetic.

For separate terminals, use `pnpm dev:web` and `pnpm dev:harness`; the standalone harness resets only when you restart it. Use `pnpm --filter @smashclub/server dev:local` instead for a watched standalone API. Vite proxies `/api` to `127.0.0.1:3000`. Development commands default to `LOG_LEVEL=warn`, retaining warnings/errors and the harness startup summary while suppressing request logs and full Act state dumps. Use `LOG_LEVEL=info pnpm dev` for request logging or `LOG_LEVEL=trace pnpm dev` for detailed event diagnostics. Production defaults to `info`. Ports are strict so a second checkout fails clearly instead of silently moving the frontend. To use another pair of ports, run `PORT=3001 DEV_WEB_PORT=5174 pnpm dev`. These variables also configure the proxy and harness trusted origins.

To test the built frontend through the same server origin:

```bash
pnpm --filter @smashclub/web build
WEB_DIST_DIR="$PWD/apps/web/dist" pnpm dev:harness
```

## Checks

| Command | Coverage and prerequisites |
| --- | --- |
| `pnpm check` | Typecheck, lint, format, unit/server tests and build; no external services. |
| `pnpm typecheck` | App and package source, UI fixtures and E2E tests; does not build frontend assets. |
| `pnpm test:watch` | Vitest watch loop. Server files run serially because each applies migrations to PGlite. |
| `pnpm test:ui` | Isolated visual/accessibility fixtures in Chromium, no API; macOS baselines. |
| `pnpm test:e2e` | Rebuilds the frontend and starts a fresh synthetic API harness. |
| `pnpm test:postgres` | Disposable PostgreSQL 17 clusters, requiring `initdb` and `pg_ctl` on PATH. |
| `POSTGRES_TEST_CONTAINER=1 pnpm test:postgres` | Docker alternative to local PostgreSQL binaries. |
| `pnpm test:image` | Builds and probes the production image; requires a running Docker daemon. |

Install Chromium once before browser checks:

```bash
pnpm --filter @smashclub/web exec playwright install chromium
pnpm test:e2e local-sign-in.spec.ts # optional focused browser run
```

E2E always starts its own harness and ignores `DEV_CACHE_DIR`, preventing an unrelated local process or history cache from changing fixtures. Set `E2E_PORT` (default 3310) or `UI_PORT` (default 3411) when testing another checkout. E2E accepts `CHROMIUM_PATH` to use an explicitly chosen compatible browser. Failures retain screenshots and traces. See [UI review](ui-visual-review.md) and [deployment assurance](deployment-assurance.md) for review and CI requirements.

`pnpm lint:fix` applies safe Oxlint fixes; `pnpm format` writes Prettier formatting. Oxlint checks workspace import direction and cycles, correctness, React hooks, accessibility, and bounded complexity. Existing large modules have named overrides. Prettier excludes generated migration snapshots, engine fixtures, legacy Python, and prose docs. `pnpm rank-eval` evaluates WHR variants against independent baselines.

### Troubleshooting

Run `pnpm dev:doctor` first. It reports Node/pnpm mismatches, missing dependencies, browser installation, PostgreSQL 17 binaries and Docker availability. PostgreSQL, Docker and OAuth are optional for the default rehearsal. Docker builds exclude host dependencies, build/test artifacts and local configuration through `.dockerignore`. A Node mismatch can be corrected for this checkout with `fnm install && fnm use`; changing the global fnm default is unnecessary.

Local servers and Chromium need permission to bind sockets and launch processes. An agent sandbox can reject those operations with `EPERM`, and PostgreSQL can fail to create shared memory there; run the same checks in an ordinary terminal or grant the command access outside that sandbox. These startup failures are not passing tests. If a port is occupied, stop the other rehearsal or select another port.

## PostgreSQL-backed server

Create a local database, then copy and fill in the repository-root configuration:

```bash
createdb smashclub
cp .env.example .env
pnpm dev:postgres
```

Open <http://localhost:5173/login>, matching the example auth origin. The server watches its sources, reads `.env` at startup, and applies migrations using a default path resolved from its module location. `MIGRATIONS_DIR` can override that path. `.env` is ignored by Git. Configure at least one OAuth provider and a verified bootstrap admin email for authenticated development. Native events do not require Challonge credentials. The rehearsal's sample password accounts are never enabled by this server. Use `pnpm --filter @smashclub/server dev` when only the API is needed. When using the built SPA rather than Vite, set `BETTER_AUTH_URL` to its API origin.

Native event nights use Act-PG in the `native_act` schema by default. Startup imports existing native live/completed nights and recovers pending handoffs before accepting traffic. The normal pool lock establishes ownership for a new night; there is no adoption toggle. Once locked, use the event desk for attendance, resources, scores and pause/resume. Draft SQL editing stays frozen. Publication and rating recovery run durably in the background; the desk exposes publication status, recovery and reviewed result corrections. See [the native API notes](native-live-api.md) and read the [WHR-only migration guide](whr-only-migration.md) before upgrading an existing database.

## Configuration

The source of truth is [`apps/server/src/env.ts`](../apps/server/src/env.ts). Values relevant to setup are:

| Variable | Use |
| --- | --- |
| `DATABASE_URL` | Required PostgreSQL connection string for the normal server. |
| `MIGRATIONS_DIR` | SQL migration directory; defaults to the workspace migration folder locally, with an explicit container override. |
| `PORT` | API port, default `3000`. |
| `LOG_LEVEL` | Logger verbosity; development commands default to `warn`, other server starts default to `info`. |
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
