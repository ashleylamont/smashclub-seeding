import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright specs must never be collected by vitest — they use a different
    // runner and fail confusingly if globbed (easy to hit by running vitest
    // from inside apps/web).
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
    projects: [
      {
        test: {
          name: 'engine',
          include: ['packages/engine/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server',
          include: ['apps/server/test/**/*.test.ts'],
          /**
           * Each server test boots its own in-process Postgres (PGlite) and
           * applies every migration, which is slow and memory-hungry. Run these
           * files one at a time with a generous timeout — in parallel they
           * contend and overrun the default 5s limit.
           */
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
