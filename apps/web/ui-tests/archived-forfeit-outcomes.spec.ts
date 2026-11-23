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
    { ...played, id: 'b', identifier: 'Semi-final 2', resultStage: 'final', scoresCsv: '5-0' },
    {
      ...played,
      id: 'c',
      identifier: 'C',
      scoresCsv: null,
      completedAt: null,
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
  for (const width of [320, 390, 760, 1440]) {
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
      await expect(rows).toHaveCount(4);
      await ready(page);
      const initialWidth = await table.evaluate((region) => ({
        viewport: region.clientWidth,
        content: region.scrollWidth,
        scroll: region.scrollLeft,
      }));
      expect(initialWidth.scroll).toBe(0);
      expect(initialWidth.content).toBe(initialWidth.viewport);
      for (const cell of await rows.nth(1).getByRole('cell').all()) {
        expect(
          await cell.evaluate((element) => {
            const region = element.closest('[role="region"]')!;
            const bounds = region.getBoundingClientRect();
            const text = document.createRange();
            text.selectNodeContents(element);
            return Array.from(text.getClientRects()).every(
              (box) => box.left >= bounds.left && box.right <= bounds.right,
            );
          }),
        ).toBe(true);
      }
      await expect(rows.nth(0).getByText('Forfeit', { exact: true })).toBeInViewport();
      await expect(rows.nth(0)).not.toContainText(/5-0|Played/);
      await expect(rows.nth(0).getByText('excluded', { exact: true })).toBeVisible();
      await expect(rows.nth(1).getByRole('cell', { name: '5-0', exact: true })).toBeVisible();
      await expect(rows.nth(2).getByText('Bye', { exact: true })).toBeVisible();
      await expect(rows.nth(2).getByRole('cell', { name: 'C', exact: true })).toBeVisible();
      await expect(rows.nth(2).getByRole('cell').last()).toHaveText(/^\s*(?:Reported)?\s*—$/);
      const namedSet = rows.nth(3);
      const label = namedSet.getByRole('cell', { name: 'Semi-final 1', exact: true });
      await expect(label).toHaveAttribute('title', 'upper Championship · R3 M1');
      if (width === 1440) await expect(label).toHaveCSS('white-space', 'nowrap');
      await expect(namedSet.getByRole('cell', { name: '2-1', exact: true })).toBeVisible();
      const reportedSet = rows.nth(1);
      const reportedAt = reportedSet.getByRole('cell', { name: /2026.*06:30/i });
      await expect(reportedAt).toBeVisible();
      if (width >= 760) {
        const setName = reportedSet.getByRole('cell', { name: 'Semi-final 2', exact: true });
        for (const cell of [setName, reportedAt]) {
          const lines = await cell.evaluate((element) => {
            const text = document.createRange();
            text.selectNodeContents(element);
            return text.getClientRects().length;
          });
          expect(lines, await cell.innerText()).toBeLessThanOrEqual(width === 1440 ? 1 : 2);
        }
      }
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations,
      ).toEqual([]);
      await page.evaluate(() => scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      await page.screenshot({ path: testInfo.outputPath('archived-outcomes.png'), fullPage: true });
      if (width === 390 || width === 1440) {
        const filter = page.getByRole('combobox', { name: 'Filter sets by stage' });
        await filter.press('ArrowDown');
        await expect(page.getByRole('listbox')).toBeVisible();
        await page.keyboard.press('End');
        await expect(page.getByRole('option', { name: 'Bracket' })).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(rows).toHaveCount(2);
        await expect(rows.first()).toContainText('Semi-final 2');
        await expect(rows.last()).toContainText('Semi-final 1');
      }
    });
  }
}
