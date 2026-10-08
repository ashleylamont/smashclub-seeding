# Smash Club

Smash Club is a ranking, seeding and event-running app for a workplace Super Smash Bros. club. It publishes a leaderboard, player histories and event results; lets organisers resolve bracket identities and prepare draws; and runs live club nights in Nemesis or alongside Challonge.

## Quick start

Requirements: Node.js 22.23.3+ and pnpm 10.33.0. `.node-version` pins the local and CI runtime; with fnm, run `fnm install && fnm use` in this checkout. The local rehearsal uses PGlite, so it needs no external database, OAuth provider or Challonge credentials.

```bash
pnpm install --frozen-lockfile
pnpm dev:doctor                   # checks the runtime and optional test tools
pnpm dev                         # seeded API + Vite, with source watching
```

Open <http://127.0.0.1:5173/login> and choose a sample account. The rehearsal sign-in form supplies the shared password `devpassword123`. Accounts cover administrator, profile-claim player, event player and event organiser flows. The API prints fresh event links on startup. Its data and event journal reset when it restarts, including after a server source edit.

Development logs default to warnings and errors, with sample credentials and event links printed on startup. Use `LOG_LEVEL=trace pnpm dev` when you need detailed diagnostics.

Vite proxies `/api` to the harness on port 3000. For separate terminals, use `pnpm dev:web` and `pnpm dev:harness`. `pnpm dev:postgres` starts the web app and the persistent PostgreSQL API; see [Development and deployment](docs/development.md) for its `.env` and OAuth setup.

```bash
pnpm check                       # types, lint, formatting, unit/server tests, build
pnpm test:watch                   # feedback while editing logic
pnpm test:ui                     # visual/accessibility fixtures; Chromium required
pnpm test:e2e                    # builds the frontend, then starts a fresh API harness
pnpm test:postgres               # disposable PostgreSQL 17 clusters
pnpm test:image                  # production image smoke check; Docker required
```

Install the browser once with `pnpm --filter @smashclub/web exec playwright install chromium`. `pnpm typecheck` covers frontend source, browser tests, server and packages. Visual baselines are committed for macOS; see [UI review](docs/ui-visual-review.md) before changing snapshots. `pnpm check` does not include browser, PostgreSQL or Docker suites; CI runs those as separate required checks.

## What the app does

- **Rankings and history:** Completed, eligible sets feed a full recompute of player ratings. Whole-History Rating (WHR) is the sole rating system. The public board uses a skill estimate minus a stated attendance penalty, while automatic bracket seeding uses a conservative rating. [Rating and identity notes](docs/rating-and-identity.md) explain the distinction.
- **Identity and privacy:** Challonge names are matched against a player registry. Ambiguous matches go to an admin review queue; fuzzy similarity never merges people automatically. Public pages show chosen aliases or shortened defaults, while canonical names stay in admin workflows.
- **Event planning:** Organisers resolve an attendance list, freeze seeds, divide entrants into Upper and Lower, and build round-robin pools. New plans default to **Nemesis**, which runs pools and finals in the app. Existing and explicitly external plans use **Challonge** handoff and synchronization. [Run an event](docs/event-guide.md) covers both paths.
- **Event night:** The event desk manages stations, match queues, scores, attendance, announcements and displays. Published events have a public board and player hub; reporting can use signed-in accounts or time-limited guest passes. [Event-night details](docs/event-night-refinements.md) and [guest reporting](docs/guest-event-night.md) cover the controls.
- **Results:** Finished native events enter club history and ratings on finalization. Challonge imports refresh through sync; results, recaps and player histories share the same eligible-set rules.

## Repository

| Path | Purpose |
| --- | --- |
| `apps/web/` | React app (Vite, TanStack Router/Query, Recharts) |
| `apps/server/` | Fastify API, auth, event operations, sync and scheduler |
| `packages/engine/` | Pure rating, seeding and recap logic |
| `packages/db/` | Drizzle schema and SQL migrations |
| `packages/shared/` | Shared schemas, names and result rules |
| `tools/` | Registry import, model evaluation, golden checks and asset utilities |
| `deploy/` | Docker image and Kubernetes manifests |
| `legacy/` | Original Python CLI, retained for reference |

## Documentation

- [Documentation index](docs/README.md) — current guides and historical design notes
- [Development and deployment](docs/development.md) — local Postgres, configuration, bootstrap and Kubernetes
- [Run an event](docs/event-guide.md) — planner, Nemesis, Challonge and results
- [Rating and identity notes](docs/rating-and-identity.md) — model, board, seeding, accounts and public names
- [Web app](apps/web/README.md) and [legacy CLI](legacy/README.md)

The database is the system of record. Production starts with one server replica, applies migrations at startup, and should have regular database backups.
