import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, ready } from './fixtures';

test.beforeEach(async ({ page }) => {
  await mockEvent(page);
});

test('dialog contains focus, validates, closes with Escape and restores the trigger', async ({
  page,
}) => {
  await page.goto('/ui');
  const trigger = page.getByRole('button', { name: 'Edit player', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Edit player' });
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole('textbox', { name: 'Registry name' });
  await field.fill('');
  await dialog.getByRole('button', { name: 'Save player' }).click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription('Enter a player name.');
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await field.fill('Jordan');
  await dialog.getByRole('button', { name: 'Save player' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Jordan saved.' })).toBeVisible();
});

test('tabs support arrow keys and manual activation, help works by keyboard', async ({ page }) => {
  await page.goto('/ui');
  const controls = page.getByRole('tab', { name: 'Controls' });
  await controls.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Reporting' })).toBeFocused();
  await expect(controls).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  const report = page.getByRole('tabpanel', { name: 'Reporting' });
  await expect(report).toBeVisible();
  await report.getByLabel('Jordan', { exact: true }).fill('2');
  await report.getByRole('button', { name: 'Confirm result' }).click();
  await expect(report.getByRole('status')).toHaveText('Result confirmed: 0–2.');
  await controls.click();
  const help = page.getByRole('button', { name: 'Explain: Ranked rating' });
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Ranked rating' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeFocused();
});

test('registry modal restores focus for an existing conditional caller', async ({ page }) => {
  await mockEvent(page, { role: 'admin' });
  await page.goto('/admin/players');
  const trigger = page.getByRole('button', { name: 'New player', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'New player' });
  await expect(dialog.getByRole('textbox', { name: 'Registry name' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Create player' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const theme of ['dark', 'light'] as const) {
  test(`gallery ${theme}: labelled controls, visible states and contrast`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/ui');
    await ready(page);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(result.violations).toEqual([]);
    await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await expect(page).toHaveScreenshot(`gallery-${theme}.png`, { fullPage: true });
  });
}
