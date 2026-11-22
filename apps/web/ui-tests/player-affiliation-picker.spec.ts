import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const) {
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px distinguishes matching player aliases by public affiliation`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      const fixture = await mockEvent(page);
      const ids = [
        ...new Set(
          fixture.snapshot.matches
            .filter((match) => match.division === 'upper' && match.poolIndex === 0)
            .flatMap((match) => [match.player1Id!, match.player2Id!]),
        ),
      ]
        .sort()
        .slice(0, 3);
      const alias = 'Tom with a very long tournament alias';
      const codes = ['ATL', 'CAN', null];
      for (const entry of fixture.snapshot.entrants) {
        const index = ids.indexOf(entry.id);
        if (index !== -1) Object.assign(entry, { name: alias, companyCode: codes[index] });
      }
      for (const match of fixture.snapshot.matches) {
        if (ids.includes(match.player1Id!)) match.player1Name = alias;
        if (ids.includes(match.player2Id!)) match.player2Name = alias;
      }

      await page.goto(`/play/${PLAN_ID}#my-matches`);
      const trigger = page.getByRole('combobox', { name: 'Show matches for', exact: true });
      await expect(trigger).toHaveAttribute('data-value', '');
      await trigger.press('Enter');
      const list = page.getByRole('listbox');
      const affiliates = list.getByRole('option', {
        name: /Tom with a very long tournament alias/,
      });
      await expect(affiliates).toHaveCount(3);
      const atl = affiliates.filter({ hasText: 'ATL' });
      const can = affiliates.filter({ hasText: 'CAN' });
      await expect(atl).toHaveAccessibleName(`${alias} · Upper Pool A ATL`);
      await expect(can).toHaveAccessibleName(`${alias} · Upper Pool A CAN`);
      await expect(affiliates.last()).toHaveAccessibleName(`${alias} · Upper Pool A`);
      await page.keyboard.press('t');
      await expect(atl).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(can).toBeFocused();
      await ready(page);
      await expect(list).toBeInViewport({ ratio: 0.99 });
      await expect(can.getByText('CAN', { exact: true })).toBeInViewport({ ratio: 0.99 });
      expect(
        (
          await new AxeBuilder({ page })
            .include('[role="option"]')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('open-affiliation-picker.png') });

      await page.keyboard.press('Enter');
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute('data-value', ids[1]!);
      await expect(trigger.getByText('CAN', { exact: true })).toBeInViewport({ ratio: 0.99 });
      await trigger.press('Enter');
      await expect(can).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute('data-value', ids[1]!);
      await expect(
        page.getByText('Showing only this player’s matches.', { exact: false }),
      ).toBeVisible();
      await expect(page.locator('article.ops-match input')).toHaveCount(0);
      expect(fixture.submissions).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (
          await new AxeBuilder({ page })
            .include('.player-event-hub')
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('selected-affiliation.png') });
    });
  }
}
