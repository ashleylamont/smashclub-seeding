import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { chooseOption } from '../test-support/controls';
import { mockEvent, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`new event plan names the read-only pool size at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const { responses, unexpected } = await mockEvent(page, { role: 'admin' });
      responses['admin.eventPlanner.projectTournament'] = { formats: [] };
      await page.goto('/admin/event-planner');
      await expect(page.getByRole('heading', { name: 'New event plan' })).toBeVisible();
      await expect(page.getByText('No plans yet.')).toBeVisible();
      await page.getByRole('button', { name: 'Explore timeline, run order and brackets' }).click();
      await page.getByRole('button', { name: 'Timing and division assumptions' }).click();
      await ready(page);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);

      const poolSize = page.getByRole('textbox', { name: 'Pool size', exact: true });
      await expect(poolSize).toHaveJSProperty('readOnly', true);
      await expect(poolSize).toHaveValue('4');
      await expect(poolSize).toHaveAccessibleDescription('Pools balance around four entrants.');
      await page.getByText('Pool size', { exact: true }).click();
      await expect(poolSize).toBeFocused();
      await poolSize.press('Tab');
      await expect(page.getByRole('textbox', { name: /Attendance list/ })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: testInfo.outputPath('new-event-plan.png'), fullPage: true });

      const structure = page.getByRole('combobox', { name: 'Tournament structure', exact: true });
      await chooseOption(structure, 'single_elimination');
      await expect(poolSize).toHaveValue('No pool stage');
      await expect(poolSize).toHaveJSProperty('readOnly', true);
      await expect(poolSize).toHaveAccessibleDescription(
        'Play starts in the seeded knockout bracket.',
      );

      await chooseOption(structure, 'round_robin');
      await expect(poolSize).toHaveValue('All entrants');
      await expect(poolSize).toHaveJSProperty('readOnly', true);
      await expect(poolSize).toHaveAccessibleDescription('One pool contains the whole field.');
      expect(unexpected).toEqual([]);
    });
