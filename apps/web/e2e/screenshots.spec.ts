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

/** Slug of a bracket Challonge reports as finished, or null if none has. */
async function completedTournamentSlug(page: Page): Promise<string | null> {
  const response = await page.request.get('/api/trpc/public.tournaments');
  if (!response.ok()) return null;
  const body = (await response.json()) as {
    result?: { data?: Array<{ slug: string; challongeState: string | null }> };
  };
  return body.result?.data?.find((t) => t.challongeState === 'complete')?.slug ?? null;
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

        /*
         * Venue mode, from the live bracket. It hides the app shell and paints
         * the whole viewport, so the assertions check both: its own content is
         * there and the nav is gone.
         */
        await page.goto('/tournaments');
        await settle(page);
        const liveLink = page
          .locator('.section')
          .filter({ has: page.locator('h2', { hasText: 'Live' }) })
          .locator('a[href^="/tournaments/"]')
          .first();
        if (await liveLink.count()) {
          await liveLink.click();
          await page.locator('.tournament-venue-link').click();
          await expect(page).toHaveURL(/\/tournaments\/.+\/live/);
          await expect(page.locator('.venue-header h1')).toBeVisible();
          await expect(page.locator('.venue-results')).toBeVisible();
          await expect(page.locator('.app-nav')).toBeHidden();
          await capture(page, `venue-${viewport.label}-${scheme}`);
        }

        /*
         * The night's recap, reached the way a reader would — from its bracket.
         *
         * The bracket is chosen from the API rather than by picking one out of
         * the list, because it has to be a *finished* one: a live bracket has
         * no podium yet, so landing on whichever tournament happens to sort
         * first would assert nothing about the part of the page that matters.
         */
        const finishedSlug = await completedTournamentSlug(page);
        if (finishedSlug) {
          await page.goto(`/tournaments/${finishedSlug}`);
          await settle(page);
          await page.locator('.tournament-recap-link:not(.tournament-venue-link)').click();
          await expect(page).toHaveURL(/\/recaps\/.+/);
          // A recap with no facts at all would still render its shell, so this
          // asserts real content rather than an empty page.
          await expect(page.locator('.recap-podiums .podium').first()).toBeVisible();
          await expect(page.locator('.fact-grid .fact-card').first()).toBeVisible();
          await capture(page, `recap-${viewport.label}-${scheme}`);
        }

        expect(errors, `uncaught page errors: ${errors.join('; ')}`).toEqual([]);
        await context.close();
      });
    }
  }
});
