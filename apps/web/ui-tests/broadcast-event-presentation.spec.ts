import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { BroadcastPresentationMode } from '@smashclub/shared';
import { chooseOption } from '../test-support/controls';
import { mockEvent, PLAN_ID, ready } from './fixtures';

for (const theme of ['dark', 'light'] as const)
  for (const width of [390, 1440])
    test(`Event presentation is accessible during a paused draw at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.addInitScript((value) => localStorage.setItem('smashclub:theme', value), theme);
      await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
      const { overview, mutationResponses, unexpected } = await mockEvent(page, { role: 'admin' });
      const current: { mode: BroadcastPresentationMode; revision: number } = {
        mode: 'auto',
        revision: 0,
      };
      Object.assign(overview, { broadcastPresentation: current });
      overview.plan.drawPaused = true;
      const stage = overview.stations[0]!;
      const match = overview.matches.find((item) => item.id === stage.currentMatchId)!;
      match.player1Name = 'Alexandria with a long tournament alias from Western Sydney';
      const writes: unknown[] = [];
      mutationResponses.set('eventOps.setBroadcastPresentation', (input) => {
        writes.push(input);
        Object.assign(current, { mode: 'progress', revision: 1 });
        return current;
      });
      await page.goto(`/operate/${PLAN_ID}?view=broadcast&station=${stage.id}`);
      const panel = page.getByRole('tabpanel', { name: 'Broadcast', exact: true });
      await panel.getByRole('button', { name: 'Intermission browser sources' }).press('Enter');
      const source = panel.getByRole('link', { name: 'Follow event overlay ↗' });
      const href = new URLSearchParams({
        station: stage.id,
        presentation: 'event',
        controls: 'preview',
      });
      await expect(source).toHaveAttribute('href', `/overlay/${PLAN_ID}?${href}`);
      await expect(panel.getByText(match.player1Name, { exact: false }).first()).toBeVisible();
      const control = panel.getByRole('region', { name: 'Event-following presentation' });
      const menu = control.getByRole('combobox', { name: 'Event presentation' });
      const apply = control.getByRole('button', { name: 'Apply presentation' });
      await expect(menu).toContainText('Automatic');
      await expect(apply).toBeDisabled();
      await menu.press('Enter');
      await page.getByRole('option', { name: 'Progress', exact: true }).press('Enter');
      await expect(menu).toBeFocused();
      await expect(control).toContainText('Current presentation · Automatic');
      expect(writes).toEqual([]);
      await page.keyboard.press('Tab');
      await expect(apply).toBeFocused();
      await apply.press('Enter');
      await expect(control.getByRole('status')).toHaveText('Event presentation set to Progress.');
      expect(writes).toEqual([{ planId: PLAN_ID, expectedRevision: 0, mode: 'progress' }]);
      await expect(menu).toContainText('Progress');
      await expect(menu).toBeFocused();
      await expect(apply).toBeDisabled();
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await control.scrollIntoViewIfNeeded();
      const path = testInfo.outputPath('event-following-desk.png');
      await page.screenshot({ path, animations: 'disabled' });
      await testInfo.attach('event-following-desk', { path, contentType: 'image/png' });

      if (theme === 'dark' && width === 1440) {
        await chooseOption(menu, 'gameplay');
        Object.assign(current, { mode: 'auto', revision: 2 });
        await page.bringToFront();
        await expect
          .poll(async () => {
            await page.clock.fastForward(3000);
            return menu.getAttribute('data-value');
          })
          .toBe('auto');
        await expect(control).toContainText(
          'The current presentation changed. Choose a mode again.',
        );
        await expect(apply).toBeDisabled();
        expect(writes).toHaveLength(1);
      }
      expect(unexpected).toEqual([]);
    });

test('presentation save keeps keyboard focus predictable through a retry and navigation', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { overview, unexpected } = await mockEvent(page, { role: 'admin' });
  const current = { mode: 'auto', revision: 0 };
  Object.assign(overview, { broadcastPresentation: current });
  const release: (() => void)[] = [];
  await page.route('**/api/trpc/eventOps.setBroadcastPresentation**', async (route) => {
    const attempt = release.length;
    await new Promise<void>((resolve) => release.push(resolve));
    if (attempt === 1) Object.assign(current, { mode: 'progress', revision: 1 });
    const response =
      attempt === 0
        ? {
            error: {
              message: 'Could not save presentation. Try again.',
              code: -32603,
              data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
            },
          }
        : { result: { data: current } };
    const batched = new URL(route.request().url()).searchParams.has('batch');
    await route.fulfill({ json: batched ? [response] : response });
  });
  await page.goto(`/operate/${PLAN_ID}?view=broadcast&station=${overview.stations[0]!.id}`);
  const panel = page.getByRole('tabpanel', { name: 'Broadcast', exact: true });
  const control = panel.getByRole('region', { name: 'Event-following presentation' });
  const menu = control.getByRole('combobox', { name: 'Event presentation' });
  const apply = control.getByRole('button', { name: 'Apply presentation' });
  const pending = control.getByRole('button', { name: 'Applying…' });
  await menu.press('Enter');
  await page.getByRole('option', { name: 'Progress', exact: true }).press('Enter');
  await expect(menu).toBeFocused();
  await expect(apply).toBeEnabled();
  await page.keyboard.press('Tab');
  await expect(apply).toBeFocused();
  await page.keyboard.press('Enter');

  try {
    await expect.poll(() => release.length).toBe(1);
    await expect(pending).toBeDisabled();
    await expect(control.locator('form')).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('presentation-applying-390.png') });
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(release).toHaveLength(1);
    release[0]!();
    await expect(control.getByRole('alert')).toHaveText('Could not save presentation. Try again.');
    await expect(apply).toBeFocused();
    await expect(menu).toContainText('Progress');

    await page.keyboard.press('Enter');
    await expect.poll(() => release.length).toBe(2);
    await expect(pending).toBeDisabled();
    await page.keyboard.press('Tab');
    const announcement = panel.getByRole('textbox', { name: 'Message', exact: true });
    await expect(announcement).toBeFocused();
    release[1]!();
    await expect(control.getByRole('status')).toHaveText('Event presentation set to Progress.');
    await expect(announcement).toBeFocused();
    await expect(apply).toBeDisabled();
    expect(release).toHaveLength(2);
    expect(unexpected).toEqual([]);
  } finally {
    for (const respond of release) respond();
  }
});
