import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { mockEvent, ready } from './fixtures';
import { chooseOption } from '../test-support/controls';

test('select handles keyboard, disabled and empty choices with native form values', async ({
  page,
}) => {
  await page.goto('/ui');
  const select = page.getByRole('combobox', { name: 'Featured station' });
  await select.focus();
  await select.press('Enter');
  await expect(page.getByRole('option', { name: 'Unavailable station' })).toBeDisabled();
  await page.keyboard.press('Home');
  await expect(page.getByRole('option', { name: 'Automatic', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Main stage', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(select).toHaveAttribute('data-value', 'stage');
  await expect(select).toBeFocused();
  await page.getByRole('checkbox', { name: 'Publish event board' }).check();
  await page.getByRole('button', { name: 'Read form values' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Station: stage. Published: Yes.' }),
  ).toBeVisible();
  await chooseOption(select, '');
  await expect(select).toHaveText('Automatic▾');
  await page.getByRole('button', { name: 'Read form values' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Station: Automatic. Published: Yes.' }),
  ).toBeVisible();
});

test('disclosures preserve drafts and switch works from its label and keyboard', async ({
  page,
}) => {
  await page.goto('/ui');
  const trigger = page.getByRole('button', { name: 'Advanced settings' });
  await trigger.focus();
  await trigger.press('Space');
  const field = page.getByRole('textbox', { name: 'Broadcast caption' });
  await field.fill('Finals');
  await trigger.click();
  await expect(field).toBeHidden();
  await trigger.click();
  await expect(field).toHaveValue('Finals');
  const control = page.getByRole('switch', { name: 'Hide inactive players' });
  await expect(control).toBeChecked();
  await page.getByText('Hide inactive players', { exact: true }).click();
  await expect(control).not.toBeChecked();
  await control.focus();
  await control.press('Space');
  await expect(control).toBeChecked();
});

test('confirmation focuses cancel, contains focus and restores the action on Escape', async ({
  page,
}) => {
  await page.goto('/ui');
  const trigger = page.getByRole('button', { name: 'Revoke example access' });
  await trigger.click();
  const dialog = page.getByRole('alertdialog', { name: 'Confirm action' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(dialog).toHaveAccessibleDescription(
    'Remove guest access? Existing guest passes will stop working.',
  );
  for (let index = 0; index < 5; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Access kept' })).toBeVisible();
  await trigger.click();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Access removed' })).toBeVisible();
});

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
