import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { footerMetadataCapturePath } from './ui-tests/captureStyles';

const port = Number(process.env.UI_PORT ?? 3411);
const baseURL = `http://127.0.0.1:${port}`;
const executionReport = process.env.UI_EXECUTION_REPORT;
const reporter: PlaywrightTestConfig['reporter'] = [
  ['list'],
  ['html', { outputFolder: 'playwright-report/ui', open: 'never' }],
];
if (executionReport) reporter.push(['json', { outputFile: executionReport }]);

/** Fixed API fixtures; no backend, database, OAuth or production requests. */
export default defineConfig({
  testDir: './ui-tests',
  outputDir: './ui-test-results',
  timeout: 30_000,
  expect: {
    timeout: 5000,
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.003,
      stylePath: footerMetadataCapturePath,
    },
  },
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter,
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
