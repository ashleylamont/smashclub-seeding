import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { RecapData } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';

const slug = 'shared-club-night';
const path = `/recaps/${slug}`;
const alias = 'An entrant with a long tournament alias for the public results';
const recap = {
  slug,
  name: 'Club night with a long tournament name for the shared recap',
  competitionFormat: 'singles',
  isComplete: true,
  isAbandoned: false,
  entrants: 22,
  setsPlayed: 41,
  tournaments: [
    {
      id: 'main',
      name: 'Open championship',
      slug,
      eventDate: '2026-10-02T08:30:00Z',
      challongeState: 'complete',
      isRookie: false,
    },
  ],
  facts: [
    {
      id: 'podium:main',
      notability: 1,
      headline: 'Open championship podium',
      detail: alias,
      fact: {
        kind: 'podium',
        tournamentId: 'main',
        derived: false,
        places: [
          {
            place: 1,
            seed: null,
            player: { playerId: null, name: alias, companyCode: null, characters: [] },
          },
        ],
      },
    },
  ],
  highlights: [],
  coverage: {
    unsyncedBrackets: 0,
    unresolvedEntrants: 0,
    unlinkedPlayedSets: 0,
    ignoredGroupSets: 0,
  },
} satisfies RecapData;
const serviceError = {
  error: {
    message: 'Synthetic recap computation unavailable',
    code: -32603,
    data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
  },
};

async function reviewRoute(page: Page, testInfo: TestInfo, image: string) {
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`${image}.png`), fullPage: true });
}

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`shared recap retries on the same URL at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockEvent(page);
      fixture.queryResponses.set('public.recap', (input) => {
        expect(input).toEqual({ slug });
        return recap;
      });

      let serviceAvailable = false;
      let releaseRetry!: () => void;
      const retryReleased = new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      await page.route('**/api/trpc/public.recap*', async (route) => {
        if (serviceAvailable) {
          await retryReleased;
          await route.fallback();
          return;
        }
        const batched = new URL(route.request().url()).searchParams.has('batch');
        await route.fulfill({ status: 500, json: batched ? [serviceError] : serviceError });
      });
      await page.goto(path);

      const main = page.getByRole('main');
      await expect(main.getByRole('alert')).toHaveText('Could not load this recap.');
      await expect(main.getByText(serviceError.error.message)).toHaveCount(0);
      const retry = main.getByRole('button', { name: 'Retry' });
      await main.focus();
      await page.keyboard.press('Tab');
      await expect(retry).toBeFocused();
      await reviewRoute(page, testInfo, 'recap-load-error');

      serviceAvailable = true;
      await page.keyboard.press('Enter');
      try {
        await expect(main.getByRole('status')).toHaveText('Retrying recap…');
        await expect(retry).toBeFocused();
        await expect(retry).toBeDisabled();
      } finally {
        releaseRetry();
      }

      const heading = main.getByRole('heading', { name: recap.name, level: 1 });
      await expect(heading).toBeFocused();
      await expect(main.getByText(alias)).toBeVisible();
      await expect(page).toHaveURL(new URL(path, page.url()).toString());
      await expect(main.getByRole('link', { name: 'Event results →' })).toHaveAttribute(
        'href',
        `/events/${slug}`,
      );
      await expect(main.getByRole('button', { name: 'Copy link' })).toBeVisible();
      await reviewRoute(page, testInfo, 'recap-recovered');
      expect(fixture.unexpected).toEqual([]);
    });
  }
}

test('missing shared recap links to tournament results', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  const fixture = await mockEvent(page);
  fixture.responses['public.recap'] = null;
  fixture.responses['public.tournaments'] = [];
  await page.goto(path);

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Recap not found' })).toBeVisible();
  await expect(main.getByRole('alert')).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  const results = main.getByRole('link', { name: 'Browse tournament results' });
  await main.focus();
  await page.keyboard.press('Tab');
  await expect(results).toBeFocused();
  await reviewRoute(page, testInfo, 'recap-missing');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tournaments$/);
  expect(fixture.unexpected).toEqual([]);
});
