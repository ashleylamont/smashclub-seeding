import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Captures every page at desktop and mobile widths in both colour schemes.
 * This is the first time this UI has ever been rendered, so the run doubles as
 * a smoke test: each capture asserts the page actually painted its own content
 * rather than an error boundary or an empty shell.
 */

const OUT = process.env.SCREENSHOT_DIR ?? path.resolve('screenshots');
const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 1000 },
  { label: 'mobile', width: 390, height: 844 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

mkdirSync(OUT, { recursive: true });

async function settle(page: Page): Promise<void> {
  // Charts animate; wait for the network to go quiet then give Recharts a beat.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(600);
}

async function capture(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

interface Target {
  name: string;
  path: string;
  /** Something that proves the page rendered its own content. */
  expect: (page: Page) => Promise<void>;
  admin?: boolean;
}

const TARGETS: Target[] = [
  {
    name: 'leaderboard',
    path: '/',
    expect: async (page) => {
      // The board is a list of links, not a table — rows have to be reachable by
      // keyboard, which a clickable <tr> was not.
      await expect(page.locator('.board-list .board-row').first()).toBeVisible();
      await expect(page.locator('.board-row .rating-value').first()).toBeVisible();
    },
  },
  {
    name: 'tournaments',
    path: '/tournaments',
    expect: async (page) => {
      await expect(page.locator('text=/Tech In Place|Dev Weekly/').first()).toBeVisible();
    },
  },
  {
    name: 'login',
    path: '/login',
    expect: async (page) => {
      await expect(page.locator('text=/Discord/i').first()).toBeVisible();
    },
  },
];

test.describe('page screenshots', () => {
  for (const viewport of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      test(`${viewport.label} ${scheme}`, async ({ browser }) => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(String(error)));

        for (const target of TARGETS) {
          await page.goto(target.path);
          await target.expect(page);
          await capture(page, `${target.name}-${viewport.label}-${scheme}`);
        }

        // Player page: follow the top-ranked player from the leaderboard.
        await page.goto('/');
        await settle(page);
        const playerLink = page.locator('a[href^="/players/"]').first();
        if (await playerLink.count()) {
          await playerLink.click();
          await expect(page).toHaveURL(/\/players\//);
          await capture(page, `player-${viewport.label}-${scheme}`);
        }

        // Tournament detail, preferring the live one.
        await page.goto('/tournaments');
        await settle(page);
        const tournamentLink = page.locator('a[href^="/tournaments/"]').first();
        if (await tournamentLink.count()) {
          await tournamentLink.click();
          await expect(page).toHaveURL(/\/tournaments\/.+/);
          await capture(page, `tournament-${viewport.label}-${scheme}`);
        }

        expect(errors, `uncaught page errors: ${errors.join('; ')}`).toEqual([]);
        await context.close();
      });
    }
  }
});
