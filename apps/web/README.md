# Smash Club web app

React and TypeScript frontend for the [Smash Club workspace](../../README.md). Vite serves it locally; the production Fastify server serves its built `dist/` directory.

## Run locally

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173/login> and choose a sample account. Vite proxies `/api` to the disposable seeded harness on port 3000. Server edits reset rehearsal data. Separate terminals can run `pnpm dev:web` and `pnpm dev:harness`. Persistent PostgreSQL and OAuth setup is in [Development and deployment](../../docs/development.md).

Development logs default to `warn`. Set `LOG_LEVEL=info` for request logging or `LOG_LEVEL=trace` for full event diagnostics before `pnpm dev`.

## Checks

```bash
pnpm lint                        # workspace Oxlint config, including the frontend
pnpm --filter @smashclub/web typecheck
pnpm --filter @smashclub/web build
pnpm --filter @smashclub/web exec playwright install chromium
pnpm test:ui
pnpm test:e2e                    # rebuilds the frontend first
```

The frontend typecheck includes source, UI fixtures and browser tests. `apps/web/e2e/` tests use a fresh real API harness; `apps/web/ui-tests/` uses isolated API fixtures and macOS visual baselines. See [UI review](../../docs/ui-visual-review.md) before updating baselines. Character icon sources and refresh steps are in [public/characters/README.md](public/characters/README.md).

The homepage's **Currently live** entry uses the public event discovery feed and refreshes every 15 seconds. It shows published events whose lifecycle is underway, whose draw is open, and whose scheduled start is within the previous 24 hours (start inclusive, end exclusive). The bounded start window prevents future prelocked draws and old unfinalized events from occupying the homepage, while supporting overnight play across local midnight. It compares ISO instants, independent of the viewer's timezone. This is homepage eligibility only: the event directory, public hub and reporting permissions continue to follow the authoritative event lifecycle.
