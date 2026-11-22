import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

const reviewPolicy = 'TO approval / existing pool settings';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`score approval fits Settings at ${width}px in ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      const { overview, unexpected } = await mockEvent(page, { role: 'admin' });
      overview.plan.name = 'Western Sydney Championship · November tournament night';
      await page.goto(`/admin/event-operations?plan=${PLAN_ID}&view=settings`);

      const settings = page.getByRole('tabpanel', { name: 'Settings' });
      const policy = settings.getByRole('combobox', { name: 'Event score policy' });
      await expect(policy).toBeEnabled();
      await expect(policy).toContainText(reviewPolicy);
      await ready(page);
      const documentWidth = () => page.evaluate(() => document.documentElement.scrollWidth);
      expect(await documentWidth()).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true });

      await policy.press('Enter');
      const menu = page.getByRole('listbox');
      const review = menu.getByRole('option', { name: reviewPolicy, exact: true });
      await expect(review).toBeFocused();
      expect(await documentWidth()).toBe(width);
      const bounds = (await menu.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await menu.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
        await menu.evaluate((element) => element.clientWidth),
      );
      await page.screenshot({ path: testInfo.outputPath('score-policy-open.png') });

      await page.keyboard.press('ArrowDown');
      await expect(menu.getByRole('option', { name: 'Approve unless disputed' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(policy).toBeFocused();
      await expect(policy).toHaveAttribute('data-value', 'to_review');
      expect(unexpected).toEqual([]);
    });

test('assigned organisers see their current score policy in phone Settings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { unexpected } = await mockEvent(page, { role: 'player' });
  await page.goto(`/operate/${PLAN_ID}?view=settings`);
  const policy = page.getByRole('region', { name: 'Score approval' });
  await expect(policy.getByText(reviewPolicy, { exact: true })).toBeVisible();
  await expect(policy.getByRole('combobox')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(unexpected).toEqual([]);
});
