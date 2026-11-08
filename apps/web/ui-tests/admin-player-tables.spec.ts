import { expect, test, type Locator, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import type { AdminClaim, AdminPlayer } from '../src/lib/apiTypes';
import { mockEvent, ready } from './fixtures';

const note = 'Synthetic evidence for the admin reviewer.';
const claim: AdminClaim = {
  id: '054c6917-4a03-48a7-ad80-44884a6107bf',
  playerId: 'ea5b692f-2cd3-49c4-a88d-a7d17fdb3f37',
  canonicalName: 'Synthetic registry player',
  displayName: 'Returning player with a long tournament alias',
  playerName: 'Returning player with a long tournament alias',
  userName: 'Claiming account with a long display name',
  userEmail: 'claimant@example.test',
  note,
  status: 'pending',
  createdAt: '2026-10-03T00:00:00Z',
};
const player: AdminPlayer = {
  id: claim.playerId,
  canonicalName: claim.canonicalName,
  displayName: claim.displayName,
  status: 'active',
  legacyId: null,
  companyCode: null,
  aliases: ['long local tournament alias'],
  characters: [],
};

async function scrollByKeyboard(page: Page, region: Locator) {
  const start = await region.evaluate((element) => element.scrollLeft);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(start);
  await expect(region).toBeFocused();
}

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`admin can reach claims and registry tables by keyboard in ${theme} at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const fixture = await mockEvent(page, { role: 'admin' });
      fixture.responses['admin.claims'] = [claim];
      fixture.responses['admin.players'] = [player];
      const resolutions: unknown[] = [];
      await page.route('**/api/trpc/admin.resolveClaim*', async (route) => {
        const batched = new URL(route.request().url()).searchParams.has('batch');
        const body = route.request().postDataJSON();
        resolutions.push(batched ? body[0] : body);
        fixture.responses['admin.claims'] = [{ ...claim, status: 'approved' }];
        const result = { result: { data: { ok: true } } };
        await route.fulfill({ json: batched ? [result] : result });
      });

      await page.goto('/admin/players');
      await expect(page.getByRole('link', { name: claim.playerName })).toBeVisible();
      await ready(page);
      const region = page.getByRole('region', { name: 'Player claims', exact: true });
      const table = region.getByRole('table');
      await expect(table.getByRole('columnheader')).toHaveText([
        'User',
        'Player',
        'Note',
        'When',
        'Status',
        'Actions',
      ]);
      await expect(table.getByRole('cell', { name: note })).toBeVisible();
      await page.getByRole('link', { name: 'Admins', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(region).toBeFocused();
      expect(await region.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withRules(['scrollable-region-focusable']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('claims-focused.png'), fullPage: true });

      if (width === 390) await scrollByKeyboard(page, region);
      expect(resolutions).toEqual([]);
      await page.keyboard.press('Tab');
      await expect(table.getByRole('link', { name: claim.playerName })).toBeFocused();
      await page.keyboard.press('Tab');
      const approve = table.getByRole('button', { name: 'Approve', exact: true });
      await expect(approve).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(table.getByRole('button', { name: 'Reject', exact: true })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(approve).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath('claim-action-focused.png'),
        fullPage: true,
      });
      await page.keyboard.press('Enter');
      await expect(table.getByRole('button', { name: 'Revoke', exact: true })).toBeVisible();
      expect(resolutions).toEqual([{ claimId: claim.id, action: 'approved' }]);

      const registry = page.getByRole('region', { name: 'Player registry', exact: true });
      const filter = page.getByPlaceholder('Filter by name or alias…');
      await filter.focus();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'New player' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(registry).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(registry.getByRole('checkbox', { name: /select .* for merge/i })).toBeFocused();
      await expect(registry.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();

      await filter.fill('No matching registry alias');
      await expect(registry.getByRole('row')).toHaveCount(1);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      await expect(registry).toBeFocused();
      if (width === 390) await scrollByKeyboard(page, registry);
      expect(
        (await new AxeBuilder({ page }).withRules(['scrollable-region-focusable']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('registry-filtered.png'), fullPage: true });
      expect(fixture.unexpected).toEqual([]);
    });
