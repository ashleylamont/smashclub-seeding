import { defineConfig } from '@playwright/test';

const port = Number(process.env.UI_PORT ?? 3411);
const baseURL = `http://127.0.0.1:${port}`;

/** Fixed API fixtures; no backend, database, OAuth or production requests. */
export default defineConfig({
  testDir: './ui-tests',
  outputDir: './ui-test-results',
  timeout: 30_000,
  expect: { timeout: 5000, toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.003 } },
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/ui', open: 'never' }]],
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
