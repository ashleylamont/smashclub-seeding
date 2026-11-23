import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`missing finals explain the next step at ${width}px in ${theme} mode`, async ({
      page,
    }, testInfo) => {
      const fixture = await mockEvent(page, { role: 'player', idle: true });
      for (const match of fixture.snapshot.matches) {
        if (match.stage !== 'group' || match.status === 'complete') continue;
        Object.assign(match, {
          status: 'complete',
          outcome: 'played',
          winnerId: match.player1Id,
          score1: 2,
          score2: 0,
        });
      }
      Object.assign(fixture.overview, {
        stationQueues: [],
        reports: fixture.overview.reports.filter(({ status }) => status !== 'pending'),
        finalization: {
          kind: 'missing_draw',
          message: 'Create the missing finals draws before publishing results.',
        },
      });
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      await page.goto(`/operate/${PLAN_ID}?view=draw`);
      const finalize = page.getByRole('button', { name: 'Finalize native results', exact: true });
      await expect(finalize).toBeDisabled();
      await expect(finalize).toHaveAccessibleDescription(/Create the missing finals draws/);
      await page.getByRole('button', { name: 'Go to finals preview' }).press('Enter');
      await expect(page.getByRole('button', { name: 'Preview finals', exact: true })).toBeFocused();
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (
          await new AxeBuilder({ page })
            .include('.ops-page')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({
        path: testInfo.outputPath(`missing-finals-${theme}-${width}.png`),
        fullPage: true,
      });
      expect(fixture.unexpected).toEqual([]);
    });
