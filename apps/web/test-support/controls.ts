import { expect, type Locator } from '@playwright/test';

/** Clear with the keyboard so controlled fields must preserve the empty edit. */
export async function clearInput(control: Locator) {
  await control.press('ControlOrMeta+A');
  await control.press('Backspace');
  await expect(control).toHaveValue('');
}

/** Exercise the visible Radix menu, including empty options and disabled states. */
export async function chooseOption(control: Locator, choice: string | { label: string }) {
  await control.click();
  const menu = control.page().getByRole('listbox');
  const option =
    typeof choice === 'string'
      ? menu.locator(`[role="option"][data-value=${JSON.stringify(choice)}]`)
      : menu.getByRole('option', { name: choice.label, exact: true });
  await option.click();
  await expect(menu).toBeHidden();
}

export async function optionValues(control: Locator) {
  await control.click();
  const menu = control.page().getByRole('listbox');
  const values = await menu
    .locator('[role="option"]:not([data-disabled])')
    .evaluateAll((options) =>
      options.map((option) => option.getAttribute('data-value') ?? '').filter(Boolean),
    );
  await control.press('Escape');
  return values;
}
