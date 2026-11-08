import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { TournamentData, TournamentSet } from '../src/lib/apiTypes';
import { rpcProcedures } from '../test-support/rpcBatch';
import { ready } from './fixtures';

const eventDate = '2026-09-29T08:30:00.000Z';
const played = {
  round: 1,
  resultStage: 'group',
  state: 'complete',
  winner: 1,
  excludedByResultsMode: false,
  excludedFromRatings: false,
  completedAt: eventDate,
  p1ParticipantId: null,
  p2ParticipantId: null,
  p1Name: 'Alex with an exceptionally long tournament alias',
  p2Name: 'Bea with another long tournament alias',
  p1PlayerId: null,
  p2PlayerId: null,
  unplayedOutcome: null,
} satisfies Omit<TournamentSet, 'id' | 'identifier' | 'scoresCsv'>;
const tournament: TournamentData = {
  id: 'archive-fixture',
  slug: 'archived-sets',
  provider: 'native',
  competitionFormat: 'singles',
  name: 'Archived tournament results',
  resultsMode: 'auto',
  eventDate,
  isRookie: false,
  challongeState: 'complete',
  syncState: 'synced',
  lastSyncedAt: eventDate,
  liveUntil: null,
  participants: [],
  sets: [
    {
      ...played,
      id: 'a',
      identifier: 'A',
      scoresCsv: '5-0',
      unplayedOutcome: 'forfeit',
      excludedFromRatings: true,
    },
    { ...played, id: 'b', identifier: 'B', scoresCsv: '5-0' },
    {
      ...played,
      id: 'c',
      identifier: 'C',
      scoresCsv: null,
      unplayedOutcome: 'bye',
      excludedFromRatings: true,
    },
    {
      ...played,
      id: 'd',
      resultStage: 'final',
      round: 3,
      identifier: 'upper Championship · R3 M1',
      displayLabel: 'Semi-final 1',
      scoresCsv: '2-1',
    },
  ],
};

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`archived forfeits and played scores are distinct at ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.route('**/api/**', async (route) => {
        const url = route.request().url();
        if (url.includes('/api/auth/')) return route.fulfill({ json: null });
        if (url.endsWith('/api/live'))
          return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
        const results = rpcProcedures(url).map((procedure) => {
          expect(procedure).toBe('public.tournament');
          return { result: { data: tournament } };
        });
        await route.fulfill({
          json: new URL(url).searchParams.has('batch') ? results : results[0],
        });
      });
      await page.goto('/tournaments/archived-sets');
      const table = page.getByRole('region', { name: 'Tournament sets' });
      const rows = table.locator('tbody tr');
      await expect(rows.nth(0).getByText('Forfeit', { exact: true })).toBeInViewport();
      await expect(rows.nth(0)).not.toContainText(/5-0|Played/);
      await expect(rows.nth(1).getByRole('cell', { name: '5-0', exact: true })).toBeVisible();
      await expect(rows.nth(2).getByText('Bye', { exact: true })).toBeVisible();
      await expect(rows.nth(2).getByRole('cell', { name: 'C', exact: true })).toBeVisible();
      const namedSet = rows.nth(3);
      const label = namedSet.getByRole('cell', { name: 'Semi-final 1', exact: true });
      await expect(label).toHaveAttribute('title', 'upper Championship · R3 M1');
      await expect(label).toHaveCSS('white-space', 'nowrap');
      await expect(namedSet.getByRole('cell', { name: '2-1', exact: true })).toBeVisible();
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      if (width === 390) {
        await table.focus();
        await expect(table).toBeFocused();
        for (let step = 0; step < 8; step++) await table.press('ArrowRight');
        await expect.poll(() => table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      }
      await table.evaluate((element) => {
        element.scrollLeft = 0;
      });
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath('archived-outcomes.png'), fullPage: true });
    });
  }
}
