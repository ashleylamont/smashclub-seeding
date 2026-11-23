import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { TournamentListItem } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';

const eventName = 'Club night with a long tournament name for the autumn archive';
const openBracket = {
  id: 'archived-open',
  slug: 'archive-open',
  provider: 'native',
  competitionFormat: 'singles',
  nativeEventId: 'archive-event',
  nativeEventName: eventName,
  name: 'Open championship',
  eventDate: '2026-10-02T08:30:00Z',
  isRookie: false,
  resultsMode: 'auto',
  challongeState: 'complete',
  syncState: 'synced',
  lastSyncedAt: '2026-10-02T08:30:00Z',
  liveUntil: null,
} satisfies TournamentListItem;
const consolation = {
  ...openBracket,
  id: 'archived-consolation',
  slug: 'archive-consolation',
  name: 'Consolation bracket',
} satisfies TournamentListItem;

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
    test(`archive index keeps each destination distinct at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockEvent(page);
      fixture.responses['public.tournaments'] = [openBracket, consolation];
      await page.goto('/tournaments');
      const event = page.getByRole('link', { name: eventName, exact: true });
      await expect(event).toBeVisible();
      await expect(event).toHaveCSS('text-decoration-line', 'underline');
      await event.focus();
      await expect(event).toBeFocused();
      await reviewRoute(page, testInfo, 'archive-index');
      const links = page.locator('.tournament-event-card').getByRole('link');
      const destinations = await links.evaluateAll((items) =>
        items.map((item) => item.getAttribute('href')),
      );
      expect(new Set(destinations).size).toBe(destinations.length);
      expect(destinations).toEqual(
        expect.arrayContaining([
          await event.getAttribute('href'),
          `/tournaments/${openBracket.slug}`,
          `/tournaments/${consolation.slug}`,
          await page.getByRole('link', { name: 'Recap →', exact: true }).getAttribute('href'),
        ]),
      );
      expect(destinations).toHaveLength(4);
      await page.keyboard.press('Tab');
      await expect(
        page.locator('.tournament-event-card .event-bracket-link').first(),
      ).toBeFocused();
      expect(fixture.unexpected).toEqual([]);
    });

    test(`recap without highlights leads to recorded results at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockEvent(page);
      fixture.responses['public.recap'] = {
        slug: openBracket.slug,
        name: eventName,
        competitionFormat: 'singles',
        isComplete: true,
        isAbandoned: false,
        entrants: 3,
        setsPlayed: 2,
        tournaments: [openBracket],
        facts: [],
        highlights: [],
        coverage: {
          unsyncedBrackets: 0,
          unresolvedEntrants: 0,
          unlinkedPlayedSets: 0,
          ignoredGroupSets: 0,
        },
      };
      await page.goto(`/recaps/${openBracket.slug}`);
      await expect(page.getByRole('heading', { name: eventName, level: 1 })).toBeVisible();
      const results = page.getByRole('link', { name: 'Event results →', exact: true });
      await expect(results).toHaveAttribute('href', `/events/${openBracket.slug}`);
      await results.focus();
      await expect(results).toBeFocused();
      await reviewRoute(page, testInfo, 'recap-without-highlights');
      await expect(page.getByRole('heading', { name: 'Highlights', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Brackets', exact: true })).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: openBracket.name, exact: true })).toBeFocused();
      expect(fixture.unexpected).toEqual([]);
    });
  }
}
