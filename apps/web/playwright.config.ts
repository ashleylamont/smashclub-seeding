import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the dev harness, which serves the built SPA and the real API
 * from one origin backed by an in-process Postgres. Playwright's installed
 * Chromium is used by default; CHROMIUM_PATH can override it when needed.
 *
 * The harness seeds and recomputes before listening, which takes a while, hence
 * the generous server timeout.
 */
const PORT = Number(process.env.E2E_PORT ?? 3310);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @smashclub/server dev:harness',
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 240_000,
    cwd: '../..',
    env: {
      PORT: String(PORT),
      WEB_DIST_DIR: new URL('./dist', import.meta.url).pathname,
      ...(process.env.DEV_CACHE_DIR ? { DEV_CACHE_DIR: process.env.DEV_CACHE_DIR } : {}),
    },
  },
});
