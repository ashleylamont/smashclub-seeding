import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { AdminPlayer, MyClaim } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';

const player: AdminPlayer = {
  id: '3048c081-1afa-4eab-a0a0-622853293ae2',
  canonicalName: 'Synthetic registry player',
  displayName: 'Player with a long tournament alias',
  status: 'active',
  legacyId: null,
  companyCode: null,
  aliases: [],
  characters: ['fox', 'mario'],
};
const claim: MyClaim = {
  id: '22771e93-2d7c-4a55-9875-60d12eaa3681',
  playerId: player.id,
  playerName: player.displayName!,
  status: 'approved',
  note: null,
  displayName: player.displayName,
  companyCode: player.companyCode,
  defaultAlias: player.canonicalName,
  characters: player.characters,
  createdAt: '2026-10-04T00:00:00Z',
  resolvedAt: null,
};
const admin = {
  id: 'example-user',
  name: 'Synthetic administrator with a long display name',
  email: 'admin@example.test',
  role: 'admin',
  emailVerified: true,
};
const themes = [
  { label: 'system light', system: 'light', selected: null },
  { label: 'explicit light', system: 'dark', selected: 'light' },
  { label: 'system dark', system: 'dark', selected: null },
  { label: 'explicit dark', system: 'light', selected: 'dark' },
] as const;

async function accessible(page: Page, scope: string) {
  await ready(page);
  const result = await new AxeBuilder({ page })
    .include(scope)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const { label, system, selected } of themes)
  for (const width of [390, 1440])
    test(`account and admin accent chips are readable at ${width}px in ${label}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: system });
      if (selected)
        await page.addInitScript(
          (theme) => localStorage.setItem('smashclub:theme', theme),
          selected,
        );
      const fixture = await mockEvent(page, { role: 'admin' });
      await page.route('**/api/auth/list-accounts', (route) => route.fulfill({ json: [] }));
      fixture.responses['me.claims'] = [claim];
      fixture.responses['admin.admins'] = [admin];
      fixture.responses['admin.findAccounts'] = [admin];
      fixture.responses['admin.players'] = [player];

      await page.goto('/me');
      const accountBadge = page.locator('.me-account .chip-accent');
      const mainChip = page.locator('.selected-main-chip');
      await expect(accountBadge).toHaveText('admin');
      await expect(mainChip).toHaveText('main');
      await accessible(page, '#main');
      const promote = page.getByRole('button', { name: 'make main', exact: true });
      await promote.press('Enter');
      await expect(page.locator('.selected-character.is-main')).toContainText('Mario');
      await expect(mainChip).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath('account-picker.png') });

      await page.goto('/admin/accounts');
      await page.getByLabel('Search signed-in accounts by name or email').fill('Synthetic');
      await expect(page.locator('.admin-accounts-page .chip-accent')).toHaveText('Admin');
      await accessible(page, '#main');
      await page.screenshot({ path: testInfo.outputPath('admin-search.png') });

      await page.goto('/admin/players');
      await page.getByRole('button', { name: 'Edit', exact: true }).press('Enter');
      const editor = page.getByRole('dialog', { name: `Edit ${player.canonicalName}` });
      await expect(editor.locator('.selected-main-chip')).toHaveText('main');
      await accessible(page, '[role="dialog"]');
      await page.screenshot({ path: testInfo.outputPath('admin-editor.png') });
      expect(fixture.unexpected).toEqual([]);
    });
