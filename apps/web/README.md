# Smash Club web app

React and TypeScript frontend for the [Smash Club workspace](../../README.md). Vite serves it locally; the production Fastify server serves its built `dist/` directory.

## Run locally

From the repository root, install dependencies and start the web app and API in separate terminals:

```bash
pnpm install
pnpm --filter @smashclub/web dev
```

```bash
pnpm dev:harness
```

Open <http://localhost:5173>. Vite proxies `/api` to the harness on port 3000. The harness uses disposable PGlite data and prints its sample event URLs and sign-in credentials. For a PostgreSQL-backed server, follow [Development and deployment](../../docs/development.md).

## Checks

```bash
pnpm --filter @smashclub/web lint
pnpm --filter @smashclub/web build
```

The frontend has Playwright scenarios in `apps/web/e2e/`. After building, run `pnpm --filter @smashclub/web exec playwright test` with a compatible Chromium configured as described in `playwright.config.ts`; the test runner starts its own disposable API harness. Character icon sources and refresh steps are in [public/characters/README.md](public/characters/README.md).
