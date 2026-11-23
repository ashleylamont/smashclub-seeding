import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const [width, theme, structure] of [
  [390, 'dark', 'single_elimination'],
  [390, 'light', 'double_elimination'],
  [1440, 'dark', 'double_elimination'],
  [1440, 'light', 'single_elimination'],
] as const) {
  test(`the ${structure} desk describes the actual draw at ${width}px in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    const { overview, mutationResponses, unexpected } = await mockEvent(page, {
      role: 'player',
      idle: true,
      bracket: true,
    });
    Object.assign(overview.plan, {
      status: 'pools_ready',
      structure,
      liveOwned: true,
      softLockedAt: null,
      drawPaused: false,
    });
    Object.assign(overview, { poolDrawPauseBlocker: null });
    const calls: { procedure: string; input: unknown }[] = [];
    mutationResponses.set('eventOps.softLockPools', (input) => {
      calls.push({ procedure: 'softLockPools', input });
      overview.plan.softLockedAt = '2026-10-22T18:30:00Z';
      overview.plan.drawPaused = false;
      return { softLockedAt: overview.plan.softLockedAt };
    });
    mutationResponses.set('eventOps.unlockPools', (input) => {
      calls.push({ procedure: 'unlockPools', input });
      overview.plan.drawPaused = true;
      return { unlocked: true };
    });

    await page.goto(`/operate/${PLAN_ID}?view=draw`);
    const draw = page.getByRole('tabpanel', { name: 'Standings / draw' }).locator('.ops-setup');
    const dialog = page.getByRole('alertdialog', { name: 'Confirm action' });
    const softLock = draw.getByRole('button', { name: 'Soft-lock knockout draw', exact: true });
    await expect(draw.getByRole('heading', { name: 'Knockout draw: Draft' })).toBeVisible();
    await expect(draw).toContainText('Soft-lock the bracket before starting play.');
    await softLock.press('Enter');
    await expect(dialog).toHaveAccessibleDescription(
      'Soft-lock this knockout draw? The current bracket and pairings will be prepared for play.',
    );
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(softLock).toBeFocused();
    expect(calls).toEqual([]);
    await softLock.press('Enter');
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
    await expect(draw.getByRole('heading', { name: 'Knockout draw: Soft-locked' })).toBeVisible();
    await expect(draw.getByText(/affected pools|never change/i)).toHaveCount(0);
    await draw.screenshot({ path: testInfo.outputPath('locked-knockout.png') });

    await draw.getByRole('button', { name: 'Pause unplayed draw', exact: true }).press('Enter');
    await expect(dialog).toHaveAccessibleDescription(
      'Pause this unplayed knockout draw? The bracket and match history stay recorded.',
    );
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
    await expect(draw.getByRole('heading', { name: 'Knockout draw: Paused' })).toBeVisible();
    await draw.getByRole('button', { name: 'Resume knockout draw', exact: true }).press('Enter');
    await expect(draw.getByRole('heading', { name: 'Knockout draw: Soft-locked' })).toBeVisible();
    expect(calls).toEqual(
      ['softLockPools', 'unlockPools', 'softLockPools'].map((procedure) => ({
        procedure,
        input: { planId: PLAN_ID, confirm: true },
      })),
    );

    Object.assign(overview.plan, { status: 'complete' });
    Object.assign(overview, {
      publication: {
        resultId: '5a6b70c9-6709-4c3c-8660-696ed222f068',
        revision: 1,
        status: 'published',
        tournamentIds: [],
      },
    });
    await page.reload();
    await expect(draw.getByRole('heading', { name: 'Knockout draw: Finalized' })).toBeVisible();
    await expect(draw.getByRole('button')).toHaveCount(0);
    await expect(draw.getByText(/attendance|late arrivals|affected pools/i)).toHaveCount(0);
    await expect(page.getByText('Result revision 1 published.', { exact: false })).toBeVisible();
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
    await draw.screenshot({ path: testInfo.outputPath('finalized-knockout.png') });

    Object.assign(overview.plan, { status: 'cancelled' });
    await page.reload();
    await expect(draw.getByRole('heading', { name: 'Knockout draw: Cancelled' })).toBeVisible();
    await expect(draw.getByRole('button')).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });
}
