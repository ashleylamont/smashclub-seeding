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
      const href = new URLSearchParams({ station: stage.id, presentation: 'event', controls: '0' });
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
