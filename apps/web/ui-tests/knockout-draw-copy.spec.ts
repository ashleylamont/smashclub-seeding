import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const [width, theme, structure] of [
  [390, 'dark', 'single_elimination'],
  [390, 'light', 'double_elimination'],
  [1440, 'dark', 'double_elimination'],
  [1440, 'light', 'single_elimination'],
] as const) {
  test(`an assigned organiser waits until knockout preparation finishes at ${width}px in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
    const { overview, unexpected } = await mockEvent(page, { role: 'player', idle: true });
    Object.assign(overview.plan, {
      structure,
      liveOwned: false,
      softLockedAt: null,
      drawPaused: false,
    });
    Object.assign(overview, { matches: [], nativeBrackets: [], poolDrawPauseBlocker: null });
    const matchDesk = page.locator('#match-desk');
    const waitForPreparation = 'Waiting for an admin to prepare the bracket.';
    for (const status of ['draft', 'roster_frozen'] as const) {
      Object.assign(overview.plan, { status });
      await page.goto(`/operate/${PLAN_ID}?view=run`);
      await expect(matchDesk).toContainText(waitForPreparation);
      await expect(matchDesk.getByRole('button', { name: 'Standings / draw' })).toHaveCount(0);
      await expect(
        matchDesk.getByRole('button', { name: 'Prepare / refresh matches' }),
      ).toBeDisabled();
      await expect(page.getByRole('link', { name: 'Planner', exact: true })).toHaveCount(0);
      await matchDesk.screenshot({ path: testInfo.outputPath(`run-${status}.png`) });

      await page.getByRole('tab', { name: 'Standings / draw', exact: true }).press('Enter');
      const draw = page.getByRole('tabpanel', { name: 'Standings / draw' });
      await expect(draw.getByText(waitForPreparation, { exact: true })).toBeVisible();
      await expect(draw.getByRole('button', { name: 'Soft-lock knockout draw' })).toHaveCount(0);
      await draw
        .locator('.ops-setup')
        .screenshot({ path: testInfo.outputPath(`draw-${status}.png`) });
    }
    for (const status of ['complete', 'cancelled'] as const) {
      Object.assign(overview.plan, { status });
      await page.goto(`/operate/${PLAN_ID}?view=run`);
      await expect(matchDesk.getByRole('heading', { name: 'Match desk' })).toBeVisible();
      await expect(matchDesk.getByText(waitForPreparation)).toHaveCount(0);
      await expect(matchDesk.getByRole('button', { name: 'Standings / draw' })).toHaveCount(0);
      await expect(
        matchDesk.getByRole('button', { name: 'Prepare / refresh matches' }),
      ).toBeDisabled();
    }
    expect(unexpected).toEqual([]);
  });

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
    const { matches, nativeBrackets } = overview;
    Object.assign(overview, { poolDrawPauseBlocker: null, matches: [], nativeBrackets: [] });
    const calls: { procedure: string; input: unknown }[] = [];
    mutationResponses.set('eventOps.softLockPools', (input) => {
      calls.push({ procedure: 'softLockPools', input });
      Object.assign(overview, { matches, nativeBrackets });
      overview.plan.softLockedAt = '2026-10-22T18:30:00Z';
      overview.plan.drawPaused = false;
      return { softLockedAt: overview.plan.softLockedAt };
    });
    mutationResponses.set('eventOps.unlockPools', (input) => {
      calls.push({ procedure: 'unlockPools', input });
      overview.plan.drawPaused = true;
      return { unlocked: true };
    });

    await page.goto(`/operate/${PLAN_ID}`);
    await expect(page.locator('.ops-heading')).toContainText('Draw ready to lock.');
    const matchDesk = page.locator('#match-desk');
    await expect(matchDesk).toContainText('Soft-lock the bracket in');
    await expect(page.getByText('Generate pools in the planner', { exact: false })).toHaveCount(0);
    await matchDesk.getByRole('button', { name: 'Standings / draw', exact: true }).press('Enter');
    await expect(page.getByRole('region', { name: 'Tournament draw' })).toContainText(
      'Soft-lock the draw above to view the bracket and print its match order.',
    );
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
    const finalize = page.getByRole('button', { name: 'Finalize native results', exact: true });
    await expect(finalize).toBeDisabled();
    await expect(finalize).toHaveAccessibleDescription(
      'Resume the knockout draw before publishing results.',
    );
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
    Object.assign(overview, { publication: null });
    await page.reload();
    await expect(draw.getByRole('heading', { name: 'Knockout draw: Cancelled' })).toBeVisible();
    await expect(draw.getByRole('button')).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });
}
